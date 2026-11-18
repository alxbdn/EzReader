import { defineConfig } from "@playwright/test";

/**
 * Visual regression: the built frontend (dist/) in Chromium, the engine of
 * WebView2, with the Tauri IPC stubbed (tests/visual/tauri-stub.js). Screenshots are
 * compared with the baselines in tests/visual/__screenshots__.
 *
 * Fonts and anti-aliasing differ between machines, so the baselines come from
 * the Playwright Docker image CI runs in. To refresh them after an intended
 * change to the look of the app:
 *
 *   npm run build
 *   docker run --rm -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.65.0-noble \
 *     npx playwright test --update-snapshots
 *
 * or run the "Visual baselines" workflow on the branch (Actions tab).
 */
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
