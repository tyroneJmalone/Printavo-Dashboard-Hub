import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "browser-journey.spec.ts",
  outputDir: "/tmp/autoprint-notifications-test-results",
  timeout: 120_000,
  workers: 1,
  reporter: "list",
  use: { browserName: "chromium" },
  webServer: {
    command: "pnpm exec vite --config tests/notifications/vite.config.ts",
    cwd: new URL("../..", import.meta.url).pathname,
    url: "http://localhost:5180/auto-print",
    reuseExistingServer: !process.env.CI,
  },
});
