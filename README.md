# intrupt-js-sdk

Put a human in front of your AI agent's riskiest actions. A high-stakes tool call
pauses for approval, routes to Slack, and resumes automatically — with a full audit trail.

JavaScript/TypeScript client SDK + framework adapters for the human-in-the-loop
approval API. This is the JS counterpart of [`intrupt_py_sdk`](../intrupt_py_sdk)
and talks to the **same** approval API (`intrupt_api`, port `8080`) over the same
wire protocol — no server changes required.

A tool decorated with an approval gate pauses before executing, the SDK POSTs to
the approval API, a human approves/rejects (e.g. in Slack), and the approval
platform calls back into your agent's `/resume` endpoint to unblock the tool.

## Install

```bash
npm i intrupt-js-sdk
```

Framework glue is loaded from subpaths so you only pull in the peer dep you use:

| Framework            | Import path                    | Peer dependency        |
| -------------------- | ------------------------------ | ---------------------- |
| Vercel AI SDK        | `intrupt-js-sdk/vercel`        | `ai`                   |
| OpenAI Agents (JS)   | `intrupt-js-sdk/openai-agents` | `@openai/agents`       |
| Mastra               | `intrupt-js-sdk/mastra`        | `@mastra/core`         |
| LangChain.js tools   | `intrupt-js-sdk/langchain`     | `@langchain/core`      |
| LangGraph.js         | `intrupt-js-sdk/langgraph`     | `@langchain/langgraph` |

## Quick start (Vercel AI SDK)

```ts
import { generateText, stepCountIs, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { ApprovalMiddleware, ApprovalRunner } from "intrupt-js-sdk";
import { approvalRequired } from "intrupt-js-sdk/vercel";

ApprovalMiddleware.configure({
  baseUrl: process.env.AEGMIS_BASE_URL, // http://localhost:8080
  apiKey: process.env.AEGMIS_API_KEY,   // sk_org_org_..._<hash>
});

const purchaseStock = approvalRequired(
  { action: "purchase_stock", message: "Approve buying shares", channel: "slack", args: ["symbol", "quantity"] },
  "purchase_stock",
)(tool({
  description: "Buy shares of a stock.",
  inputSchema: z.object({ symbol: z.string(), quantity: z.number() }),
  execute: async ({ symbol, quantity }) => ({ status: "success", symbol, quantity }),
}));

const runner = new ApprovalRunner({
  callbackUrl: "http://localhost:8081/resume",
  callbackSecret: process.env.AGENT_RESUME_SECRET,
  invoke: (input) =>
    generateText({ model: openai("gpt-4o-mini"), tools: { purchaseStock }, stopWhen: stepCountIs(5), prompt: String(input) }),
  formatResult: (raw, threadId) => ({ status: "complete", thread_id: threadId, result: (raw as any).text }),
});

// 1. Start a run. Returns { status: "pending_approval", approval_id } if a gated tool fires.
const pending = await runner.run("thread-1", "buy 10 shares of AAPL");

// 2. When the human decides (your /resume endpoint), unblock the tool:
await runner.resume("thread-1", true, pending.approval_id as string);
const final = await runner.waitForResult("thread-1");
```

See [`example/`](./example) for a runnable agent per adapter (Vercel, OpenAI
Agents, Mastra, LangChain.js, LangGraph.js) plus `console_agent.ts` — a
self-contained terminal-approval demo that needs no API server or key. The
HTTP examples share `_server.ts`, which exposes `/call-tool` and `/resume`,
mirroring the Python `example/agent.py`.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `AEGMIS_APPROVAL` | `true` | **Master switch.** Enabled by default → gated tools send approval requests to the backend API for a real human decision. Set to `false` (or `0` / `no` / `off`) to **auto-approve** in-process with no backend call. |
| `AEGMIS_BASE_URL` | — | Base URL of the approval API (e.g. `https://api.aegmis.com` or `http://localhost:8080`). Required when approvals are enabled (the default). |
| `AEGMIS_API_KEY` | — | Org API key, format `sk_org_{org_id}_{hash}`. Required when approvals are enabled (the default). |
| `AGENT_RESUME_SECRET` | — | Shared secret the backend sends as `X-Agent-Secret` when it calls your `/resume` endpoint. |

