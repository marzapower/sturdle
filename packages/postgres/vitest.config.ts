import { defineConfig } from "vitest/config";

export default defineConfig({
  // Tests import the engine from its TypeScript sources, like the `sturdle-source` export
  // condition the tsconfigs use, so they never depend on a prior `pnpm build`.
  resolve: {
    conditions: ["sturdle-source"],
  },
  test: {
    environment: "node",
  },
});
