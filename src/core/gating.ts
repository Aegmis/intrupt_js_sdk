/**
 * Shared tool-gating logic used by every framework adapter. This is the JS
 * equivalent of the duplicated body of each `approval_required` wrapper in the
 * Python adapters, factored into one place.
 */
import { randomUUID } from "node:crypto";
import { ApprovalMiddleware } from "../adapters/approvalMiddleware";
import { filterKwargs } from "../utils/filterKwargs";
import { currentContext } from "./context";
import * as gate from "./gate";
import { startRecord } from "./observability";

export interface ApprovalOptions {
  /** Short action id (defaults to the tool name). */
  action?: string;
  /** Human-readable reason shown to the approver. */
  message?: string;
  /** Dispatch channel. Default `"slack"`. */
  channel?: string;
  /** Tool argument names to forward to the approver; omit to forward all (except `config`). */
  args?: string[];
}

export interface ToolMeta {
  name: string;
  description?: string;
}

export interface GateResult {
  approved: boolean;
  approvalId: string;
  threadId: string;
}

/**
 * Side-channel for tool-level API errors, keyed by threadId. A gated tool
 * records the error here and rethrows; the runner checks this map after the run
 * settles and surfaces `{ status: "error" }` instead of the LLM's natural
 * language summary of a failed tool call. Mirrors `_tool_api_errors` in Python.
 */
export const toolApiErrors = new Map<string, unknown>();

/**
 * Request approval for a tool call and await the decision. Returns
 * `{ approved, approvalId, threadId }`. On approval-API failure the error is
 * recorded in {@link toolApiErrors} (keyed by threadId) and rethrown.
 */
/**
 * Whether approvals are enabled, controlled by the `AEGMIS_APPROVAL` env var.
 * Enabled by default: gated tools send approval requests to the backend for a
 * real human decision. Set `AEGMIS_APPROVAL=false` (or `0`/`no`/`off`) to
 * auto-approve in-process without ever contacting the backend approval API.
 */
export function approvalsEnabled(): boolean {
  const v = (process.env.AEGMIS_APPROVAL ?? "true").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

export async function gateCall(
  tool: ToolMeta,
  kwargs: Record<string, unknown>,
  opts: ApprovalOptions,
  adapter: string,
): Promise<GateResult> {
  const ctx = currentContext();
  const threadId = ctx?.threadId || randomUUID();

  // Master switch: when approvals are disabled (AEGMIS_APPROVAL=false),
  // auto-approve without contacting the backend.
  if (!approvalsEnabled()) {
    return { approved: true, approvalId: "", threadId };
  }

  const action = opts.action || tool.name;
  const payload: Record<string, unknown> = {
    action,
    message: opts.message || `Approval required for ${tool.name}`,
    channel: opts.channel || "slack",
    tool: {
      name: tool.name,
      description: tool.description ?? "",
      kwargs: filterKwargs(kwargs, opts.args),
    },
    agent_callback_url: ctx?.callbackUrl ?? "",
    agent_callback_secret: ctx?.callbackSecret ?? "",
    adapter,
  };

  // Observability: no-op unless AEGMIS_OTLP_ENDPOINT (or initObservability) is
  // configured; fail-open — never blocks or breaks the gate.
  const rec = startRecord(tool.name, adapter, action, threadId);

  const client = ctx?.onApprovalClient ?? ApprovalMiddleware.getClient();
  let approvalId: string;
  let future: Promise<boolean>;
  try {
    ({ approvalId, future } = await gate.requestApproval(client, threadId, payload));
  } catch (err) {
    rec.finish("error");
    toolApiErrors.set(threadId, err);
    throw err;
  }
  rec.requested(approvalId, payload);

  const approved = await future;
  rec.finish(approved ? "approved" : "rejected");
  return { approved, approvalId, threadId };
}
