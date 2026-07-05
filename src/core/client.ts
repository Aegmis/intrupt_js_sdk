/**
 * HTTP client for the intrupt approval API. Port of `core/client.py`.
 *
 * Uses the built-in `fetch` (Node >=18) instead of httpx — no runtime HTTP
 * dependency. Wire field names stay snake_case so the server contract is
 * identical to the Python SDK.
 */

/** Approval creator interface shared by {@link ApprovalClient} and the
 * inline `onApprovalAsync` wrapper. `gate.requestApproval` only needs this. */
export interface ApprovalCreator {
  createApproval(
    params: { thread_id: string } & Record<string, unknown>,
  ): Promise<CreateApprovalResult>;
}

export interface CreateApprovalResult {
  approval_id?: string;
  status?: string;
  [key: string]: unknown;
}

export interface ToolPayload {
  name?: string;
  description?: string;
  kwargs?: Record<string, unknown>;
}

export interface CreateApprovalParams {
  thread_id: string;
  action: string;
  message: string;
  channel: string;
  tool: ToolPayload;
  agent_callback_url?: string;
  agent_callback_secret?: string;
  /** Extra metadata (e.g. `adapter`) merged into the request body. */
  [key: string]: unknown;
}

/**
 * Raised when the approval API returns a non-2xx response.
 *
 * Mirrors `ApprovalAPIError` in the Python SDK: carries the upstream HTTP
 * status so an agent endpoint can propagate it instead of a misleading 200.
 */
export class ApprovalApiError extends Error {
  readonly statusCode: number;
  readonly detail: string;
  readonly requestId?: string;

  constructor(statusCode: number, detail: string, requestId?: string) {
    const rid = requestId ? ` [request_id=${requestId}]` : "";
    super(`Approval API error ${statusCode}: ${detail}${rid}`);
    this.name = "ApprovalApiError";
    this.statusCode = statusCode;
    this.detail = detail;
    this.requestId = requestId;
  }
}

/**
 * Concise error string for agent/user responses. For an {@link ApprovalApiError}
 * returns just the API detail (no status-code prefix, no request_id suffix).
 */
export function userFacingError(err: unknown): string {
  if (err instanceof ApprovalApiError) return err.detail;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * HTTP status an endpoint should surface for `err`. For an {@link ApprovalApiError}
 * this is the upstream approval-API status (e.g. 422); anything else is 500.
 */
export function errorStatusCode(err: unknown): number {
  const code = (err as { statusCode?: unknown })?.statusCode;
  return typeof code === "number" ? code : 500;
}

/** These fields are set explicitly and must not be overwritten by metadata. */
const RESERVED_FIELDS: ReadonlySet<string> = new Set([
  "thread_id",
  "action",
  "message",
  "channel",
  "tool_name",
  "tool_description",
  "tool_kwargs",
  "agent_callback_url",
  "agent_callback_secret",
  "tool",
]);

async function raiseForStatus(response: Response): Promise<void> {
  if (response.ok) return;
  let detail: string;
  let requestId: string | undefined;
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { detail?: string; request_id?: string };
    detail = body.detail ?? text.slice(0, 300);
    requestId = body.request_id;
  } catch {
    detail = text.slice(0, 300);
    requestId = response.headers.get("x-request-id") ?? undefined;
  }
  throw new ApprovalApiError(response.status, detail, requestId);
}

export interface ApprovalClientOptions {
  baseUrl?: string;
  apiKey?: string;
  /** Per-request timeout in seconds. Default 10. */
  timeout?: number;
}

export class ApprovalClient implements ApprovalCreator {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly timeout: number;
  private readonly orgId: string;

  constructor(options: ApprovalClientOptions = {}) {
    const baseUrl = options.baseUrl ?? process.env.APPROVAL_BASE_URL ?? "";
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? process.env.APPROVAL_API_KEY;
    this.timeout = options.timeout ?? 10;
    this.orgId = this.extractOrgIdFromApiKey();
  }

  /**
   * Extract org_id from API key format: `sk_org_{org_id}_{hash}`.
   * Example: `sk_org_org_0819dfb9_<hash>` → `org_0819dfb9`.
   */
  private extractOrgIdFromApiKey(): string {
    if (!this.apiKey) {
      throw new Error("API key is required but not provided");
    }
    if (!this.apiKey.startsWith("sk_org_")) {
      throw new Error(
        `Invalid API key format. Expected 'sk_org_{org_id}_{hash}', got '${this.apiKey.slice(0, 20)}...'`,
      );
    }
    const afterPrefix = this.apiKey.slice(7); // strip "sk_org_"
    const lastUnderscore = afterPrefix.lastIndexOf("_");
    if (lastUnderscore === -1) {
      throw new Error(
        `Invalid API key format. Expected 'sk_org_{org_id}_{hash}', got '${this.apiKey.slice(0, 20)}...'`,
      );
    }
    const orgId = afterPrefix.slice(0, lastUnderscore);
    if (!orgId || !orgId.startsWith("org_")) {
      throw new Error(`Invalid org_id in API key. Expected 'org_*', got '${orgId}'`);
    }
    return orgId;
  }

  /**
   * Create a pending approval. Resolves to `{ approval_id, status }`.
   *
   * `thread_id` is the framework checkpoint/run id — the API stores it so that
   * when the human decides, the approval handler can hit the agent's `/resume`
   * with the right context. Org ID is extracted from the API key.
   */
  async createApproval(params: CreateApprovalParams): Promise<CreateApprovalResult> {
    const { thread_id, action, message, channel, tool, agent_callback_url, agent_callback_secret, ...metadata } =
      params;
    if (!thread_id) {
      throw new Error("thread_id is required — needed to resume the paused run");
    }

    const endpoint = `${this.baseUrl}/org/${this.orgId}/approval`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    const body: Record<string, unknown> = {
      thread_id,
      action,
      message,
      channel,
      tool_name: tool?.name,
      tool_description: tool?.description,
      tool_kwargs: { ...(tool?.kwargs ?? {}) },
      agent_callback_url: agent_callback_url ?? null,
      agent_callback_secret: agent_callback_secret ?? null,
    };
    for (const [k, v] of Object.entries(metadata)) {
      if (!RESERVED_FIELDS.has(k)) body[k] = v;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout * 1000);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    await raiseForStatus(response);
    return (await response.json()) as CreateApprovalResult;
  }
}
