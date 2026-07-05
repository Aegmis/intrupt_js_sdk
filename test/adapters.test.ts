import { beforeEach, describe, expect, it } from "vitest";
import { approvalRequired as vercelApproval } from "../src/adapters/vercelAi";
import { approvalRequired as mastraApproval } from "../src/adapters/mastra";
import { approvalRequired as openaiApproval } from "../src/adapters/openaiAgents";
import { gateHandler } from "../src/adapters/langchainTools";
import { ApprovalMiddleware } from "../src/adapters/approvalMiddleware";
import { approvalContext } from "../src/core/context";
import * as gate from "../src/core/gate";
import type { ApprovalClient, ApprovalCreator } from "../src/core/client";

class FakeClient implements ApprovalCreator {
  seen: any[] = [];
  async createApproval(params: any) {
    this.seen.push(params);
    return { approval_id: "a", status: "pending" };
  }
}

/** Run `fn` inside an approval context and auto-approve the gate it opens. */
async function withAutoApprove<T>(fn: () => Promise<T>): Promise<T> {
  return approvalContext.run({ threadId: "tt" }, async () => {
    const p = fn();
    // let the gate register, then approve
    await new Promise((r) => setTimeout(r, 10));
    const id = gate.getPending("tt");
    if (id) gate.resolve(id, true);
    return p;
  });
}

describe("adapter tool wrappers gate before executing", () => {
  let fake: FakeClient;
  beforeEach(() => {
    ApprovalMiddleware.reset();
    fake = new FakeClient();
    ApprovalMiddleware.setClient(fake as unknown as ApprovalClient);
  });

  it("Vercel AI SDK: wraps execute and forwards whitelisted args", async () => {
    let ran = false;
    const tool = vercelApproval({ action: "buy", args: ["symbol"] }, "purchase")({
      description: "buy",
      execute: async (a: any) => {
        ran = true;
        return { ok: a.symbol };
      },
    });
    const out = await withAutoApprove(() => (tool.execute as any)({ symbol: "AAPL", secret: "x" }));
    expect(ran).toBe(true);
    expect(out).toEqual({ ok: "AAPL" });
    expect(fake.seen[0].tool.kwargs).toEqual({ symbol: "AAPL" }); // secret filtered out
    expect(fake.seen[0].adapter).toBe("vercel_ai");
  });

  it("OpenAI Agents: reads the tool's own name", async () => {
    const tool = openaiApproval({ action: "buy" })({
      name: "purchase_stock",
      description: "buy",
      execute: async () => "done",
    });
    const out = await withAutoApprove(() => (tool.execute as any)({ symbol: "AAPL" }));
    expect(out).toBe("done");
    expect(fake.seen[0].tool.name).toBe("purchase_stock");
    expect(fake.seen[0].adapter).toBe("openai_agents");
  });

  it("Mastra: reads kwargs from context and uses id as the tool name", async () => {
    const tool = mastraApproval({ action: "buy" })({
      id: "purchase",
      description: "buy",
      execute: async ({ context }: any) => ({ bought: context.symbol }),
    });
    const out = await withAutoApprove(() => (tool.execute as any)({ context: { symbol: "TSLA" } }));
    expect(out).toEqual({ bought: "TSLA" });
    expect(fake.seen[0].tool.name).toBe("purchase");
    expect(fake.seen[0].tool.kwargs).toEqual({ symbol: "TSLA" });
  });

  it("LangChain gateHandler: gates a raw handler and returns cancelled on reject", async () => {
    const gated = gateHandler(
      async (a: any) => ({ ok: a.symbol }),
      { name: "purchase", description: "buy" },
      { action: "buy", args: ["symbol"] },
    );
    const out = await approvalContext.run({ threadId: "tt" }, async () => {
      const p = gated({ symbol: "AAPL" });
      await new Promise((r) => setTimeout(r, 10));
      gate.resolve(gate.getPending("tt")!, false);
      return p;
    });
    expect(out).toEqual({ status: "cancelled", tool: "purchase" });
  });
});
