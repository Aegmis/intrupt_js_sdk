import { describe, expect, it } from "vitest";
import type { ApprovalCreator } from "../src/core/client";
import * as gate from "../src/core/gate";

function fakeClient(result: { approval_id?: string; status?: string }): ApprovalCreator {
  return { createApproval: async () => result };
}

describe("gate", () => {
  it("registers a pending future and resolves it via resolve()", async () => {
    const { approvalId, future } = await gate.requestApproval(
      fakeClient({ approval_id: "a1", status: "pending" }),
      "s1",
      { action: "buy" },
    );
    expect(approvalId).toBe("a1");
    expect(gate.getPending("s1")).toBe("a1");
    expect(gate.isPending("a1")).toBe(true);

    const resolved = gate.resolve("a1", true);
    expect(resolved).toBe(true);
    await expect(future).resolves.toBe(true);
    // session mapping is cleared after resolve
    expect(gate.getPending("s1")).toBeUndefined();
    expect(gate.isPending("a1")).toBe(false);
  });

  it("auto-approves without registering when status != pending", async () => {
    const { approvalId, future } = await gate.requestApproval(
      fakeClient({ approval_id: "a2", status: "approved" }),
      "s2",
      { action: "buy" },
    );
    expect(approvalId).toBe("a2");
    await expect(future).resolves.toBe(true);
    expect(gate.getPending("s2")).toBeUndefined();
  });

  it("propagates a rejection as future=false", async () => {
    const { future } = await gate.requestApproval(
      fakeClient({ approval_id: "a3", status: "pending" }),
      "s3",
      { action: "buy" },
    );
    gate.resolve("a3", false);
    await expect(future).resolves.toBe(false);
  });

  it("resolve() returns false for an unknown or already-resolved approval", () => {
    expect(gate.resolve("missing", true)).toBe(false);
  });

  it("fires pending callbacks when a session goes pending", async () => {
    let fired = false;
    gate.registerPendingCallback("s4", () => {
      fired = true;
    });
    await gate.requestApproval(fakeClient({ approval_id: "a4", status: "pending" }), "s4", { action: "buy" });
    expect(fired).toBe(true);
    gate.unregisterPendingCallbacks("s4");
    gate.resolve("a4", true);
  });
});
