import { afterEach, describe, expect, it } from "vitest";
import { preflight } from "../src/core/preflight";

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const saved = {
  AEGMIS_APPROVAL: process.env.AEGMIS_APPROVAL,
  AEGMIS_API_KEY: process.env.AEGMIS_API_KEY,
  AEGMIS_BASE_URL: process.env.AEGMIS_BASE_URL,
};

afterEach(() => {
  restore("AEGMIS_APPROVAL", saved.AEGMIS_APPROVAL);
  restore("AEGMIS_API_KEY", saved.AEGMIS_API_KEY);
  restore("AEGMIS_BASE_URL", saved.AEGMIS_BASE_URL);
});

describe("preflight", () => {
  it("errors when approvals are enabled but no API key is set", () => {
    process.env.AEGMIS_APPROVAL = "true";
    delete process.env.AEGMIS_API_KEY;
    expect(preflight().some((i) => i.level === "error")).toBe(true);
  });

  it("has no errors with a valid key + base url", () => {
    process.env.AEGMIS_APPROVAL = "true";
    process.env.AEGMIS_API_KEY = "sk_org_org_test_abcdef0123456789";
    process.env.AEGMIS_BASE_URL = "https://api.aegmis.com";
    expect(preflight().some((i) => i.level === "error")).toBe(false);
  });

  it("errors on a malformed API key", () => {
    process.env.AEGMIS_APPROVAL = "true";
    process.env.AEGMIS_API_KEY = "not-an-aegmis-key";
    expect(preflight().some((i) => i.level === "error")).toBe(true);
  });

  it("only warns (no error) when approvals are disabled", () => {
    process.env.AEGMIS_APPROVAL = "false";
    delete process.env.AEGMIS_API_KEY;
    const issues = preflight();
    expect(issues.some((i) => i.level === "error")).toBe(false);
    expect(issues.some((i) => i.level === "warn")).toBe(true);
  });
});
