import { beforeEach, describe, expect, it } from "vitest";
import { ApprovalMiddleware } from "../src/adapters/approvalMiddleware";
import type { ApprovalClient, ApprovalCreator, CreateApprovalParams } from "../src/core/client";
import { gateCall } from "../src/core/gating";
import { ApprovalRunner } from "../src/core/runner";

class FakeClient implements ApprovalCreator {
  seen: CreateApprovalParams[] = [];
  async createApproval(params: any) {
    this.seen.push(params);
    return { approval_id: "appr_test", status: "pending" };
  }
}

/** An invoke() that calls a single gated tool, mimicking what an adapter does. */
function gatedInvoke(returnValue: unknown) {
  return async () => {
    const { approved } = await gateCall(
      { name: "purchase", description: "buy" },
      { symbol: "AAPL", quantity: 3 },
      { action: "purchase", args: ["symbol", "quantity"] },
      "test",
    );
    return approved ? returnValue : { status: "cancelled" };
  };
}

describe("ApprovalRunner", () => {
  let fake: FakeClient;

  beforeEach(() => {
    ApprovalMiddleware.reset();
    fake = new FakeClient();
    ApprovalMiddleware.setClient(fake as unknown as ApprovalClient);
  });

  it("returns pending_approval, then resumes to a complete result on approve", async () => {
    const runner = new ApprovalRunner({ invoke: gatedInvoke("bought"), timeout: 0.15 });

    const pending = await runner.run("t1", "buy AAPL");
    expect(pending.status).toBe("pending_approval");
    expect(pending.approval_id).toBe("appr_test");
    expect(runner.pending("t1")).toBe(true);

    // the tool only saw the whitelisted kwargs (fake client sees the raw payload,
    // before ApprovalClient flattens tool -> tool_name/tool_kwargs)
    expect((fake.seen[0]!.tool as any).kwargs).toEqual({ symbol: "AAPL", quantity: 3 });

    const ack = await runner.resume("t1", true, "appr_test");
    expect(["accepted", "complete"]).toContain(ack.status);

    const final = await runner.waitForResult("t1");
    expect(final.status).toBe("complete");
    expect(final.result).toBe("bought");
    expect(runner.pending("t1")).toBe(false);
  });

  it("returns a cancelled tool result when rejected", async () => {
    const runner = new ApprovalRunner({ invoke: gatedInvoke("bought"), timeout: 0.15 });
    await runner.run("t2", "buy AAPL");
    await runner.resume("t2", false);
    const final = await runner.waitForResult("t2");
    expect(final.status).toBe("complete");
    expect((final.result as any).status).toBe("cancelled");
  });

  it("ignores a duplicate resume (Slack retry) as already_resolved", async () => {
    const runner = new ApprovalRunner({ invoke: gatedInvoke("ok"), timeout: 0.15 });
    await runner.run("t3", "go");
    const first = await runner.resume("t3", true, "appr_test");
    expect(["accepted", "complete"]).toContain(first.status);
    const second = await runner.resume("t3", true, "appr_test");
    expect(second.status).toBe("already_resolved");
  });

  it("auto-approves without contacting the client when AEGMIS_APPROVAL is disabled", async () => {
    const prev = process.env.AEGMIS_APPROVAL;
    process.env.AEGMIS_APPROVAL = "false"; // default behaviour
    ApprovalMiddleware.reset();
    const local = new FakeClient();
    ApprovalMiddleware.setClient(local as unknown as ApprovalClient);
    try {
      const { approved } = await gateCall(
        { name: "purchase" },
        { symbol: "AAPL", quantity: 5 },
        {},
        "test",
      );
      expect(approved).toBe(true);
      expect(local.seen.length).toBe(0); // never sent a request to the backend
    } finally {
      process.env.AEGMIS_APPROVAL = prev;
    }
  });

  it("uses onApprovalAsync instead of the HTTP client when provided", async () => {
    ApprovalMiddleware.reset(); // ensure no HTTP client is available
    let asked: string | undefined;
    const runner = new ApprovalRunner({
      invoke: gatedInvoke("done"),
      timeout: 0.15,
      onApprovalAsync: async (threadId) => {
        asked = threadId;
        return { approval_id: "inline_1" };
      },
    });
    const pending = await runner.run("t4", "go");
    expect(asked).toBe("t4");
    expect(pending.approval_id).toBe("inline_1");
    await runner.resume("t4", true, "inline_1");
    const final = await runner.waitForResult("t4");
    expect(final.result).toBe("done");
  });
});
