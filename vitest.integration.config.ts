import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    globals: true,
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});

