/**
 * intrupt-js-sdk — JavaScript/TypeScript client SDK + framework adapters for the
 * human-in-the-loop approval API. Port of `intrupt_py_sdk/__init__.py`.
 *
 * Framework adapters live under subpath exports so you only pull in the glue you
 * use (and its peer dep):
 *   - `intrupt-js-sdk/vercel`         — Vercel AI SDK (`ai`)
 *   - `intrupt-js-sdk/openai-agents`  — OpenAI Agents SDK (`@openai/agents`)
 *   - `intrupt-js-sdk/mastra`         — Mastra (`@mastra/core`)
 *   - `intrupt-js-sdk/langchain`      — LangChain.js tools (`@langchain/core`)
 *   - `intrupt-js-sdk/langgraph`      — LangGraph.js (`@langchain/langgraph`)
 */

// Core client + error helpers
export {
  ApprovalClient,
  ApprovalApiError,
  userFacingError,
  errorStatusCode,
  type ApprovalClientOptions,
  type ApprovalCreator,
  type CreateApprovalParams,
  type CreateApprovalResult,
  type ToolPayload,
} from "./core/client";

// Process-wide client holder
export { ApprovalMiddleware } from "./adapters/approvalMiddleware";

// Observability (push to the aegmis_obs dashboard) — auto-inits from
// AEGMIS_OTLP_ENDPOINT; explicit init overrides. Fail-open by design.
export {
  initObservability,
  shutdownObservability,
  startRecord,
  type CallRecorder,
  type ObservabilityOptions,
} from "./core/observability";

// Generic approval-aware runner (works with any framework via an `invoke` thunk)
export {
  ApprovalRunner,
  type ApprovalRunnerOptions,
  type OnApprovalAsync,
  type ResultDict,
} from "./core/runner";

// LangGraph.js convenience export (the most common graph-based flow)
export { ApprovalGraph, type ApprovalGraphOptions } from "./adapters/langgraph";

// Shared gating types
export type { ApprovalOptions, ToolMeta, GateResult } from "./core/gating";

// Master approval switch (reads the AEGMIS_APPROVAL env var)
export { approvalsEnabled } from "./core/gating";

// Startup config check — surfaces missing/invalid AEGMIS_* config with clear messages
export { preflight, preflightCheck, type PreflightIssue } from "./core/preflight";

// Gate primitives — useful for building a custom /resume endpoint server-side.
export * as gate from "./core/gate";

// Utilities
export { filterKwargs } from "./utils/filterKwargs";
