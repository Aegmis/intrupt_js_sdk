import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/server.ts",
    "src/adapters/vercelAi.ts",
    "src/adapters/openaiAgents.ts",
    "src/adapters/mastra.ts",
    "src/adapters/langchainTools.ts",
    "src/adapters/langgraph.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  // Framework packages are peer deps resolved via runtime dynamic import;
  // never bundle them.
  external: [
    "ai",
    "@openai/agents",
    "@mastra/core",
    "@langchain/core",
    "@langchain/langgraph",
  ],
});
