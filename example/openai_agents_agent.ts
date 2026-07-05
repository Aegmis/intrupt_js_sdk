/**
 * OpenAI Agents SDK (JS) example. Port of `intrupt_py_sdk/example/openai_agents_agent.py`.
 *
 * Reference file, NOT part of the built library. Install extras first:
 *   npm i @openai/agents zod express
 *   npm i -D tsx @types/express
 *
 * Env: OPENAI_API_KEY, AEGMIS_BASE_URL, AEGMIS_API_KEY, AGENT_PUBLIC_URL, AGENT_RESUME_SECRET.
 * Run: npx tsx example/openai_agents_agent.ts
 */
import { Agent, run, tool } from "@openai/agents";
import { z } from "zod";
import { ApprovalMiddleware, ApprovalRunner } from "intrupt-js-sdk";
import { approvalRequired } from "intrupt-js-sdk/openai-agents";
import { agentConfig, startApprovalServer } from "./_server";

ApprovalMiddleware.configure({
  baseUrl: process.env.AEGMIS_BASE_URL ?? "http://localhost:8080",
  apiKey: process.env.AEGMIS_API_KEY,
});
const { publicUrl, port, resumeSecret } = agentConfig();

const purchaseStock = approvalRequired({
  action: "purchase_stock",
  message: "Approve stock purchase?",
  channel: "slack",
  args: ["symbol", "quantity"],
})(
  tool({
    name: "purchase_stock",
    description: "Buy shares of a stock.",
    parameters: z.object({ symbol: z.string(), quantity: z.number() }),
    execute: async ({ symbol, quantity }) => `Purchase order placed for ${quantity} shares of ${symbol}.`,
  }),
);

const agent = new Agent({
  name: "Broker",
  instructions: "You help the user buy stocks. Use the purchase_stock tool when asked to buy.",
  tools: [purchaseStock],
});

const runner = new ApprovalRunner({
  callbackUrl: `${publicUrl}/resume`,
  callbackSecret: resumeSecret,
  invoke: (input) => run(agent, String(input)),
  formatResult: (raw, threadId) => ({
    status: "complete",
    thread_id: threadId,
    result: (raw as { finalOutput?: unknown }).finalOutput,
  }),
});

startApprovalServer(runner, { port, resumeSecret });
