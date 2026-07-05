# intrupt-js-sdk — Changelog

---

## 0.0.1-alpha.1 — 2026-07-05

### ⚠️ Breaking: approval env vars renamed

`APPROVAL_BASE_URL` → **`AEGMIS_BASE_URL`** and `APPROVAL_API_KEY` → **`AEGMIS_API_KEY`**.
The old names are no longer read (hard replace). Update your environment and any
`ApprovalMiddleware.configure({ baseUrl, apiKey })` sources.

### Added: `AEGMIS_APPROVAL` master switch

New env flag controlling whether gated tools actually contact the backend:

- **Enabled by default** → gated tools send approval requests to the backend API
  for a real human decision.
- Set `AEGMIS_APPROVAL=false` (or `0` / `no` / `off`) → **auto-approve** in-process;
  `gateCall` short-circuits before any client/network call.

Exposed as `approvalsEnabled()` from the package root.

### Fixed: Mastra adapter compatibility with `@mastra/core >= 1.0`

The adapter was written for the legacy `execute({ context })` tool API. Current
Mastra calls `execute(inputData, executionContext)` (input is the first arg), which
broke type-checking and produced empty approval kwargs. The adapter now:

- accepts both calling conventions (selects the input by argument count),
- swaps `execute` **in place** to preserve the Mastra `Tool` instance/prototype
  (a spread clone dropped it and failed the `Tool` structural type),
- loosens the tool type so current `@mastra/core` tools type-check.

### Changed

- Mastra adapter: a rejected tool now returns a `message` (e.g. `The "purchase_stock"
  action was not approved, so it did not run.`) so the caller/LLM reports a clear
  decline instead of a bare `cancelled`.
- `ApprovalMiddleware.setClient()` now accepts any `ApprovalCreator` (only
  `createApproval` is required), so a custom/local approver can be installed.

---

## 0.0.1-alpha.0

Initial alpha: core `ApprovalClient`, the cross-call gate, `ApprovalRunner`, and
framework adapters (Vercel AI SDK, OpenAI Agents, Mastra, LangChain.js, LangGraph.js).
