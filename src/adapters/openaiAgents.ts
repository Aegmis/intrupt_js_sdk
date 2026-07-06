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
  // The handler differs by @openai/agents version: current tools expose
  // `invoke(runContext, inputJSON, details)`; older ones an `execute(parsedArgs, ctx)`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute?: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke?: (...args: any[]) => any;
  [key: string]: unknown;
}

/**
 * Pull the tool's argument object out of the handler call so the approval
 * request carries the real tool kwargs (symbol, quantity, …).
 *
 * - `invoke(runContext, input, details)` — the arguments are the SECOND arg,
 *   a JSON string (parse it) or already an object.
 * - `execute(parsedArgs, ctx)` — the arguments are the FIRST arg.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractKwargs(key: "execute" | "invoke", callArgs: any[]): Record<string, unknown> {
  if (key === "invoke") {
    const input = callArgs[1];
    if (typeof input === "string") {
      try {
        return JSON.parse(input) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
    return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  }
  const first = callArgs[0];
  return first && typeof first === "object" ? (first as Record<string, unknown>) : {};
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
    const original = toolDef[key];
    const gated: OpenAITool = {
      ...toolDef,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [key]: async (...callArgs: any[]) => {
        const { approved } = await gateCall(
          { name: toolName, description: toolDef.description },
          extractKwargs(key, callArgs),
          opts,
          "openai_agents",
        );
        if (!approved) {
          return { status: "cancelled", tool: toolName };
        }
        // Forward the original args untouched so the tool runs exactly as the
        // framework intended once approved.
        return original ? original(...callArgs) : undefined;
      },
    };
    return gated as T;
  };
}

export { ApprovalRunner } from "../core/runner";
