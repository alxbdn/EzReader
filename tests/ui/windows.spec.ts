import type { Page } from "@playwright/test";
import { expect, start, test } from "./fixture";
import { calls, drag, emit, pageBox, settle } from "./helpers";

const toast = (page: Page) => page.locator("#toast");
const tabs = (page: Page) => page.locator(".side-tab[data-tab]");

async function called(page: Page, cmd: string) {
  return (await calls(page)).filter((c) => c === cmd).length;
}

async function drop(page: Page, paths: string[], at: { x: number; y: number }) {
  await emit(page, "tauri://drag-enter", { paths, position: at });
  await emit(page, "tauri://drag-over", { position: at });
  await emit(page, "tauri://drag-drop", { paths, position: at });
}

async function savedKinds(page: Page): Promise<string[]> {
  await page.evaluate(() => { (window as unknown as { __EZ_SAVED__: unknown }).__EZ_SAVED__ = null; });
  await page.keyboard.press("Control+s");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __EZ_SAVED__: unknown }).__EZ_SAVED__)).not.toBeNull();
  return page.evaluate(() => (window as unknown as { __EZ_SAVED__: { kind: string }[] }).__EZ_SAVED__.map((a) => a.kind));
}

async function addNote(page: Page) {
  await page.click("[data-mode=annotate]");
  const box = await pageBox(page);
  await page.click("[data-group=note]");
  await page.mouse.click(box.x + 120, box.y + 140);
  await settle(page, 300);
  await page.keyboard.type("Unsaved");
  await page.mouse.click(box.x + 10, box.y + box.height - 10);
  await page.keyboard.press("Escape");
  await settle(page, 200);
}

async function menuEntry(page: Page, menu: number, name: RegExp) {
  await page.locator(".menubar-item").nth(menu).click();
  await page.locator(".menu-dropdown").nth(menu).locator(".menu-entry", { hasText: name }).click();
}

