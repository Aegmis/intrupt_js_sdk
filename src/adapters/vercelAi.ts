/**
 * Vercel AI SDK adapter for intrupt human-in-the-loop approvals.
 *
 * Vercel AI SDK tools are plain objects created with `tool({ description,
 * parameters, execute })`. Gating wraps `execute`: before the real logic runs,
 * it POSTs to the approval API and suspends until the human decides.
 *
 * Install (peer dep): `npm i ai`
 *
 * Usage
 * -----
 * ```ts
 * import { tool } from "ai";
 * import { z } from "zod";
 * import { approvalRequired } from "intrupt-js-sdk/vercel";
 * import { ApprovalMiddleware, ApprovalRunner } from "intrupt-js-sdk";
 *
 * ApprovalMiddleware.configure({ baseUrl: process.env.AEGMIS_BASE_URL, apiKey: process.env.AEGMIS_API_KEY });
 *
 * const purchaseStock = approvalRequired(
 *   { action: "purchase_stock", message: "Approve buying shares", channel: "slack", args: ["symbol", "quantity"] },
 *   "purchase_stock",
 * )(tool({
 *   description: "Purchase a quantity of a stock symbol.",
 *   parameters: z.object({ symbol: z.string(), quantity: z.number() }),
 *   execute: async ({ symbol, quantity }) => ({ status: "success", symbol, quantity }),
 * }));
 *
 * const runner = new ApprovalRunner({
 *   callbackUrl: "http://localhost:8081/resume",
 *   invoke: (input) =>
 *     generateText({ model, tools: { purchaseStock }, prompt: String(input) }),
 *   formatResult: (raw, threadId) => ({ status: "complete", thread_id: threadId, result: (raw as any).text }),
 * });
 * ```
 */
import { gateCall, type ApprovalOptions } from "../core/gating";

/** Minimal structural type for a Vercel AI SDK tool — avoids a hard dep on `ai`. */
interface VercelTool {
  description?: string;
  execute?: (args: Record<string, unknown>, ctx?: unknown) => unknown;
  [key: string]: unknown;
}

/**
 * Wrap a Vercel AI SDK tool so it pauses for human approval before executing.
 *
 * @param opts  Approval options (action/message/channel/args).
 * @returns A function taking the tool object (and an optional explicit name,
 *          since Vercel tools are keyed in a record and carry no `name` field)
 *          and returning a gated copy.
 */
export function approvalRequired(opts: ApprovalOptions, name?: string) {
  return function wrap<T extends VercelTool>(toolDef: T): T {
    const toolName = name ?? opts.action ?? "tool";
    const original = toolDef.execute;
    return {
      ...toolDef,
      execute: async (args: Record<string, unknown>, ctx?: unknown) => {
        const { approved } = await gateCall(
          { name: toolName, description: toolDef.description },
          args ?? {},
          opts,
          "vercel_ai",
        );
        if (!approved) {
          return { status: "cancelled", tool: toolName, message: `${toolName} was not approved` };
        }
        return original ? original(args, ctx) : undefined;
      },
    };
  };
}

export { ApprovalRunner } from "../core/runner";
