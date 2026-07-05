/**
 * LangGraph.js adapter for intrupt human-in-the-loop approvals. Port of
 * `adapters/langgraph.py`.
 *
 * LangGraph.js tools ARE LangChain tools, so tool gating is re-exported from
 * the LangChain adapter ({@link gateHandler} / {@link approvalRequired}). This
 * module adds {@link ApprovalGraph}, which wraps a compiled graph with the
 * run/resume/pending-approval flow and exposes checkpoint state passthroughs.
 *
 * Install (peer deps): `npm i @langchain/langgraph @langchain/core`
 *
 * Usage
 * -----
 * ```ts
 * import { tool } from "@langchain/core/tools";
 * import { z } from "zod";
 * import { ApprovalGraph, gateHandler } from "intrupt-js-sdk/langgraph";
 * import { ApprovalMiddleware } from "intrupt-js-sdk";
 *
 * ApprovalMiddleware.configure({ baseUrl: process.env.AEGMIS_BASE_URL, apiKey: process.env.AEGMIS_API_KEY });
 *
 * const purchaseStock = tool(
 *   gateHandler(async ({ symbol, quantity }) => ({ status: "success", symbol, quantity }),
 *     { name: "purchase_stock", description: "Buy shares." },
 *     { action: "purchase_stock", message: "Approve buying shares", channel: "slack", args: ["symbol", "quantity"] }),
 *   { name: "purchase_stock", description: "Buy shares.",
 *     schema: z.object({ symbol: z.string(), quantity: z.number() }) },
 * );
 *
 * // ...build & compile a StateGraph with a ToolNode([purchaseStock])...
 *
 * const approvalGraph = new ApprovalGraph({
 *   graph,
 *   callbackUrl: `${AGENT_PUBLIC_URL}/resume`,
 *   callbackSecret: process.env.AGENT_RESUME_SECRET,
 * });
 *
 * let result = await approvalGraph.run(threadId, { messages: [{ role: "user", content: msg }] });
 * // if result.status === "pending_approval": wait for the /resume callback
 * result = await approvalGraph.resume(threadId, true, result.approval_id as string);
 * ```
 */
import { ApprovalRunner, type ResultDict, type OnApprovalAsync } from "../core/runner";

/** Structural type for a compiled LangGraph.js graph. */
interface CompiledGraph {
  invoke(input: unknown, config?: unknown): Promise<unknown>;
  getState(config: unknown): unknown;
  updateState(config: unknown, values: unknown, asNode?: string): unknown;
}

export interface ApprovalGraphOptions {
  graph: CompiledGraph;
  callbackUrl?: string;
  callbackSecret?: string;
  onApprovalAsync?: OnApprovalAsync;
  /** Seconds to wait for a gate to fire before returning pending_approval. Default 1.5. */
  timeout?: number;
}

/** Wraps a compiled LangGraph.js graph; handles approval gating and resume. */
export class ApprovalGraph extends ApprovalRunner {
  private readonly graph: CompiledGraph;

  constructor(options: ApprovalGraphOptions) {
    const graph = options.graph;
    super({
      invoke: (input, threadId) => graph.invoke(input, { configurable: { thread_id: threadId } }),
      callbackUrl: options.callbackUrl,
      callbackSecret: options.callbackSecret,
      onApprovalAsync: options.onApprovalAsync,
      timeout: options.timeout,
      formatResult: (raw, threadId): ResultDict => {
        const state = raw as { messages?: Array<{ content?: unknown; constructor?: { name?: string } }> };
        return {
          status: "complete",
          thread_id: threadId,
          result: raw,
          messages: (state?.messages ?? []).map((m) => ({
            type: m?.constructor?.name ?? "Message",
            content: m?.content,
          })),
        };
      },
    });
    this.graph = graph;
  }

  /** Return the LangGraph checkpoint state for `threadId`. */
  getState(threadId: string): unknown {
    return this.graph.getState({ configurable: { thread_id: threadId } });
  }

  updateState(threadId: string, values: unknown, asNode?: string): unknown {
    return this.graph.updateState({ configurable: { thread_id: threadId } }, values, asNode);
  }
}

// LangGraph.js tools are LangChain tools — reuse the same gating helpers.
export { gateHandler, approvalRequired } from "./langchainTools";
export { ApprovalRunner } from "../core/runner";
