/**
 * Mastra example — gated tool behind a Mastra Agent.
 *
 * Adapter support: @mastra/core >= 1.0 (current tool API, where `execute` is
 * called as `(inputData, executionContext)`). The adapter also still works with
 * the legacy `execute({ context })` API — it detects the arg shape at runtime.
 *
 * Reference file, NOT part of the built library. Install extras first:
 *   npm i @mastra/core@^1 @ai-sdk/openai zod express
 *   npm i -D tsx @types/express
 *
 * Env: OPENAI_API_KEY, AEGMIS_BASE_URL, AEGMIS_API_KEY, AGENT_PUBLIC_URL, AGENT_RESUME_SECRET.
 * Run: npx tsx example/mastra_agent.ts
 */
import "./env"; // load .env before reading process.env
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { ApprovalMiddleware, ApprovalRunner } from "intrupt-js-sdk";
import { approvalRequired } from "intrupt-js-sdk/mastra";
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
  createTool({
    id: "purchase_stock",
    description: "Buy shares of a stock.",
    inputSchema: z.object({ symbol: z.string(), quantity: z.number() }),
    // Mastra >= 1.0 passes the validated input as the first arg.
    execute: async (inputData) => ({
      status: "success",
      message: `Purchase order placed for ${inputData.quantity} shares of ${inputData.symbol}.`,
      ...inputData,
    }),
  }),
);

const agent = new Agent({
  name: "Broker",
  instructions: "You help the user buy stocks. Use the purchase_stock tool when asked to buy.",
  model: openai("gpt-4o-mini"),
  tools: { purchaseStock },
});

const runner = new ApprovalRunner({
  callbackUrl: `${publicUrl}/resume`,
  callbackSecret: resumeSecret,
  invoke: (input) => agent.generate(String(input)),
  formatResult: (raw, threadId) => ({
    status: "complete",
    thread_id: threadId,
    result: (raw as { text?: unknown }).text,
  }),
});

console.log('[mastra] stock agent ready — POST /call-tool {"message":"buy 10 shares of AAPL"}');
startApprovalServer(runner, { port, resumeSecret });
