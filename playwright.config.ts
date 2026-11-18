import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/visual",
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
  outputDir: "tests/visual/results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "tests/visual/report" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1100, height: 840 },
    locale: "en-US",
    timezoneId: "UTC",
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  },
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: "disabled", caret: "hide" },
  },
  webServer: {
    command: "npx vite preview --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
  },
});
