import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Live-stack tests mutate a shared devnet — can't run in parallel.
    fileParallelism: false,
    // Network round-trips can be slow on a cold stack.
    testTimeout: 30_000,
  },
});
