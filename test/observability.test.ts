import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalCreator } from "../src/core/client";
import * as gate from "../src/core/gate";
import {
  initObservability,
  shutdownObservability,
  startRecord,
} from "../src/core/observability";

interface Sent {
  path: string;
  body: Record<string, unknown>;
}

let sent: Sent[];

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      sent.push({
        path: new URL(String(url)).pathname,
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return new Response('{"ok":true}', { status: 200 });
    }),
  );
  vi.stubEnv("AEGMIS_API_KEY", "sk_org_org_test1234_abcdef0123456789");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function flush() {
  await shutdownObservability();
}

describe("observability lifecycle", () => {
  it("posts pending (with org from API key) then resolve", async () => {
    initObservability("http://obs:8090/", { serviceName: "js-agent" });
    const rec = startRecord("pay_invoice", "langgraph", "pay_invoice", "thr-1");
    rec.requested("appr-1", {
      message: "ok?",
      channel: "slack",
      tool: { name: "pay_invoice", kwargs: { amount: 4500 } },
    });
    rec.finish("approved");
    await flush();

    expect(sent.map((s) => s.path)).toEqual(["/v1/pending", "/v1/resolve"]);
    const pending = sent[0].body;
    expect(pending.approval_id).toBe("appr-1");
    expect(pending.org_id).toBe("org_test1234"); // self-identified from the API key
    expect(pending.service).toBe("js-agent");
    expect(pending.kwargs).toEqual({ amount: 4500 });
    const resolve = sent[1].body;
    expect(resolve.status).toBe("approved");
    expect(typeof resolve.wait_s).toBe("number");
  });

  it("records auto-decided calls keyed by audit_id as 'audited' with a reason", async () => {
    initObservability("http://obs:8090");
    const rec = startRecord("purchase_stock", "langgraph", "purchase_stock", "thr-2");
    // gate stashes these on the payload for non-pending create responses:
    rec.requested("", {
      _auto_status: "approved",
      _audit_id: "aud-77",
      _policy_eval: { policy_id: "p1", matched: false },
      tool: { name: "purchase_stock", kwargs: { amount: 1200 } },
    });
    rec.finish("approved");
    await flush();

    expect(sent[0].body.approval_id).toBe("aud-77");
    expect(sent[0].body.policy_eval).toEqual({ policy_id: "p1", matched: false });
    expect(sent[1].body.status).toBe("audited");
    expect(sent[1].body.reason).toMatch(/auto-approved by policy/);
  });

  it("is a no-op when unconfigured or disabled", async () => {
    initObservability(undefined);
    startRecord("t", "a", "x", "th").requested("appr", {});
    await flush();
    expect(sent).toHaveLength(0);

    vi.stubEnv("AEGMIS_ENABLE_TRACING", "false");
    initObservability("http://obs:8090");
    startRecord("t", "a", "x", "th").requested("appr", {});
    await flush();
    expect(sent).toHaveLength(0);
  });

  it("never throws when the endpoint is down (fail-open)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))));
    initObservability("http://down:1");
    const rec = startRecord("t", "a", "x", "th");
    expect(() => rec.requested("appr", {})).not.toThrow();
    expect(() => rec.finish("approved")).not.toThrow();
    await flush();
  });
});

describe("gate stashing for observability", () => {
  function fakeClient(result: Record<string, unknown>): ApprovalCreator {
    return { createApproval: async () => result as never };
  }

  it("stashes policy_eval on pending responses", async () => {
    const payload: Record<string, unknown> = { action: "buy" };
    await gate.requestApproval(
      fakeClient({ approval_id: "a9", status: "pending", policy_eval: { matched: true } }),
      "s9",
      payload,
    );
    expect(payload._policy_eval).toEqual({ matched: true });
    gate.resolve("a9", true); // clean up the pending registry
  });

  it("stashes _auto_status + _audit_id on auto-decided responses", async () => {
    const payload: Record<string, unknown> = { action: "buy" };
    const { approvalId, future } = await gate.requestApproval(
      fakeClient({ status: "approved", audit_id: "aud-1" }),
      "s10",
      payload,
    );
    expect(approvalId).toBe("");
    await expect(future).resolves.toBe(true);
    expect(payload._auto_status).toBe("approved");
    expect(payload._audit_id).toBe("aud-1");
  });
});
