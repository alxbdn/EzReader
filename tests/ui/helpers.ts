import type { Locator, Page } from "@playwright/test";

export async function settle(page: Page, ms = 250) {
  await page.waitForTimeout(ms);
}

export async function dismiss(page: Page) {
  for (let i = 0; i < 3; i++) await page.keyboard.press("Escape");
  await page.evaluate(() => {
    for (const m of document.querySelectorAll(".modal-backdrop:not(.hidden)")) {
      const close = m.querySelector<HTMLButtonElement>("[id$=close-btn], [id$=cancel-btn], .modal-header .icon-btn, .btn:not(.btn-primary)");
      close?.click();
    }
  });
  await settle(page, 100);
}

export async function tryClick(target: Locator, opts: { button?: "left" | "right" } = {}) {
  try {
    await target.click({ timeout: 600, ...opts });
    return true;
  } catch {
    return false;
  }
}

export async function pageBox(page: Page, n = 0) {
  const box = await page.locator("#viewer-scroll .page-wrapper").nth(n).boundingBox({ timeout: 2000 });
  if (!box) throw new Error("page not visible");
  return box;
}

export async function drag(page: Page, from: [number, number], to: [number, number]) {
  await page.mouse.move(...from);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / 5, from[1] + ((to[1] - from[1]) * i) / 5);
  await page.mouse.up();
}
