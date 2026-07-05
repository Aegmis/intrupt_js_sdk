/**
 * Pending-approval registry. Port of `core/gate.py`.
 *
 * NOTE — deliberately simpler than the Python version. `gate.py` needs
 * `_pending_loops` + `call_soon_threadsafe` because adapters like CrewAI run
 * tools inside a worker-thread event loop, so the future is created on a
 * different loop than the one that resolves it. JavaScript has a single event
 * loop — a pending Promise resolved from anywhere just works. Do NOT port the
 * cross-loop machinery back; there are no loops to hop between here.
 */
import type { ApprovalCreator } from "./client";

interface PendingEntry {
  future: Promise<boolean>;
  resolve: (approved: boolean) => void;
  done: boolean;
}

const pending = new Map<string, PendingEntry>();
const sessionToApproval = new Map<string, string>();
const pendingCallbacks = new Map<string, Array<() => void>>();

export interface RequestApprovalResult {
  approvalId: string;
  /** Resolves to `true` when approved, `false` when rejected. */
  future: Promise<boolean>;
}

/**
 * POST to the approval API, create a pending Promise, return `{ approvalId, future }`.
 *
 * If the API auto-approves (policy engine or enforce_policies=false), the
 * returned future is already resolved so the tool continues immediately. Any
 * registered pending callback for this session is fired when the approval
 * transitions to 'pending', so callers using an event/wait wake up.
 */
export async function requestApproval(
  client: ApprovalCreator,
  sessionId: string,
  payload: Record<string, unknown>,
): Promise<RequestApprovalResult> {
  const result = await client.createApproval({ thread_id: sessionId, ...payload });
  const status = result.status ?? "";
  if (status !== "pending") {
    return {
      approvalId: result.approval_id ?? "",
      future: Promise.resolve(status === "approved" || status === "audited"),
    };
  }

  const approvalId = result.approval_id ?? "";
  let resolveFn!: (approved: boolean) => void;
  const entry: PendingEntry = {
    future: new Promise<boolean>((res) => {
      resolveFn = res;
    }),
    resolve: (approved: boolean) => {
      resolveFn(approved);
    },
    done: false,
  };
  pending.set(approvalId, entry);
  sessionToApproval.set(sessionId, approvalId);

  for (const cb of pendingCallbacks.get(sessionId) ?? []) {
    try {
      cb();
    } catch (err) {
      // A misbehaving callback must not prevent the approval from being tracked.
      console.error(`gate: pending callback raised for session ${sessionId}:`, err);
    }
  }

  return { approvalId, future: entry.future };
}

/** Register a zero-argument callback fired when `sessionId` goes pending. */
export function registerPendingCallback(sessionId: string, callback: () => void): void {
  const list = pendingCallbacks.get(sessionId) ?? [];
  list.push(callback);
  pendingCallbacks.set(sessionId, list);
}

/** Remove all pending callbacks for `sessionId`. */
export function unregisterPendingCallbacks(sessionId: string): void {
  pendingCallbacks.delete(sessionId);
}

/**
 * Unblock the waiting tool. Returns `true` if the gate was resolved, `false`
 * if it was unknown or already resolved.
 */
export function resolve(approvalId: string, approved: boolean): boolean {
  const entry = pending.get(approvalId);
  pending.delete(approvalId);
  for (const [session, id] of sessionToApproval) {
    if (id === approvalId) sessionToApproval.delete(session);
  }
  if (!entry || entry.done) return false;
  entry.done = true;
  entry.resolve(approved);
  return true;
}

/** Return the approval_id currently blocking `sessionId`, or undefined. */
export function getPending(sessionId: string): string | undefined {
  return sessionToApproval.get(sessionId);
}

export function isPending(approvalId: string): boolean {
  return pending.has(approvalId);
}
