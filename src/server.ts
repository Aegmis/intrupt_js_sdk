/**
 * OPTIONAL zero-dependency HTTP server exposing POST /call-tool and POST /resume
 * for an ApprovalRunner (or ApprovalGraph). Built on Node's `http` module — no
 * express, no extra dependencies.
 *
 * This is a convenience. You are free to wire the two endpoints into your own
 * server (express, fastify, Next.js route handlers, …) instead — the runner only
 * needs `run` / `resume` / `waitForResult` / `pending`.
 *
 * ```ts
 * import { ApprovalRunner } from "intrupt-js-sdk";
 * import { createApprovalServer } from "intrupt-js-sdk/server";
 *
 * const runner = new ApprovalRunner({ ...  });
 * createApprovalServer({ runner }); // port + secret default from AGENT_PUBLIC_URL / AGENT_RESUME_SECRET
 * ```
 */
import http from "node:http";
import crypto from "node:crypto";

/** The subset of ApprovalRunner / ApprovalGraph this server needs. */
export interface ApprovalServerRunner {
  run(threadId: string, input: unknown): Promise<Record<string, unknown>>;
  resume(threadId: string, approved: boolean, approvalId?: string): Promise<Record<string, unknown>>;
  waitForResult(threadId: string, timeout?: number): Promise<Record<string, unknown>>;
  pending(threadId: string): boolean;
}

export interface ApprovalServerOptions {
  runner: ApprovalServerRunner;
  /** Port to listen on. Defaults to the port in AGENT_PUBLIC_URL, else 8081. */
  port?: number;
  /** Shared secret verified as X-Agent-Secret on /resume. Defaults to AGENT_RESUME_SECRET. */
  resumeSecret?: string;
  /** Map the incoming `message` string into the framework's input. Default: identity. */
  inputFor?: (message: string) => unknown;
  /** Log [call-tool] / [resume] lifecycle lines. Default: true. */
  log?: boolean;
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("payload too large"));
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body) as Record<string, unknown>);
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

/** Resolve the listen port + resume secret from env. */
function envDefaults(): { port: number; resumeSecret: string } {
  const publicUrl = process.env.AGENT_PUBLIC_URL ?? "http://localhost:8081";
  let port = 8081;
  try {
    port = Number(new URL(publicUrl).port || 8081);
  } catch {
    /* keep default */
  }
  return { port, resumeSecret: process.env.AGENT_RESUME_SECRET ?? "" };
}

/**
 * Start an HTTP server exposing POST /call-tool and POST /resume for `runner`.
 * Returns the underlying `http.Server` — call `.close()` to stop it.
 */
export function createApprovalServer(opts: ApprovalServerOptions): http.Server {
  const defaults = envDefaults();
  const { runner } = opts;
  const port = opts.port ?? defaults.port;
  const resumeSecret = opts.resumeSecret ?? defaults.resumeSecret;
  const inputFor = opts.inputFor ?? ((m: string) => m as unknown);
  const log = opts.log ?? true;
  const say = (...args: unknown[]): void => {
    if (log) console.log(...args);
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== "POST") return send(res, 405, { detail: "method not allowed" });
      const url = (req.url ?? "").split("?")[0];

      if (url === "/call-tool") {
        const body = await readJson(req);
        const message = body.message;
        if (!message) return send(res, 400, { detail: "'message' required" });
        const threadId = (body.thread_id as string) ?? crypto.randomUUID();
        say(`[call-tool] thread=${threadId} message=${JSON.stringify(message)}`);
        if (body.thread_id && runner.pending(threadId)) {
          return send(res, 409, {
            detail: "thread has a pending approval — approve or reject before sending new messages",
          });
        }
        const result = await runner.run(threadId, inputFor(message as string));
        if (result.status === "error") {
          say(`[call-tool] thread=${threadId} ERROR: ${result.error}`);
          return send(res, (result.status_code as number) ?? 502, { detail: result.error });
        }
        say(
          `[call-tool] thread=${threadId} -> ${result.status}` +
            (result.approval_id ? ` (approval_id=${result.approval_id})` : ""),
        );
        return send(res, 200, result);
      }

      if (url === "/resume") {
        const body = await readJson(req);
        say(
          `[resume] callback received: thread=${body.thread_id} approved=${body.approved}` +
            ` approval_id=${body.approval_id}`,
        );
        if (resumeSecret) {
          const got = (req.headers["x-agent-secret"] as string) ?? "";
          const ok =
            got.length === resumeSecret.length &&
            crypto.timingSafeEqual(Buffer.from(got), Buffer.from(resumeSecret));
          if (!ok) {
            say("[resume] REJECTED: missing or invalid X-Agent-Secret");
            return send(res, 401, { detail: "missing or invalid X-Agent-Secret" });
          }
        }
        const threadId = body.thread_id as string;
        const approved = body.approved as boolean | undefined;
        if (!threadId) return send(res, 400, { detail: "thread_id required" });
        if (approved === undefined) return send(res, 400, { detail: "approved required" });
        if (!runner.pending(threadId)) {
          say(`[resume] no pending gate for thread=${threadId} (already decided or unknown)`);
          return send(res, 409, {
            detail: "thread is not paused on an approval (no pending gate or already decided)",
          });
        }
        let result = await runner.resume(threadId, Boolean(approved), (body.approval_id as string) ?? "");
        if (result.status === "accepted") result = await runner.waitForResult(threadId);
        say(
          `[resume] thread=${threadId} ${approved ? "APPROVED" : "REJECTED"} -> ${result.status}` +
            (result.result !== undefined ? `: ${JSON.stringify(result.result)}` : ""),
        );
        return send(res, 200, result);
      }

      return send(res, 404, { detail: "not found" });
    } catch (err) {
      send(res, 400, { detail: err instanceof Error ? err.message : "bad request" });
    }
  });

  server.listen(port, () => {
    const addr = server.address();
    say(`agent listening on :${addr && typeof addr === "object" ? addr.port : port}`);
  });
  return server;
}
