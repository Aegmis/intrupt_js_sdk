/**
 * Generic approval-aware runner. JS equivalent of Python's `ApprovalAgentRunner`
 * (openai_agents.py) / `ApprovalGraph` (langgraph.py) run/resume machinery,
 * factored so any framework can reuse it by supplying an `invoke` thunk.
 *
 * Two-step flow:
 *   1. `run()` launches `invoke(input, threadId)` as a background task and waits
 *      up to `timeout` seconds. If a gated tool fires before the timeout the
 *      call returns `{ status: "pending_approval", approval_id, ... }`.
 *   2. `resume()` calls `gate.resolve()` to unblock the gate and returns
 *      immediately; the background task continues.
 */
import { ApprovalClient, errorStatusCode, userFacingError, type ApprovalCreator, type CreateApprovalResult } from "./client";
import { approvalContext, type ApprovalContext } from "./context";
import * as gate from "./gate";
import { toolApiErrors } from "./gating";

const delay = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

export type ResultDict = Record<string, unknown> & { status: string };

/** Async callback used instead of the HTTP approval API (console/policy/etc.). */
export type OnApprovalAsync = (
  threadId: string,
  payload: Record<string, unknown>,
) => Promise<{ approval_id?: string } & Record<string, unknown>>;

export interface ApprovalRunnerOptions {
  /** Runs the agent/graph for one turn. Must be called inside the approval context. */
  invoke: (input: unknown, threadId: string) => Promise<unknown>;
  callbackUrl?: string;
  callbackSecret?: string;
  onApprovalAsync?: OnApprovalAsync;
  /** Seconds to wait for a gate to fire before returning pending_approval. Default 1.5. */
  timeout?: number;
  /** Shape the raw invoke() result into the terminal result dict. */
  formatResult?: (raw: unknown, threadId: string) => ResultDict;
}

/** Wraps an onApprovalAsync callback so gate.requestApproval can call it. */
class InlineApprovalClient implements ApprovalCreator {
  constructor(private readonly callback: OnApprovalAsync) {}
  async createApproval(
    params: { thread_id: string } & Record<string, unknown>,
  ): Promise<CreateApprovalResult> {
    const { thread_id, ...rest } = params;
    const result = await this.callback(thread_id, rest);
    return { approval_id: result.approval_id ?? randomId(), status: "pending" };
  }
}

function randomId(): string {
  // Local, dependency-free — only used as a fallback approval id.
  return "appr_" + Math.random().toString(36).slice(2, 14);
}

function errorResult(threadId: string, err: unknown): ResultDict {
  return {
    status: "error",
    thread_id: threadId,
    error: userFacingError(err),
    status_code: errorStatusCode(err),
  };
}

export class ApprovalRunner {
  protected readonly invoke: ApprovalRunnerOptions["invoke"];
  protected readonly callbackUrl: string;
  protected readonly callbackSecret: string;
  protected readonly onApprovalAsync?: OnApprovalAsync;
  protected readonly timeout: number;
  protected readonly formatResult: NonNullable<ApprovalRunnerOptions["formatResult"]>;

  protected readonly tasks = new Map<string, Promise<ResultDict>>();
  protected readonly results = new Map<string, ResultDict>();
  private readonly resolved = new Set<string>();

  constructor(options: ApprovalRunnerOptions) {
    this.invoke = options.invoke;
    this.callbackUrl = options.callbackUrl ?? "";
    this.callbackSecret = options.callbackSecret ?? "";
    this.onApprovalAsync = options.onApprovalAsync;
    this.timeout = options.timeout ?? 1.5;
    this.formatResult =
      options.formatResult ??
      ((raw, threadId) => ({ status: "complete", thread_id: threadId, result: raw }));
  }

