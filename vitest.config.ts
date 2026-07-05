import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Enable approvals for tests that exercise the real gate/backend path.
    setupFiles: ["./test/setup.ts"],
  },
});
