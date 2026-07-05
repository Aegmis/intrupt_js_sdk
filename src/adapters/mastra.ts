/**
 * Mastra adapter for intrupt human-in-the-loop approvals.
 *
 * Mastra tools are created with `createTool({ id, description, inputSchema,
 * execute })`, where `execute` receives `{ context }` — `context` being the
 * validated tool input. Gating wraps `execute`: it reads `context` as the tool
 * kwargs, POSTs to the approval API, and suspends until the human decides.
 *
 * Install (peer dep): `npm i @mastra/core`
 *
 * Usage
 * -----
 * ```ts
 * import { createTool } from "@mastra/core/tools";
 * import { z } from "zod";
 * import { approvalRequired } from "intrupt-js-sdk/mastra";
 * import { ApprovalMiddleware } from "intrupt-js-sdk";
 *
 * ApprovalMiddleware.configure();
 *
 * const purchaseStock = approvalRequired({
 *   action: "purchase_stock", message: "Approve stock purchase?", channel: "slack", args: ["symbol", "quantity"],
 * })(createTool({
 *   id: "purchase_stock",
 *   description: "Buy shares of a stock.",
 *   inputSchema: z.object({ symbol: z.string(), quantity: z.number() }),
 *   // current Mastra passes the input as the first arg:
 *   execute: async (inputData) => ({ status: "success", ...inputData }),
 * }));
 * ```
 */
import { gateCall, type ApprovalOptions } from "../core/gating";

/**
 * Minimal structural type for a Mastra tool.
 *
 * `execute` is typed loosely (`(...args: any[]) => any`) on purpose: Mastra has
 * changed its tool-execute signature across versions —
 *   - legacy  : `execute({ context, ... })`            (input on `.context`)
 *   - current : `execute(inputData, executionContext)` (input is the 1st arg)
 * A strict single-arg type only matched the legacy API and made current
 * `@mastra/core` tools fail to type-check. The loose type keeps the wrapper
 * assignable to any `@mastra/core` version.
 */
interface MastraTool {
  id?: string;
  description?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute?: (...args: any[]) => any;
}

/**
 * Wrap a Mastra tool so it pauses for human approval before executing. The
 * tool's `id` is used as the approval tool name.
 *
 * `execute` is swapped **in place** so the returned value is still the original
 * Mastra `Tool` instance — preserving its class prototype/identity. A spread
 * clone (`{ ...toolDef }`) would drop the prototype and also fail to satisfy the
 * `Tool` class's structural type.
 */
export function approvalRequired(opts: ApprovalOptions) {
  return function wrap<T extends MastraTool>(toolDef: T): T {
    const toolName = toolDef.id ?? opts.action ?? "tool";
    const original = toolDef.execute?.bind(toolDef);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toolDef.execute = async (...args: any[]) => {
      // Extract the tool input across Mastra versions:
      //   current (2-arg): execute(inputData, executionContext) → input = args[0]
      //   legacy  (1-arg): execute({ context, ... })            → input = args[0].context
      // Distinguish by arg count so both conventions keep working.
      const first = (args[0] ?? {}) as Record<string, unknown>;
      const kwargs = (args.length >= 2
        ? first
        : ((first.context as Record<string, unknown>) ?? first)) ?? {};
      const { approved } = await gateCall(
        { name: toolName, description: toolDef.description },
        kwargs,
        opts,
        "mastra",
      );
      if (!approved) {
        // Give the LLM a clear reason so it reports a decline, not a vague error.
        return {
          status: "cancelled",
          tool: toolName,
          message: `The "${toolName}" action was not approved, so it did not run.`,
        };
      }
      // Forward the ORIGINAL args untouched so the wrapped tool receives
      // exactly what its Mastra version expects (1-arg or 2-arg).
      return original ? original(...args) : undefined;
    };
    return toolDef;
  };
}

export { ApprovalRunner } from "../core/runner";