  /**
   * Start (or restart) a run for `threadId`. Returns within `timeout` seconds
   * with `{ status: "pending_approval", ... }` if a gated tool fires, otherwise
   * the terminal result.
   */
  async run(threadId: string, input: unknown): Promise<ResultDict> {
    const store: ApprovalContext = {
      threadId,
      callbackUrl: this.callbackUrl,
      callbackSecret: this.callbackSecret,
      onApprovalClient: this.onApprovalAsync
        ? new InlineApprovalClient(this.onApprovalAsync)
        : undefined,
    };

    // runTask never rejects — runTask catches everything into a result dict.
    const task = approvalContext.run(store, () => this.runTask(threadId, input));
    this.tasks.set(threadId, task);

    const TIMED_OUT = Symbol("timeout");
    const raced = await Promise.race([task, delay(this.timeout * 1000).then(() => TIMED_OUT)]);
    if (raced !== TIMED_OUT) {
      return raced as ResultDict;
    }

    // Timed out. A tool API error is recorded before the framework makes the
    // extra "handle the error" LLM turn that pushes past the timeout — surface
    // it immediately instead of returning pending_approval.
    if (toolApiErrors.has(threadId)) {
      const err = toolApiErrors.get(threadId);
      toolApiErrors.delete(threadId);
      const r = errorResult(threadId, err);
      this.results.set(threadId, r);
      return r;
    }

    // The approval HTTP call may still be in-flight when the timeout fires.
    // Poll until the gate registers the approval_id or the task finishes.
    const approvalId = await this.awaitGate(threadId);
    const done = this.results.get(threadId);
    if (done) return done;

    return { status: "pending_approval", thread_id: threadId, approval_id: approvalId ?? "" };
  }

  /**
   * Unblock the gate and return immediately. The background task keeps running;
   * poll {@link waitForResult} for the final result. Returning immediately is
   * critical: Slack webhooks time out after ~3 s and retry if we block.
   */
  async resume(threadId: string, approved: boolean, approvalId = ""): Promise<ResultDict> {
    const id = approvalId || gate.getPending(threadId) || "";
    if (id && this.resolved.has(id)) {
      return { status: "already_resolved", thread_id: threadId, approval_id: id };
    }
    if (id) this.resolved.add(id);
    gate.resolve(id, approved);

    const result = this.results.get(threadId);
    if (result) return result;
    if (!this.tasks.has(threadId)) return { status: "not_found", thread_id: threadId };
    return { status: "accepted", thread_id: threadId, approval_id: id };
  }

  /** Poll until the background task stores a terminal result for `threadId`. */
  async waitForResult(threadId: string, timeout = 10): Promise<ResultDict> {
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
      const result = this.results.get(threadId);
      if (result && result.status !== "pending_approval" && result.status !== "accepted") {
        return result;
      }
      if (!this.tasks.has(threadId)) {
        return this.results.get(threadId) ?? { status: "not_found", thread_id: threadId };
      }
      await delay(50);
    }
    return { status: "timeout", thread_id: threadId };
  }

  /** Return true if `threadId` is paused on an approval gate. */
  pending(threadId: string): boolean {
    return gate.getPending(threadId) !== undefined;
  }

  private async awaitGate(threadId: string, extraSeconds = 10): Promise<string | undefined> {
    const deadline = Date.now() + extraSeconds * 1000;
    while (Date.now() < deadline) {
      const approvalId = gate.getPending(threadId);
      if (approvalId !== undefined) return approvalId;
      if (this.results.has(threadId)) return undefined;
      await delay(50);
    }
    return gate.getPending(threadId);
  }

  private async runTask(threadId: string, input: unknown): Promise<ResultDict> {
    let r: ResultDict;
    try {
      const raw = await this.invoke(input, threadId);
      if (toolApiErrors.has(threadId)) {
        const err = toolApiErrors.get(threadId);
        toolApiErrors.delete(threadId);
        r = errorResult(threadId, err);
      } else {
        r = this.formatResult(raw, threadId);
      }
    } catch (err) {
      const apiErr = toolApiErrors.has(threadId) ? toolApiErrors.get(threadId) : err;
      toolApiErrors.delete(threadId);
      r = errorResult(threadId, apiErr);
    } finally {
      this.tasks.delete(threadId);
    }
    this.results.set(threadId, r);
    return r;
  }
}

// Re-exported for convenience so a caller can wire a pre-built client without
// importing from core/client directly.
export { ApprovalClient };
