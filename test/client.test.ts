import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalApiError, ApprovalClient, errorStatusCode, userFacingError } from "../src/core/client";

const VALID_KEY = "sk_org_org_abcd1234_0123456789abcdef";

describe("ApprovalClient org-id extraction", () => {
  it("extracts org_id from a valid key", () => {
    const c = new ApprovalClient({ baseUrl: "http://x", apiKey: VALID_KEY });
    // endpoint is derived from org id — assert indirectly via createApproval below
    expect(c.baseUrl).toBe("http://x");
  });

  it("throws when the key is missing", () => {
    expect(() => new ApprovalClient({ baseUrl: "http://x" })).toThrow(/API key is required/);
  });

  it("throws on a malformed key", () => {
    expect(() => new ApprovalClient({ baseUrl: "http://x", apiKey: "nope" })).toThrow(/Invalid API key format/);
  });
});

describe("ApprovalClient.createApproval", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the org-scoped endpoint with the snake_case body", async () => {
    let capturedUrl = "";
    let capturedBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any) => {
        capturedUrl = url;
        capturedBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ approval_id: "a1", status: "pending" }), { status: 200 });
      }),
    );

    const c = new ApprovalClient({ baseUrl: "http://api", apiKey: VALID_KEY });
    const res = await c.createApproval({
      thread_id: "t1",
      action: "buy",
      message: "Approve?",
      channel: "slack",
      tool: { name: "purchase", description: "buy stock", kwargs: { symbol: "AAPL" } },
      agent_callback_url: "http://agent/resume",
      adapter: "vercel_ai",
    });

    expect(capturedUrl).toBe("http://api/org/org_abcd1234/approval");
    expect(capturedBody.tool_name).toBe("purchase");
    expect(capturedBody.tool_kwargs).toEqual({ symbol: "AAPL" });
    expect(capturedBody.agent_callback_url).toBe("http://agent/resume");
    expect(capturedBody.adapter).toBe("vercel_ai");
    // reserved fields must not be duplicated/overwritten by metadata
    expect(capturedBody.tool).toBeUndefined();
    expect(res.approval_id).toBe("a1");
  });

  it("raises ApprovalApiError carrying the upstream status + detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: "unsupported channel", request_id: "rid-1" }), { status: 422 }),
      ),
    );
    const c = new ApprovalClient({ baseUrl: "http://api", apiKey: VALID_KEY });
    await expect(
      c.createApproval({ thread_id: "t1", action: "buy", message: "m", channel: "email", tool: {} }),
    ).rejects.toMatchObject({ statusCode: 422, detail: "unsupported channel", requestId: "rid-1" });
  });
});

describe("error helpers", () => {
  it("userFacingError returns the bare detail for an ApprovalApiError", () => {
    expect(userFacingError(new ApprovalApiError(422, "bad channel", "rid"))).toBe("bad channel");
    expect(userFacingError(new Error("boom"))).toBe("boom");
  });

  it("errorStatusCode surfaces the upstream status, else 500", () => {
    expect(errorStatusCode(new ApprovalApiError(422, "x"))).toBe(422);
    expect(errorStatusCode(new Error("x"))).toBe(500);
  });
});
