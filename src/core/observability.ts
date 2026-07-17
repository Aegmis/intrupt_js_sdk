/**
 * Observability emission for governed tool calls. Port of the Python SDK's
 * `core/observability.py` (REST lifecycle; the optional OTLP span channel is
 * not ported — the pending/resolve lifecycle is what drives the dashboard).
 *
 * Design contract — this is the OPPOSITE of the approval gate:
 *   - fail-OPEN: any telemetry error is swallowed; it must never break or
 *     block a tool call (the gate is fail-CLOSED).
 *   - push-only: records are POSTed OUTBOUND to the obs service; the agent
 *     opens no inbound port.
 *   - no-op unless configured: without an endpoint every call costs nothing.
 *
 * Lifecycle:
 *   - the moment approval is requested → POST /v1/pending (full payload, org
 *     tag) so the dashboard shows the call live as WAITING;
 *   - when the decision lands → POST /v1/resolve flips the same row.
 *   - auto-decided calls (below-threshold allow / audit-only / auto-reject)
 *     have no approval_id — they are keyed by the platform's audit_id and
 *     recorded as `audited` with an explanatory reason, so operators see the
 *     args and WHICH condition was under the limit instead of nothing.
 *
 * Configuration (all optional):
 *   AEGMIS_OTLP_ENDPOINT   obs service base URL (e.g. http://localhost:8090)
 *   AEGMIS_ORG_ID          explicit tenant override
 *   AEGMIS_API_KEY         fallback tenant source (sk_org_{org_id}_{hash})
 *   AEGMIS_ENABLE_TRACING  default TRUE; set "false"/"0"/"no"/"off" to disable
 */
import { randomUUID } from "node:crypto";

let endpoint: string | null = null;
let service = "aegmis-agent";
let orgId: string | null = null;
let initialized = false;
let unreachable = false; // one-shot outage warning, re-armed on recovery

/** In-flight fire-and-forget posts, awaited by shutdownObservability(). */
const inflight = new Set<Promise<void>>();

/** SDK self-identifies its tenant from AEGMIS_API_KEY (sk_org_{org_id}_{hash}). */
function orgFromApiKey(): string | null {
  const key = process.env.AEGMIS_API_KEY ?? "";
  if (!key.startsWith("sk_org_")) return null;
  const after = key.slice(7);
  const i = after.lastIndexOf("_");
  if (i <= 0) return null;
  const org = after.slice(0, i);
  return org.startsWith("org_") ? org : null;
}

/** Tracing switch: explicit option wins, else AEGMIS_ENABLE_TRACING (default TRUE). */
function tracingEnabled(flag?: boolean): boolean {
  if (flag !== undefined) return flag;
  const v = process.env.AEGMIS_ENABLE_TRACING;
  if (v === undefined) return true;
  return !["0", "false", "no", "off"].includes(v.trim().toLowerCase());
}

export interface ObservabilityOptions {
  serviceName?: string;
  /** Tenant tag. Omit to self-identify: AEGMIS_ORG_ID → AEGMIS_API_KEY. */
  orgId?: string;
  /** Default true. Pass false — or set AEGMIS_ENABLE_TRACING=false — to disable. */
  enabled?: boolean;
}

/** Enable emission to `endpointUrl` (falsy → disabled). Safe to call once at startup. */
export function initObservability(
  endpointUrl: string | undefined | null,
  opts: ObservabilityOptions = {},
): void {
  initialized = true;
  if (!tracingEnabled(opts.enabled) || !endpointUrl) {
    endpoint = null;
    return;
  }
  endpoint = endpointUrl.replace(/\/+$/, "");
  service = opts.serviceName ?? "aegmis-agent";
  orgId = opts.orgId ?? process.env.AEGMIS_ORG_ID ?? orgFromApiKey();
  if (!orgId) {
    console.warn(
      "observability: no org_id (no AEGMIS_ORG_ID / unparseable AEGMIS_API_KEY) — " +
        "records will be untagged and hidden from org-scoped dashboards",
    );
  }
}

