/**
 * LangChain.js tools-only example — no graph, just a manual tool-call loop with
 * ChatOpenAI, gated by the LangChain adapter. Shows using `intrupt-js-sdk/langchain`
 * with the generic ApprovalRunner.
 *
 * Reference file, NOT part of the built library. Install extras first:
 *   npm i @langchain/core @langchain/openai zod express
 *   npm i -D tsx @types/express
 *
 * Env: OPENAI_API_KEY, APPROVAL_BASE_URL, APPROVAL_API_KEY, AGENT_PUBLIC_URL, AGENT_RESUME_SECRET.
 * Run: npx tsx example/langchain_agent.ts
 */
import { tool } from "@langchain/core/tools";
import { HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { ApprovalMiddleware, ApprovalRunner } from "intrupt-js-sdk";
import { gateHandler } from "intrupt-js-sdk/langchain";
import { agentConfig, startApprovalServer } from "./_server";

ApprovalMiddleware.configure({
  baseUrl: process.env.APPROVAL_BASE_URL ?? "http://localhost:8080",
  apiKey: process.env.APPROVAL_API_KEY,
});
const { publicUrl, port, resumeSecret } = agentConfig();

const purchaseStock = tool(
  gateHandler(
    async ({ symbol, quantity }) => `Purchase order placed for ${quantity} shares of ${symbol}.`,
    { name: "purchase_stock", description: "Buy shares of a stock." },
    { action: "purchase_stock", message: "Approve buying shares", channel: "slack", args: ["symbol", "quantity"] },
  ),
  {
    name: "purchase_stock",
    description: "Buy shares of a stock.",
    schema: z.object({ symbol: z.string(), quantity: z.number() }),
  },
);

const toolsByName = { purchase_stock: purchaseStock } as const;
const llm = new ChatOpenAI({ model: "gpt-4o-mini" }).bindTools([purchaseStock]);

/** Minimal agent loop: LLM → tool calls → LLM. The gated tool suspends inside `.invoke`. */
async function agentLoop(message: string): Promise<string> {
  const messages: unknown[] = [new HumanMessage(message)];
  const ai = await llm.invoke(messages as never);
  messages.push(ai);
  for (const call of (ai.tool_calls ?? []) as Array<{ name: string }>) {
    const t = toolsByName[call.name as keyof typeof toolsByName];
    if (t) messages.push(await t.invoke(call as never));
  }
  const final = await llm.invoke(messages as never);
  return String(final.content);
}

const runner = new ApprovalRunner({
  callbackUrl: `${publicUrl}/resume`,
  callbackSecret: resumeSecret,
  invoke: (input) => agentLoop(String(input)),
});

startApprovalServer(runner, { port, resumeSecret });
