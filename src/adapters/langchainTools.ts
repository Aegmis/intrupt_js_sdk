/**
 * LangChain.js tools adapter for intrupt human-in-the-loop approvals.
 *
 * LangChain tools are `Runnable` instances built with
 * `tool(fn, { name, description, schema })` from `@langchain/core/tools` — not
 * plain objects — so there are two gating paths:
 *
 *   1. {@link gateHandler} (recommended): wrap the raw handler *before* you pass
 *      it to `tool(...)`. Robust and framework-version-proof.
 *   2. {@link approvalRequired}: wrap an already-built tool instance. Convenient
 *      when you only have the constructed tool; clones it and overrides `invoke`.
 *
 * Install (peer dep): `npm i @langchain/core`
 *
 * Usage
 * -----
 * ```ts
 * import { tool } from "@langchain/core/tools";
 * import { z } from "zod";
 * import { gateHandler } from "intrupt-js-sdk/langchain";
 *
 * const purchaseStock = tool(
 *   gateHandler(
 *     async ({ symbol, quantity }) => ({ status: "success", symbol, quantity }),
 *     { name: "purchase_stock", description: "Buy shares." },
 *     { action: "purchase_stock", message: "Approve buying shares", channel: "slack", args: ["symbol", "quantity"] },
 *   ),
 *   {
 *     name: "purchase_stock",
 *     description: "Buy shares.",
 *     schema: z.object({ symbol: z.string(), quantity: z.number() }),
 *   },
 * );
 * ```
 */
import { gateCall, type ApprovalOptions, type ToolMeta } from "../core/gating";

const CANCELLED = "__intrupt_cancelled__";

/**
 * Wrap a raw async tool handler so it pauses for human approval before running.
 * Pass the returned function to `tool(gated, { name, description, schema })`.
 */
export function gateHandler<Args extends Record<string, unknown>, R>(
  handler: (args: Args, config?: unknown) => R | Promise<R>,
  meta: ToolMeta,
  opts: ApprovalOptions,
): (args: Args, config?: unknown) => Promise<R | { status: string; tool: string }> {
  return async (args: Args, config?: unknown) => {
    const { approved } = await gateCall(meta, args ?? {}, opts, "langchain");
    if (!approved) {
      return { status: "cancelled", tool: meta.name };
    }
    return handler(args, config);
  };
}

/** Structural type for a LangChain tool instance (a Runnable). */
interface LangChainToolInstance {
  name: string;
  description?: string;
  invoke: (input: unknown, config?: unknown) => Promise<unknown>;
  [key: string]: unknown;
}

/**
 * Wrap an already-built LangChain tool instance. Returns a clone whose `invoke`
 * gates the call. Prefer {@link gateHandler} when you control tool construction.
 *
 * Handles both call conventions LangGraph's `ToolNode` uses: a raw args object,
 * or a ToolCall `{ name, args, id, type: "tool_call" }`.
 */
export function approvalRequired(opts: ApprovalOptions) {
  return function wrap<T extends LangChainToolInstance>(toolInstance: T): T {
    const name = toolInstance.name;
    const description = toolInstance.description;
    const originalInvoke = toolInstance.invoke.bind(toolInstance);

    // Prototype clone: inherits every Runnable method/field; we only shadow invoke.
    const gated = Object.create(toolInstance) as T;
    gated.invoke = async (input: unknown, config?: unknown) => {
      const args = extractArgs(input);
      const { approved } = await gateCall({ name, description }, args, opts, "langchain");
      if (!approved) {
        return JSON.stringify({ status: "cancelled", tool: name });
      }
      return originalInvoke(input, config);
    };
    return gated;
  };
}

function extractArgs(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object") {
    const maybeToolCall = input as { args?: unknown };
    if (maybeToolCall.args && typeof maybeToolCall.args === "object") {
      return maybeToolCall.args as Record<string, unknown>;
    }
    return input as Record<string, unknown>;
  }
  return { input };
}

export { CANCELLED };
export { ApprovalRunner } from "../core/runner";
