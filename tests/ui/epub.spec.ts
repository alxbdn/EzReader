import type { Page } from "@playwright/test";
import { expect, start, test } from "./fixture";
import { settle } from "./helpers";
import { testBook } from "./epub-file";

const calls = (page: Page) => page.evaluate(() => (window as unknown as { __EZ_CALLS__: string[] }).__EZ_CALLS__);
const BOOK = "/books/test.epub";
const reader = (page: Page) => page.locator("#epub-reader");
const frame = (page: Page) => page.frameLocator("#epub-reader .epub-frame");
const position = (page: Page) => reader(page).locator(".epub-position");
const scale = (page: Page) => reader(page).locator(".epub-scale");
const scrollY = (page: Page) => reader(page).locator(".epub-frame").evaluate((f) => (f as HTMLIFrameElement).contentWindow!.scrollY);

async function openBook(page: Page, storage: Record<string, string> = {}, chapter = 1) {
  await page.addInitScript((entries) => { for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v); }, storage);
  await start(page, { stub: { startupFile: BOOK }, files: { "test.epub": testBook() } });
  await expect(reader(page)).toBeVisible();
  await expect(frame(page).locator("h1")).toHaveText(`Chapter ${chapter}`);
}

test.describe("EPUB reader", () => {
  test("turn chapters with the buttons, the keyboard and the end of chapter button", async ({ page }) => {
    await openBook(page);
    await expect(page).toHaveTitle(/Test Book/);
    await expect(position(page)).toHaveText("1 / 3");
    await expect(reader(page).locator(".page-nav-step").first()).toBeDisabled();

    await reader(page).locator(".page-nav-step").last().click();
    await expect(frame(page).locator("h1")).toHaveText("Chapter 2");
    await page.keyboard.press("ArrowRight");
    await expect(position(page)).toHaveText("3 / 3");
    await expect(reader(page).locator(".page-nav-step").last()).toBeDisabled();
    await page.keyboard.press("ArrowRight");
    await expect(position(page)).toHaveText("3 / 3");
    await page.keyboard.press("ArrowLeft");
    await expect(position(page)).toHaveText("2 / 3");

    await page.locator("body").press("End");
    await expect.poll(() => scrollY(page)).toBeGreaterThan(500);
    await page.locator("body").press("Home");
    await expect.poll(() => scrollY(page)).toBe(0);
    await page.locator("body").press("ArrowDown");
    await expect.poll(() => scrollY(page)).toBeGreaterThan(0);
    await page.locator("body").press("PageDown");
    const afterPage = await scrollY(page);
    expect(afterPage).toBeGreaterThan(200);
    await page.locator("body").press("PageUp");
    await expect.poll(() => scrollY(page)).toBeLessThan(afterPage);

    await frame(page).locator(".ez-end button").click();
    await expect(position(page)).toHaveText("3 / 3");
    await expect(frame(page).locator(".ez-end button")).toHaveCount(0);

    await frame(page).locator("body").press("Home");
    await frame(page).locator("body").press("PageUp");
    await expect(position(page)).toHaveText("2 / 3");
    await expect.poll(() => scrollY(page)).toBeGreaterThan(500);
    await frame(page).locator("body").press("PageDown");
    await expect(position(page)).toHaveText("3 / 3");
  });

  test("jump from the table of contents and from links", async ({ page }) => {
    await openBook(page);
    const toc = reader(page).locator(".epub-toc");
    await expect(toc).toBeHidden();
    await reader(page).locator(".epub-bar-side .tb-square").click();
    await expect(toc).toBeVisible();
    await expect(toc.locator(".epub-toc-entry")).toHaveText(["One", "Two", "Two, later", "Three"]);
    await expect(toc.locator(".epub-toc-entry.current")).toHaveText("One");

    await toc.locator(".epub-toc-entry", { hasText: "Two, later" }).click();
    await expect(position(page)).toHaveText("2 / 3");
    await expect.poll(() => scrollY(page)).toBeGreaterThan(500);
    await expect(toc.locator(".epub-toc-entry.current")).toHaveText("Two");

    await toc.locator(".epub-toc-entry", { hasText: /^Two$/ }).click();
    await expect.poll(() => scrollY(page)).toBe(0);
    await toc.locator(".epub-toc-entry", { hasText: "Two, later" }).click();
    await expect.poll(() => scrollY(page)).toBeGreaterThan(500);

    await toc.locator(".epub-toc-entry", { hasText: "One" }).click();
    await expect(position(page)).toHaveText("1 / 3");
    await frame(page).getByText("Jump to three").click();
    await expect(position(page)).toHaveText("3 / 3");
    await expect.poll(() => scrollY(page)).toBeGreaterThan(500);

    await reader(page).locator(".epub-bar-side .tb-square").click();
    await expect(toc).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem("ezreader.epub.toc"))).toBe("0");
  });

  test("open outside links in the browser", async ({ page }) => {
    await openBook(page);
    await frame(page).getByText("Site").click();
    await expect.poll(async () => (await calls(page)).some((c) => c === "open_url")).toBe(true);
    await expect(position(page)).toHaveText("1 / 3");
  });

  test("change the text size and keep it", async ({ page }) => {
    await openBook(page);
    await expect(scale(page)).toHaveText("100 %");
    const larger = reader(page).locator(".epub-bar-right .icon-btn").nth(1);
    const smaller = reader(page).locator(".epub-bar-right .icon-btn").first();
    await larger.click();
    await expect(scale(page)).toHaveText("110 %");
    await page.keyboard.press("Control+=");
    await expect(scale(page)).toHaveText("125 %");
    await page.keyboard.press("Control+-");
    await page.keyboard.press("Control+-");
    await page.keyboard.press("Control+-");
    await expect(scale(page)).toHaveText("90 %");
    await smaller.click();
    await expect(scale(page)).toHaveText("80 %");
    await expect(smaller).toBeDisabled();
    await page.keyboard.press("Control+0");
    await expect(scale(page)).toHaveText("100 %");
    await frame(page).locator("h1").hover();
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -100);
    await page.keyboard.up("Control");
    await expect(scale(page)).toHaveText("110 %");
    for (let i = 0; i < 10; i++) await page.keyboard.press("Control+=");
    await expect(scale(page)).toHaveText("200 %");
    await expect(larger).toBeDisabled();
    expect(await page.evaluate(() => localStorage.getItem("ezreader.epub.scale"))).toBe("2");
    await expect.poll(() => frame(page).locator("html").evaluate((h) => (h as HTMLElement).style.getPropertyValue("--ez-scale"))).toBe("2");
  });

  test("reopen the book where reading stopped", async ({ page }) => {
    await openBook(page, { [`ezreader.epub.pos:${BOOK}`]: "1:0.5000", "ezreader.epub.scale": "1.4", "ezreader.epub.toc": "1" }, 2);
    await expect(position(page)).toHaveText("2 / 3");
    await expect(scale(page)).toHaveText("140 %");
    await expect(reader(page).locator(".epub-toc")).toBeVisible();
    await expect.poll(() => scrollY(page)).toBeGreaterThan(300);

    await page.keyboard.press("ArrowRight");
    await expect(position(page)).toHaveText("3 / 3");
    await reader(page).locator(".epub-frame").evaluate((f) => (f as HTMLIFrameElement).contentWindow!.scrollTo(0, 400));
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), `ezreader.epub.pos:${BOOK}`)).toMatch(/^2:0\.[1-9]/);
  });

  test("follow the app theme and close with Ctrl+W", async ({ page }) => {
    await openBook(page);
    await page.evaluate(() => { document.documentElement.dataset["theme"] = "dark"; });
    await expect(frame(page).locator("html")).toHaveClass(/ez-dark/);
    await page.evaluate(() => { document.documentElement.dataset["theme"] = "light"; });
    await expect(frame(page).locator("html")).not.toHaveClass(/ez-dark/);

    await page.keyboard.press("Control+w");
    await expect(reader(page)).toBeHidden();
    await expect(page.locator("#welcome-screen")).toBeVisible();
    await settle(page, 200);
  });
});
