/**
 * OpenAI Agents SDK (JS) adapter for intrupt human-in-the-loop approvals.
 * Port of `adapters/openai_agents.py`.
 *
 * `@openai/agents` tools are created with `tool({ name, description,
 * parameters, execute })`. Gating wraps `execute`.
 *
 * Install (peer dep): `npm i @openai/agents`
 *
 * Usage
 * -----
 * ```ts
 * import { tool, run, Agent } from "@openai/agents";
 * import { z } from "zod";
 * import { approvalRequired } from "intrupt-js-sdk/openai-agents";
 * import { ApprovalMiddleware, ApprovalRunner } from "intrupt-js-sdk";
 *
 * ApprovalMiddleware.configure();
 *
 * const purchaseStock = approvalRequired({
 *   action: "purchase_stock", message: "Approve stock purchase?", channel: "slack", args: ["symbol", "quantity"],
 * })(tool({
 *   name: "purchase_stock",
 *   description: "Buy shares of a stock.",
 *   parameters: z.object({ symbol: z.string(), quantity: z.number() }),
 *   execute: async ({ symbol, quantity }) => `bought ${quantity} ${symbol}`,
 * }));
 *
 * const agent = new Agent({ name: "Broker", tools: [purchaseStock] });
 * const runner = new ApprovalRunner({
 *   callbackUrl: "http://localhost:8081/resume",
 *   invoke: (input) => run(agent, String(input)),
 *   formatResult: (raw, threadId) => ({ status: "complete", thread_id: threadId, result: (raw as any).finalOutput }),
 * });
 * ```
 */
import { gateCall, type ApprovalOptions } from "../core/gating";

/** Minimal structural type for an `@openai/agents` function tool. */
interface OpenAITool {
  name?: string;
  description?: string;
  execute?: (args: Record<string, unknown>, ctx?: unknown) => unknown;
  invoke?: (args: Record<string, unknown>, ctx?: unknown) => unknown;
  [key: string]: unknown;
}

/**
 * Wrap an `@openai/agents` tool so it pauses for human approval before executing.
 * The tool object carries its own `name`, so no explicit name is needed.
 */
export function approvalRequired(opts: ApprovalOptions) {
  return function wrap<T extends OpenAITool>(toolDef: T): T {
    const toolName = toolDef.name ?? opts.action ?? "tool";
    // Different @openai/agents versions expose the handler as `execute` or `invoke`.
    const key: "execute" | "invoke" = typeof toolDef.execute === "function" ? "execute" : "invoke";
    const original = toolDef[key] as OpenAITool["execute"];
    const gated: OpenAITool = {
      ...toolDef,
      [key]: async (args: Record<string, unknown>, ctx?: unknown) => {
        const { approved } = await gateCall(
          { name: toolName, description: toolDef.description },
          args ?? {},
          opts,
          "openai_agents",
        );
        if (!approved) {
          return { status: "cancelled", tool: toolName };
        }
        return original ? original(args, ctx) : undefined;
      },
    };
    return gated as T;
  };
}

export { ApprovalRunner } from "../core/runner";
