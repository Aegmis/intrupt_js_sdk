/**
 * Startup config checks — surface common misconfigurations (missing / invalid
 * API key, no base URL) with clear messages at boot instead of a cryptic
 * runtime "Invalid or expired token". Pure config inspection; no network calls.
 */
import { approvalsEnabled } from "./gating";

export interface PreflightIssue {
  level: "error" | "warn";
  message: string;
}

/** Inspect the current env / config and return any issues (no network). */
export function preflight(): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const key = process.env.AEGMIS_API_KEY?.trim();
  const baseUrl = process.env.AEGMIS_BASE_URL?.trim();

  if (!approvalsEnabled()) {
    issues.push({
      level: "warn",
      message:
        "AEGMIS_APPROVAL is off — gated tools auto-approve in-process without contacting the " +
        "backend. Set AEGMIS_APPROVAL=true to require real approvals.",
    });
    return issues;
  }

  if (!key) {
    issues.push({
      level: "error",
      message:
        'Approvals are enabled but AEGMIS_API_KEY is not set — every gated tool will fail with ' +
        '"Invalid or expired token". Set AEGMIS_API_KEY (dashboard → Account → API Keys), or set ' +
        'AEGMIS_APPROVAL=false to auto-approve. Note: the SDK does not load .env — add ' +
        'import "dotenv/config" at the top of your entrypoint.',
    });
  } else if (!key.startsWith("sk_org_")) {
    issues.push({
      level: "error",
      message: `AEGMIS_API_KEY has an unexpected format (expected sk_org_{org_id}_{hash}), got "${key.slice(0, 12)}…".`,
    });
  }

  if (!baseUrl) {
    issues.push({
      level: "warn",
      message:
        "AEGMIS_BASE_URL is not set — defaulting to http://localhost:8080. Set it to your approval " +
        "API (e.g. https://api.aegmis.com).",
    });
  }

  return issues;
}

/**
 * Run {@link preflight} and print any issues (errors to stderr, warnings to
 * stdout). Returns `false` if there are errors. Call once at startup:
 *
 * ```ts
 * import { preflightCheck } from "intrupt-js-sdk";
 * preflightCheck();               // warn/log only
 * preflightCheck({ throwOnError: true });  // hard-fail on misconfig
 * ```
 */
export function preflightCheck(opts: { throwOnError?: boolean } = {}): boolean {
  const issues = preflight();
  for (const issue of issues) {
    const line = `[intrupt] ${issue.level === "error" ? "✖" : "⚠"} ${issue.message}`;
    if (issue.level === "error") console.error(line);
    else console.warn(line);
  }
  const ok = !issues.some((i) => i.level === "error");
  if (!ok && opts.throwOnError) {
    throw new Error("intrupt preflight failed — fix the errors above (or set AEGMIS_APPROVAL=false).");
  }
  return ok;
}
