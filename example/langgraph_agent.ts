/**
 * LangGraph.js example — closest parallel to `intrupt_py_sdk/example/agent.py`.
 * Uses ApprovalGraph to wrap a compiled StateGraph with a ToolNode.
 *
 * Reference file, NOT part of the built library. Install extras first:
 *   npm i @langchain/langgraph @langchain/core @langchain/openai zod express
 *   npm i -D tsx @types/express
 *
 * Env: OPENAI_API_KEY, APPROVAL_BASE_URL, APPROVAL_API_KEY, AGENT_PUBLIC_URL, AGENT_RESUME_SECRET.
 * Run: npx tsx example/langgraph_agent.ts
 */
import { END, MemorySaver, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { ApprovalMiddleware } from "intrupt-js-sdk";
import { ApprovalGraph, gateHandler } from "intrupt-js-sdk/langgraph";
import { agentConfig, startApprovalServer } from "./_server";

ApprovalMiddleware.configure({
  baseUrl: process.env.APPROVAL_BASE_URL ?? "http://localhost:8080",
  apiKey: process.env.APPROVAL_API_KEY,
});
const { publicUrl, port, resumeSecret } = agentConfig();

// Gate the raw handler BEFORE building the tool (the recommended LangChain path).
const purchaseStock = tool(
  gateHandler(
    async ({ symbol, quantity, amount }) => ({
      status: "success",
      message: `Purchase order placed for ${quantity} shares of ${symbol}.`,
      symbol,
      quantity,
      amount,
    }),
    { name: "purchase_stock", description: "Purchase a given quantity of a stock symbol." },
    { action: "purchase_stock", message: "Approve buying shares", channel: "slack", args: ["symbol", "quantity", "amount"] },
  ),
  {
    name: "purchase_stock",
    description: "Purchase a given quantity of a stock symbol.",
    schema: z.object({ symbol: z.string(), quantity: z.number(), amount: z.number() }),
  },
);

const tools = [purchaseStock];
const llm = new ChatOpenAI({ model: "gpt-4o-mini" }).bindTools(tools);

const chatNode = async (state: typeof MessagesAnnotation.State) => ({
  messages: [await llm.invoke(state.messages)],
});

const routeToTools = (state: typeof MessagesAnnotation.State) => {
  const last = state.messages.at(-1) as { tool_calls?: unknown[] } | undefined;
  return last?.tool_calls?.length ? "tools" : END;
};

const graph = new StateGraph(MessagesAnnotation)
  .addNode("chat_node", chatNode)
  .addNode("tools", new ToolNode(tools))
  .addEdge(START, "chat_node")
  .addConditionalEdges("chat_node", routeToTools, ["tools", END])
  .addEdge("tools", "chat_node")
  .compile({ checkpointer: new MemorySaver() });

const approvalGraph = new ApprovalGraph({
  graph,
  callbackUrl: `${publicUrl}/resume`,
  callbackSecret: resumeSecret,
});

startApprovalServer(approvalGraph, {
  port,
  resumeSecret,
  inputFor: (message) => ({ messages: [{ role: "user", content: message }] }),
});
