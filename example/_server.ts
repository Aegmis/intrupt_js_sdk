/**
 * Shared Express server used by the HTTP-based examples. Exposes POST
 * /call-tool and POST /resume, mirroring `intrupt_py_sdk/example/agent.py`.
 *
 * Both `ApprovalRunner` and `ApprovalGraph` satisfy the {@link Runnerish}
 * interface, so every framework example reuses this same wiring — they differ
 * only in how they build the runner and (optionally) map the incoming message
 * into the framework's input shape via `inputFor`.
 *
 * Not part of the built library. Needs: `npm i express` (+ `-D @types/express`).
 */
import crypto from "node:crypto";
import express from "express";

export interface Runnerish {
  run(threadId: string, input: unknown): Promise<Record<string, unknown>>;
  resume(threadId: string, approved: boolean, approvalId?: string): Promise<Record<string, unknown>>;
  waitForResult(threadId: string, timeout?: number): Promise<Record<string, unknown>>;
  pending(threadId: string): boolean;
}

export interface ServerOptions {
  port: number;
  resumeSecret?: string;
  /** Map the incoming `message` string into the framework's input. Default: identity. */
  inputFor?: (message: string) => unknown;
}

export function startApprovalServer(runner: Runnerish, opts: ServerOptions): void {
  const resumeSecret = opts.resumeSecret ?? "";
  const inputFor = opts.inputFor ?? ((m: string) => m);

  const app = express();
  app.use(express.json());

  app.post("/call-tool", async (req, res) => {
    const message = req.body?.message;
    if (!message) return res.status(400).json({ detail: "'message' required" });

    const threadId: string = req.body?.thread_id ?? crypto.randomUUID();
    if (req.body?.thread_id && runner.pending(threadId)) {
      return res.status(409).json({
        detail: "thread has a pending approval — approve or reject before sending new messages",
      });
    }

    const result = await runner.run(threadId, inputFor(message));
    if (result.status === "error") {
      return res.status((result.status_code as number) ?? 502).json({ detail: result.error });
    }
    res.json(result);
  });

  app.post("/resume", async (req, res) => {
    // Constant-time compare so the secret can't be recovered via response timing.
    if (resumeSecret) {
      const got = req.header("X-Agent-Secret") ?? "";
      const ok =
        got.length === resumeSecret.length &&
        crypto.timingSafeEqual(Buffer.from(got), Buffer.from(resumeSecret));
      if (!ok) return res.status(401).json({ detail: "missing or invalid X-Agent-Secret" });
    }

    const { thread_id, approved, approval_id } = req.body ?? {};
    if (!thread_id) return res.status(400).json({ detail: "thread_id required" });
    if (approved === undefined) return res.status(400).json({ detail: "approved required" });
    if (!runner.pending(thread_id)) {
      return res.status(409).json({
        detail: "thread is not paused on an approval (no pending gate or already decided)",
      });
    }

    let result = await runner.resume(thread_id, Boolean(approved), approval_id ?? "");
    if (result.status === "accepted") {
      result = await runner.waitForResult(thread_id);
    }
    res.json(result);
  });

  app.listen(opts.port, () => console.log(`agent listening on :${opts.port}`));
}

/** Resolve the public URL + resume secret shared by all HTTP examples. */
export function agentConfig() {
  const publicUrl = process.env.AGENT_PUBLIC_URL ?? "http://localhost:8081";
  return {
    publicUrl,
    port: Number(new URL(publicUrl).port || 8082),
    resumeSecret: process.env.AGENT_RESUME_SECRET ?? "",
  };
}
