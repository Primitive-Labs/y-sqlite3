import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    target: "node18",
  },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 10000,
    // Run tests sequentially to avoid SQLite file locking issues
    // when both test files access the same test-dbs directory
    fileParallelism: false,
    sequence: {
      shuffle: false,
    },
  },
});
