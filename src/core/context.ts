/**
 * Per-run context propagation. JavaScript equivalent of Python's `contextvars`.
 *
 * The Python adapters store `_current_thread_id` (and the inline approval
 * client) in ContextVars so concurrent runs don't share a thread_id. In Node
 * the equivalent is {@link AsyncLocalStorage}, which propagates across `await`
 * boundaries and framework call stacks. A runner opens a store with
 * `approvalContext.run(store, () => invokeAgent())`; the gated tool, called
 * somewhere inside that agent, reads the store to learn its thread_id, callback
 * URL/secret, and (optionally) an inline approval client.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ApprovalCreator } from "./client";

export interface ApprovalContext {
  threadId: string;
  callbackUrl?: string;
  callbackSecret?: string;
  /** Inline approval creator (e.g. console/policy approval) used instead of the HTTP client. */
  onApprovalClient?: ApprovalCreator;
}

export const approvalContext = new AsyncLocalStorage<ApprovalContext>();

export function currentContext(): ApprovalContext | undefined {
  return approvalContext.getStore();
}
