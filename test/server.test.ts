import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createApprovalServer, type ApprovalServerRunner } from "../src/server";

class FakeRunner implements ApprovalServerRunner {
  private paused = new Set<string>();
  async run(threadId: string) {
    this.paused.add(threadId);
    return { status: "pending_approval", approval_id: "appr_1", thread_id: threadId };
  }
  async resume(threadId: string) {
    this.paused.delete(threadId);
    return { status: "accepted" };
  }
  async waitForResult() {
    return { status: "complete", result: "done" };
  }
  pending(threadId: string) {
    return this.paused.has(threadId);
  }
}

describe("createApprovalServer", () => {
  it("drives /call-tool -> pending_approval and /resume -> complete (with secret check)", async () => {
    const runner = new FakeRunner();
    const server = createApprovalServer({ runner, port: 0, resumeSecret: "s3cret", log: false });
    await new Promise<void>((res) => (server.listening ? res() : server.once("listening", () => res())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

    try {
      const call = await post("/call-tool", { message: "buy 10 AAPL", thread_id: "t1" });
      expect((await call.json()).status).toBe("pending_approval");
      expect(runner.pending("t1")).toBe(true);

      const bad = await post("/resume", { thread_id: "t1", approved: true }, { "X-Agent-Secret": "wrong" });
      expect(bad.status).toBe(401);

      const ok = await post("/resume", { thread_id: "t1", approved: true, approval_id: "appr_1" }, { "X-Agent-Secret": "s3cret" });
      const okBody = await ok.json();
      expect(okBody.status).toBe("complete");
      expect(okBody.result).toBe("done");
    } finally {
      server.close();
    }
  });
});
