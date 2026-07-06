/**
 * Vercel AI SDK example — the JS counterpart of `intrupt_py_sdk/example/agent.py`.
 *
 * A gated `purchase_stock` tool pauses for human approval before executing; the
 * approval platform POSTs back to /resume when the human decides.
 *
 * Reference file, NOT part of the built library. Install extras first:
 *   npm i ai @ai-sdk/openai zod express
 *   npm i -D tsx @types/express
 *
 * Env: OPENAI_API_KEY, AEGMIS_BASE_URL, AEGMIS_API_KEY, AGENT_PUBLIC_URL, AGENT_RESUME_SECRET.
 * Run: npx tsx example/vercel_agent.ts
 * Smoke test: POST http://localhost:8081/call-tool {"message":"buy 10 shares of AAPL"}
 */
import { generateText, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { ApprovalMiddleware, ApprovalRunner } from "intrupt-js-sdk";
import { approvalRequired } from "intrupt-js-sdk/vercel";
import { agentConfig, startApprovalServer } from "./_server";

ApprovalMiddleware.configure({
  baseUrl: process.env.AEGMIS_BASE_URL ?? "http://localhost:8080",
  apiKey: process.env.AEGMIS_API_KEY,
});
const { publicUrl, port, resumeSecret } = agentConfig();

const getStockPrice = tool({
  description: "Fetch latest stock price for a symbol (e.g. 'AAPL').",
  parameters: z.object({ symbol: z.string() }),
  execute: async ({ symbol }) => ({ symbol, price: 123.45 }),
});

const purchaseStock = approvalRequired(
  { action: "purchase_stock", message: "Approve buying shares", channel: "slack", args: ["symbol", "quantity", "amount"] },
  "purchase_stock",
)(
  tool({
    description: "Purchase a given quantity of a stock symbol.",
    parameters: z.object({ symbol: z.string(), quantity: z.number(), amount: z.number() }),
    execute: async ({ symbol, quantity, amount }) => ({
      status: "success",
      message: `Purchase order placed for ${quantity} shares of ${symbol}.`,
      symbol,
      quantity,
      amount,
    }),
  }),
);

const runner = new ApprovalRunner({
  callbackUrl: `${publicUrl}/resume`,
  callbackSecret: resumeSecret,
  invoke: (input) =>
    generateText({
      model: openai("gpt-4o-mini"),
      tools: { getStockPrice, purchaseStock },
      maxSteps: 5,
      prompt: String(input),
    }),
  formatResult: (raw, threadId) => ({ status: "complete", thread_id: threadId, result: (raw as { text: string }).text }),
});

console.log('[vercel] stock agent ready — POST /call-tool {"message":"buy 10 shares of AAPL"}');
startApprovalServer(runner, { port, resumeSecret });
