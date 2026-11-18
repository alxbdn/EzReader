import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: "results",
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 240_000,
  use: {
    baseURL: "http://127.0.0.1:5174",
    viewport: { width: 1280, height: 860 },
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    actionTimeout: 2000,
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  webServer: {
    command: "npx vite --host 127.0.0.1 --port 5174 --strictPort",
    cwd: "../..",
    url: "http://127.0.0.1:5174",
    reuseExistingServer: !process.env.CI,
  },
});
