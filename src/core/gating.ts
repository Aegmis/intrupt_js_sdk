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
export async function gateCall(
  tool: ToolMeta,
  kwargs: Record<string, unknown>,
  opts: ApprovalOptions,
  adapter: string,
): Promise<GateResult> {
  const ctx = currentContext();
  const threadId = ctx?.threadId || randomUUID();
  const payload = {
    action: opts.action || tool.name,
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

  const client = ctx?.onApprovalClient ?? ApprovalMiddleware.getClient();
  let approvalId: string;
  let future: Promise<boolean>;
  try {
    ({ approvalId, future } = await gate.requestApproval(client, threadId, payload));
  } catch (err) {
    toolApiErrors.set(threadId, err);
    throw err;
  }

  const approved = await future;
  return { approved, approvalId, threadId };
}