test.describe("windows and files", () => {
  test("drop pictures, documents and other files onto the window", async ({ page }) => {
    await start(page, { doc: true });
    const box = await pageBox(page);
    const onPage = { x: box.x + 200, y: box.y + 200 };

    await drop(page, ["/pics/a.png"], onPage);
    expect(await savedKinds(page)).toEqual(["image"]);

    await drop(page, ["/x/archive.zip"], onPage);
    await expect(toast(page)).toHaveClass(/error/);

    await drop(page, ["/docs/form-acroform.pdf"], onPage);
    await expect(tabs(page)).toHaveCount(2);
    await expect(tabs(page).nth(1)).toHaveClass(/active/);

    await drop(page, ["/docs/pdf14-mixed-sizes-rotated.pdf"], onPage);
    await expect(tabs(page)).toHaveCount(2);
    await expect(tabs(page).first()).toHaveClass(/active/);

    await emit(page, "tauri://drag-enter", { paths: ["/docs/linearized.pdf"], position: onPage });
    await expect(page.locator("body")).toHaveClass(/drag-over/);
    await emit(page, "tauri://drag-leave", {});
    await expect(page.locator("body")).not.toHaveClass(/drag-over/);

    await settle(page, 500);
    const tab = (await tabs(page).first().boundingBox())!;
    await drop(page, ["/docs/linearized.pdf"], { x: tab.x + tab.width / 2, y: tab.y + tab.height / 2 });
    await expect(tabs(page)).toHaveCount(3);
    await expect(tabs(page).filter({ has: page.locator(":scope[title*=linearized]") })).toHaveCount(1);
  });

  test("drop a document between two thumbnails to insert its pages", async ({ page }) => {
    await start(page, { doc: true });
    const thumbs = page.locator(".page-sidebar-thumb");
    await expect(thumbs.first()).toBeVisible();
    const a = (await thumbs.nth(0).boundingBox())!;
    const b = (await thumbs.nth(1).boundingBox())!;
    const gap = { x: a.x + a.width / 2, y: (a.y + a.height + b.y) / 2 };
    await drop(page, ["/docs/form-acroform.pdf"], gap);
    await expect.poll(() => called(page, "rearrange_pages")).toBeGreaterThan(0);
    const inserted = await called(page, "rearrange_pages");
    await settle(page, 1000);
    const c = (await thumbs.nth(0).boundingBox())!;
    const d = (await thumbs.nth(1).boundingBox())!;
    await drop(page, ["/pics/a.png"], { x: c.x + c.width / 2, y: (c.y + c.height + d.y) / 2 });
    await expect.poll(() => called(page, "rearrange_pages")).toBeGreaterThan(inserted);
  });

  test("paste a picture from the clipboard", async ({ page }) => {
    await start(page, { doc: true });
    await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 8;
      canvas.getContext("2d")!.fillRect(0, 0, 8, 8);
      const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/png"));
      const data = new DataTransfer();
      data.items.add(new File([blob], "shot.png", { type: "image/png" }));
      document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    expect(await savedKinds(page)).toEqual(["image"]);

    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array([1, 2, 3])], "broken.png", { type: "image/png" }));
      document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(toast(page)).toHaveClass(/error/);
  });

  test("closing the window asks about unsaved changes", async ({ page }) => {
    await start(page, { doc: true });
    await addNote(page);
    const destroyed = await called(page, "plugin:window|destroy");
    const dialog = page.locator(".modal-backdrop:not(.hidden)").filter({ hasText: /save/i });
    await emit(page, "tauri://close-requested", null);
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await settle(page, 200);
    expect(await called(page, "plugin:window|destroy")).toBe(destroyed);

    await emit(page, "tauri://close-requested", null);
    await dialog.getByRole("button", { name: "No" }).click();
    await expect.poll(() => called(page, "plugin:window|destroy")).toBeGreaterThan(destroyed);
  });

  test("switch back to a tab while another one is still opening", async ({ page }) => {
    await start(page, { doc: true });
    await addNote(page);
    await drop(page, ["/docs/form-acroform.pdf"], { x: 640, y: 400 });
    await tabs(page).nth(1).waitFor();
    await tabs(page).first().click();
    await expect(page).toHaveTitle(/pdf14-mixed-sizes-rotated/);
    await expect(tabs(page).first()).toHaveAttribute("title", /pdf14-mixed-sizes-rotated/);
    await expect(tabs(page).nth(1)).toHaveAttribute("title", /form-acroform/);
    await expect(page.locator("#viewer-scroll .page-wrapper")).toHaveCount(4);
  });

  test("drag a tab out of the window", async ({ page }) => {
    await start(page, { doc: true });
    await addNote(page);
    await drop(page, ["/docs/form-acroform.pdf"], { x: 640, y: 400 });
    await expect(tabs(page).nth(1)).toHaveClass(/active/);
    await expect(page).toHaveTitle(/form-acroform/);
    await tabs(page).first().click();
    await expect(page).toHaveTitle(/pdf14-mixed-sizes-rotated/);
    const tab = (await tabs(page).first().boundingBox())!;
    await page.evaluate(({ x, y }) => {
      const el = document.querySelectorAll(".side-tab[data-tab]")[0]!;
      const fire = (target: EventTarget, type: string, cx: number, cy: number) =>
        target.dispatchEvent(new PointerEvent(type, { pointerId: 7, button: 0, buttons: 1, clientX: cx, clientY: cy, screenX: cx, screenY: cy, bubbles: true }));
      fire(el, "pointerdown", x, y);
      fire(window, "pointermove", x, y + 30);
      fire(window, "pointermove", -40, y + 60);
      fire(window, "pointerup", -40, y + 60);
    }, { x: tab.x + 20, y: tab.y + tab.height / 2 });
    await expect.poll(() => called(page, "move_tab")).toBeGreaterThan(0);
    await expect(tabs(page)).toHaveCount(1);
    await expect(page).toHaveTitle(/form-acroform/);
  });

  test("print, with and without edits waiting to be saved", async ({ page }) => {
    await start(page, { doc: true });
    await page.keyboard.press("Control+p");
    await page.locator("#print-copies").fill("2");
    await page.click("#print-confirm-btn");
    await expect(toast(page)).toHaveText(/printer/i);
    const first = await called(page, "print_pages");
    expect(first).toBeGreaterThan(0);

    await page.click("[data-mode=edit]");
    await page.click("[data-group=redact]");
    await page.click("[data-redact=area]");
    const box = await pageBox(page);
    await drag(page, [box.x + 60, box.y + 60], [box.x + 200, box.y + 120]);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+p");
    await page.click("#print-confirm-btn");
    await expect.poll(() => called(page, "print_pages")).toBeGreaterThan(first);

    await page.keyboard.press("Control+s");
    await expect.poll(() => called(page, "redact_pages")).toBeGreaterThan(0);
  });

  test("split into files in a chosen folder", async ({ page }) => {
    await start(page, { doc: true });
    await menuEntry(page, 1, /Split/);
    await expect(page.locator("#split-modal")).not.toHaveClass(/hidden/);
    await page.click("#split-apply-btn");
    await expect(toast(page)).toHaveText(/2 file/);
    expect(await called(page, "split_pdf")).toBeGreaterThan(0);
  });

  test("export the text to Word", async ({ page }) => {
    await start(page, { doc: true });
    await menuEntry(page, 0, /Export/);
    const modal = page.locator(".modal-backdrop:not(.hidden)");
    await modal.getByRole("button", { name: /Word/ }).click();
    await modal.locator(".btn-primary").click();
    await expect.poll(() => called(page, "convert_text")).toBeGreaterThan(0);
  });
});
