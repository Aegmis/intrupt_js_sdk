# Examples

Runnable reference agents, one per adapter. These are **not** part of the built
library (they're excluded from the tsup build and `tsc` typecheck) and pull in
framework packages as extra dependencies.

All the HTTP examples share [`_server.ts`](./_server.ts), which exposes
`POST /call-tool` and `POST /resume` — the same contract as
`intrupt_py_sdk/example/agent.py`.

| File                        | Framework          | Approval channel | Extra deps |
| --------------------------- | ------------------ | ---------------- | ---------- |
| `console_agent.ts`          | Vercel AI SDK      | **terminal (local)** — no API/server needed | `ai @ai-sdk/openai zod` |
| `vercel_agent.ts`           | Vercel AI SDK      | HTTP → Slack     | `ai @ai-sdk/openai zod express` |
| `openai_agents_agent.ts`    | `@openai/agents`   | HTTP → Slack     | `@openai/agents zod express` |
| `mastra_agent.ts`           | Mastra             | HTTP → Slack     | `@mastra/core @ai-sdk/openai zod express` |
| `langchain_agent.ts`        | LangChain.js tools | HTTP → Slack     | `@langchain/core @langchain/openai zod express` |
| `langgraph_agent.ts`        | LangGraph.js       | HTTP → Slack     | `@langchain/langgraph @langchain/core @langchain/openai zod express` |

Dev deps for all: `npm i -D tsx @types/express`.

## Fastest path — no server, no API key

`console_agent.ts` approves on the terminal via `onApprovalAsync`, so it needs
only `OPENAI_API_KEY`:

```bash
npm i ai @ai-sdk/openai zod && npm i -D tsx
export OPENAI_API_KEY=sk-...
npx tsx example/console_agent.ts "buy 10 shares of AAPL for 1500"
# → 🔔 Approval requested — purchase_stock ... Approve? (y/n)
```

## Full HTTP flow (Slack)

Run the approval API (`intrupt_api`, :8080) and Slack wiring, then any HTTP
example:

```bash
export OPENAI_API_KEY=sk-...
export AEGMIS_BASE_URL=http://localhost:8080
export AEGMIS_API_KEY=sk_org_org_..._<hash>
export AGENT_PUBLIC_URL=http://localhost:8081
export AGENT_RESUME_SECRET=$(openssl rand -hex 16)

npx tsx example/vercel_agent.ts     # or openai_agents / mastra / langchain / langgraph

# Smoke test (agent on :8081):
curl -s localhost:8081/call-tool -H 'content-type: application/json' \
  -d '{"message":"buy 10 shares of AAPL"}'
# → {"status":"pending_approval","thread_id":"...","approval_id":"..."}
# Approve in Slack; the platform POSTs /resume and the run completes.
```