By default (`AEGMIS_APPROVAL` unset or `true`) a gated tool sends a real approval
request and blocks until a human decides — so configure `AEGMIS_BASE_URL` /
`AEGMIS_API_KEY`. Set `AEGMIS_APPROVAL=false` to auto-approve in-process — handy
for local development, the Mastra studio, and tests. Check the current state at
runtime with `approvalsEnabled()`.

> ⚠️ **Migrating from ≤ `0.0.1-alpha.0`:** the env vars were renamed
> `APPROVAL_BASE_URL` → `AEGMIS_BASE_URL` and `APPROVAL_API_KEY` → `AEGMIS_API_KEY`
> (no fallback). Update your environment.

## The two-step run/resume flow

`ApprovalRunner.run()` launches your agent as a background task and returns
within `timeout` seconds (default 1.5s). If a gated tool opens an approval gate
before then, `run()` returns `{ status: "pending_approval", approval_id, thread_id }`
while the task stays parked on the gate.

`resume()` resolves the gate and returns **immediately** (critical — Slack
webhooks retry if you block > ~3s). The task finishes in the background; poll
`waitForResult(threadId)` for the terminal result.

## Framework adapters

Every adapter exports `approvalRequired(opts)` returning a wrapper for that
framework's tool shape. `opts` is `{ action?, message?, channel?, args? }`
(`args` whitelists which tool arguments are shown to the approver).

- **Vercel AI SDK / OpenAI Agents / Mastra** — plain-object tools; the wrapper
  clones the tool and gates its `execute`.
- **LangChain.js / LangGraph.js** — tools are `Runnable`s. Prefer
  `gateHandler(fn, meta, opts)` to wrap the raw handler *before* `tool(...)`;
  `approvalRequired(opts)(toolInstance)` also works on an already-built tool.
- **LangGraph.js** additionally provides `ApprovalGraph`, a runner that wraps a
  compiled graph and exposes `getState`/`updateState`.

For any framework not listed, use the generic `ApprovalRunner` with an `invoke`
thunk plus the closest adapter (or call `gateCall` directly).

## Local / policy approval (no HTTP)

Pass `onApprovalAsync` to a runner to approve without the HTTP API — useful for
console prompts, tests, or a local policy engine:

```ts
new ApprovalRunner({
  invoke,
  onApprovalAsync: async (threadId, payload) => {
    // decide however you like; return an approval id, then call runner.resume(...)
    return { approval_id: `local_${threadId}` };
  },
});
```

## How this maps to the Python SDK

| Python (`intrupt_py_sdk`)         | JS (`intrupt-js-sdk`)                     |
| --------------------------------- | ---------------------------------------- |
| `core/client.py`                  | `src/core/client.ts`                     |
| `core/gate.py`                    | `src/core/gate.ts` (single-loop, simpler) |
| `adapters/approval_middleware.py` | `src/adapters/approvalMiddleware.ts`     |
| `adapters/langgraph.py`           | `src/adapters/langgraph.ts`              |
| `adapters/openai_agents.py`       | `src/adapters/openaiAgents.ts`           |
| `contextvars`                     | `AsyncLocalStorage` (`src/core/context.ts`) |
| `utils/utils.py::_filter_kwargs`  | `src/utils/filterKwargs.ts`              |

**Why `gate.ts` is simpler:** `gate.py` needs `_pending_loops` +
`call_soon_threadsafe` because adapters like CrewAI run tools in worker-thread
event loops. Node has one event loop, so a pending `Promise` resolved from
anywhere just works.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # tsup -> dist/ (dual ESM + CJS + .d.ts)
```
