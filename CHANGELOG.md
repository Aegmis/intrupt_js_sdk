# intrupt-js-sdk — Changelog

---

## 0.0.1-alpha.3 — 2026-07-06

### Added: `createApprovalServer` — optional, zero-dependency HTTP server

New helper from the `intrupt-js-sdk/server` subpath (built on Node's `http`, no
express) that exposes `POST /call-tool` and `POST /resume` for an `ApprovalRunner`
or `ApprovalGraph`:

```ts
import { createApprovalServer } from "intrupt-js-sdk/server";
createApprovalServer({ runner }); // port + secret default from AGENT_PUBLIC_URL / AGENT_RESUME_SECRET
```

Fully optional — wire the two endpoints into your own server (express, fastify,
Next.js route handlers) instead if you prefer; the runner only needs
`run` / `resume` / `waitForResult` / `pending`. Keeps the core dependency-free.

### Added: `preflight()` / `preflightCheck()` startup config check

Surface common misconfigurations (approvals enabled but no `AEGMIS_API_KEY`,
malformed key, missing base URL) at boot with a clear message instead of a
runtime `Invalid or expired token`:

```ts
import { preflightCheck } from "intrupt-js-sdk";
preflightCheck(); // logs warnings/errors; pass { throwOnError: true } to hard-fail
```

---

## 0.0.1-alpha.2 — 2026-07-05

### Fixed: OpenAI Agents adapter sent empty approval kwargs

`@openai/agents` calls tools as `invoke(runContext, input, details)` — the tool
arguments are the JSON string in the **second** arg. The adapter was passing the
first arg (`runContext`) as the kwargs, so every approval request went out with an
empty `tool_kwargs`. With no args a policy condition couldn't match → the backend
auto-approved → approvals appeared to "not trigger". The adapter now extracts the
input correctly (parses the `invoke` JSON input; falls back to the first arg for the
legacy `execute(parsedArgs)` shape).

### Changed: zero runtime dependencies

Moved `express`, `zod`, `dotenv`, `@ai-sdk/openai`, and `@langchain/openai` from
`dependencies` to `devDependencies` — they are only used by the examples, never by
`src/`. `npm i intrupt-js-sdk` now installs with **no runtime dependencies**; the
framework packages (`ai`, `@mastra/core`, `@openai/agents`, `@langchain/core`,
`@langchain/langgraph`) remain optional peer dependencies.

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
