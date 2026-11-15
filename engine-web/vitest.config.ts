import { defineConfig } from "vitest/config";

// Separate from vite.config.ts: tests run in Node with real fs (no browser shims, no dev root).
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node", testTimeout: 60000 },
});
