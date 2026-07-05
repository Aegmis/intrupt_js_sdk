/**
 * Holds a process-wide {@link ApprovalClient} so gated tools can reach the API
 * without threading config through every call site. Port of
 * `adapters/approval_middleware.py`.
 *
 * Singleton on first construction; subsequent constructions are no-ops so that
 * re-importing the module (or instantiating from multiple call sites) does not
 * silently re-point the shared client.
 */
import { ApprovalClient, type ApprovalClientOptions, type ApprovalCreator } from "../core/client";

export class ApprovalMiddleware {
  private static instance: ApprovalMiddleware | undefined;
  readonly client: ApprovalClient;

  private constructor(options: ApprovalClientOptions) {
    this.client = new ApprovalClient(options);
  }

  /**
   * Initialise the shared client once at startup. Idempotent: calling it again
   * returns the existing singleton without re-pointing the client.
   */
  static configure(options: ApprovalClientOptions = {}): ApprovalMiddleware {
    if (!ApprovalMiddleware.instance) {
      ApprovalMiddleware.instance = new ApprovalMiddleware({
        baseUrl: options.baseUrl ?? process.env.APPROVAL_BASE_URL,
        apiKey: options.apiKey ?? process.env.APPROVAL_API_KEY,
        timeout: options.timeout,
      });
    }
    return ApprovalMiddleware.instance;
  }

  static getClient(): ApprovalClient {
    if (!ApprovalMiddleware.instance) {
      throw new Error(
        "ApprovalMiddleware not initialised — call ApprovalMiddleware.configure({ baseUrl, apiKey }) " +
          "once at startup before invoking a gated tool.",
      );
    }
    return ApprovalMiddleware.instance.client;
  }

  /**
   * Replace the singleton with a pre-built client. Accepts any
   * {@link ApprovalCreator} (only `createApproval` is required), so a local /
   * policy approver can be installed to decide approvals in-process — no
   * approval API, Slack, or `/resume` server. Useful for tests and for driving
   * gated tools directly (e.g. inside the Mastra studio).
   */
  static setClient(client: ApprovalClient | ApprovalCreator): void {
    ApprovalMiddleware.instance = Object.create(ApprovalMiddleware.prototype);
    (ApprovalMiddleware.instance as { client: ApprovalCreator }).client = client;
  }

  /** Test hook: drop the singleton so the next configure() rebuilds it. */
  static reset(): void {
    ApprovalMiddleware.instance = undefined;
  }
}
