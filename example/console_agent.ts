/**
 * Console / local-approval example. Port of `intrupt_py_sdk/example/console_agent.py`.
 *
 * Fully self-contained: it approves on the terminal via `onApprovalAsync`, so it
 * needs NO approval API server and NO AEGMIS_API_KEY — only OPENAI_API_KEY.
 * This is the quickest way to see the pending → resume flow end to end.
 *
 * Reference file, NOT part of the built library. Install extras first:
 *   npm i ai @ai-sdk/openai zod
 *   npm i -D tsx
 *
 * Run: npx tsx example/console_agent.ts "buy 10 shares of AAPL for 1500"
 */
import crypto from "node:crypto";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { generateText, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { ApprovalRunner } from "intrupt-js-sdk";
import { approvalRequired } from "intrupt-js-sdk/vercel";

const purchaseStock = approvalRequired(
  { action: "purchase_stock", message: "Approve buying shares", args: ["symbol", "quantity", "amount"] },
  "purchase_stock",
)(
  tool({
    description: "Purchase a given quantity of a stock symbol.",
    parameters: z.object({ symbol: z.string(), quantity: z.number(), amount: z.number() }),
    execute: async ({ symbol, quantity, amount }) => ({
      status: "success",
      message: `Purchase order placed for ${quantity} shares of ${symbol} ($${amount}).`,
    }),
  }),
);

const runner = new ApprovalRunner({
  invoke: (msg) =>
    generateText({ model: openai("gpt-4o-mini"), tools: { purchaseStock }, maxSteps: 5, prompt: String(msg) }),
  formatResult: (raw, threadId) => ({ status: "complete", thread_id: threadId, result: (raw as { text: string }).text }),
  // Local approval: no HTTP call — just mint an id. The real decision happens
  // below via runner.resume() after we prompt on the terminal.
  onApprovalAsync: async (threadId, payload) => {
    const t = payload.tool as { name?: string; kwargs?: Record<string, unknown> } | undefined;
    console.log(`\n🔔 Approval requested — ${payload.action}`);
    console.log(`   tool: ${t?.name}`, t?.kwargs ?? {});
    return { approval_id: `local_${threadId}` };
  },
});

async function main() {
  const message = process.argv.slice(2).join(" ") || "buy 10 shares of AAPL for 1500";
  const threadId = crypto.randomUUID();

  const first = await runner.run(threadId, message);
  if (first.status !== "pending_approval") {
    console.log(first);
    return;
  }

  const rl = readline.createInterface({ input, output });
  const answer = (await rl.question("Approve? (y/n) ")).trim().toLowerCase();
  rl.close();

  await runner.resume(threadId, answer === "y" || answer === "yes", first.approval_id as string);
  const final = await runner.waitForResult(threadId);
  console.log("\nResult:", final.result ?? final);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
