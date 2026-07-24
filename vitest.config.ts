import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests only. Playwright specs live in e2e/ and are run by `npm run test:e2e`.
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
