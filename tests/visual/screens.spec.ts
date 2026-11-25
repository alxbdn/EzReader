import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const stub = readFileSync(join(import.meta.dirname, "tauri-stub.js"), "utf8");
const DOC = "pdf14-mixed-sizes-rotated.pdf";

async function start(page: Page, { doc = false } = {}) {
  await page.route("**/__fixtures__/*", (route) =>
    route.fulfill({ body: readFileSync(join(root, "src-tauri", "tests", "corpus", DOC)), contentType: "application/pdf" }));
  await page.addInitScript(`window.__EZ_STUB__ = ${JSON.stringify(doc ? { startupFile: `/docs/${DOC}`, pages: 4 } : {})};`);
  await page.addInitScript(stub);
  await page.goto("/");
  await expect(page.locator(".menubar-item").first()).toBeVisible();
  if (doc) {
    await expect(page.locator("#welcome-screen")).toHaveClass(/hidden/);
    await expect(page.locator("#viewer-scroll .page-wrapper")).toHaveCount(4);
    await page.waitForFunction(() => {
      const shown = [...document.querySelectorAll<HTMLCanvasElement>("#viewer-scroll .page-canvas, #page-sidebar canvas")]
        .filter((c) => { const r = c.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.width > 0; });
      return shown.length > 0 && shown.every((c) => c.width > 0 && c.dataset["rendered"] !== "false");
    });
    await page.waitForTimeout(500);
  }
  await page.evaluate(() => document.fonts.ready);
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });

    test("opening screen", async ({ page }) => {
      await start(page);
      await expect(page).toHaveScreenshot(`home-${scheme}.png`);
    });

    test("viewer with a document", async ({ page }) => {
      await start(page, { doc: true });
      await expect(page).toHaveScreenshot(`viewer-${scheme}.png`);
    });

    test("annotate tools", async ({ page }) => {
      await start(page, { doc: true });
      await page.click("[data-mode=annotate]");
      await page.click("[data-group=shapes]");
      await page.mouse.move(0, 0);
      await expect(page).toHaveScreenshot(`annotate-shapes-${scheme}.png`);
    });

    for (const menu of ["file", "edit", "view", "tools"]) {
      test(`${menu} menu`, async ({ page }) => {
        await start(page, { doc: true });
        await page.click(`[data-menu-id=${menu}]`);
        await page.mouse.move(1000, 800);
        await expect(page.locator(`[data-menu-id=${menu}] + .menu-dropdown`)).toBeVisible();
        await expect(page).toHaveScreenshot(`menu-${menu}-${scheme}.png`);
      });
    }

    test("settings", async ({ page }) => {
      await start(page);
      await page.keyboard.press("Control+,");
      await expect(page.locator("#settings-modal")).not.toHaveClass(/hidden/);
      await expect(page).toHaveScreenshot(`settings-${scheme}.png`);
    });
  });
}