/** Lazy env auto-init so agents need zero code: AEGMIS_OTLP_ENDPOINT drives it. */
function ensureInit(): void {
  if (!initialized) initObservability(process.env.AEGMIS_OTLP_ENDPOINT);
}

/** Fire-and-forget POST. Fail-open; one warning per outage (re-armed on recovery). */
function postJson(path: string, body: Record<string, unknown>): void {
  if (!endpoint) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  const p = fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: controller.signal,
  })
    .then(() => {
      if (unreachable) {
        unreachable = false;
        console.warn(`observability: endpoint ${endpoint} reachable again — telemetry resumed`);
      }
    })
    .catch((err: unknown) => {
      if (!unreachable) {
        unreachable = true;
        const name = err instanceof Error ? err.constructor.name : "Error";
        console.warn(
          `observability: endpoint ${endpoint} unreachable (${name}) — telemetry paused. ` +
            "Governed tool calls are UNAFFECTED (observability is fail-open).",
        );
      }
    })
    .finally(() => {
      clearTimeout(timer);
      inflight.delete(p);
    });
  inflight.add(p);
}

/** Await outstanding posts — call before a short-lived process exits. */
export async function shutdownObservability(): Promise<void> {
  await Promise.allSettled([...inflight]);
}

export interface CallRecorder {
  /** Approval requested — posts the WAITING row (with the full payload) at once. */
  requested(approvalId: string, payload?: Record<string, unknown>): void;
  /** Decision landed — flips the row to approved | rejected | audited | error. */
  finish(status: string): void;
}

const NULL_RECORDER: CallRecorder = { requested: () => {}, finish: () => {} };

/**
 * Start recording one governed tool call. Returns a no-op recorder when
 * observability is disabled/unconfigured. Mirrors Python's `tool_span()`
 * (minus the OTel span — JS emits the REST lifecycle only).
 */
export function startRecord(
  tool: string,
  adapter: string,
  action: string,
  threadId: string,
): CallRecorder {
  ensureInit();
  if (!endpoint) return NULL_RECORDER;

  const startedMs = Date.now();
  let approvalId = "";
  let autoStatus: string | null = null;
  let done = false;

  return {
    requested(id: string, payload?: Record<string, unknown>) {
      autoStatus = (payload?._auto_status as string | undefined) ?? null;
      if (!id && autoStatus) {
        // Auto-decided by policy: no approval_id exists — key the record by the
        // platform's audit id (or a local id as a last resort).
        id = (payload?._audit_id as string | undefined) ?? `auto-${randomUUID().slice(0, 12)}`;
      }
      approvalId = id;
      if (!approvalId) return;
      const toolInfo = (payload?.tool ?? {}) as Record<string, unknown>;
      postJson("/v1/pending", {
        approval_id: approvalId,
        org_id: orgId,
        tool: (toolInfo.name as string | undefined) ?? tool,
        action,
        adapter,
        thread_id: threadId,
        service,
        message: payload?.message ?? null,
        kwargs: toolInfo.kwargs ?? null,
        channel: payload?.channel ?? null,
        policy_eval: payload?._policy_eval ?? null,
      });
    },

    finish(status: string) {
      if (done || !approvalId) return;
      done = true;
      // Policy-decided calls (no human): record as 'audited', not 'approved',
      // so the dashboard clearly shows the call was auto-allowed (e.g. amount
      // under the policy threshold) rather than human-approved.
      let reason: string | null = null;
      if (autoStatus) {
        if (status === "approved") {
          status = "audited";
          reason = "auto-approved by policy (below approval threshold / audit-only)";
        } else if (status === "rejected") {
          reason = "auto-rejected by policy";
        }
      }
      postJson("/v1/resolve", {
        approval_id: approvalId,
        org_id: orgId,
        status,
        wait_s: (Date.now() - startedMs) / 1000,
        reason,
      });
    },
  };
}
