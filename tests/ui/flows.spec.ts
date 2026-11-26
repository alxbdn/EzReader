import type { Locator, Page } from "@playwright/test";
import { expect, start, test } from "./fixture";

const SKIP = /wc-close|wc-min|wc-max/;

async function settle(page: Page, ms = 250) {
  await page.waitForTimeout(ms);
}

async function dismiss(page: Page) {
  for (let i = 0; i < 3; i++) await page.keyboard.press("Escape");
  await page.evaluate(() => {
    for (const m of document.querySelectorAll(".modal-backdrop:not(.hidden)")) {
      const close = m.querySelector<HTMLButtonElement>("[id$=close-btn], [id$=cancel-btn], .modal-header .icon-btn, .btn:not(.btn-primary)");
      close?.click();
    }
  });
  await settle(page, 100);
}

async function tryClick(target: Locator, opts: { button?: "left" | "right" } = {}) {
  try {
    await target.click({ timeout: 600, ...opts });
    return true;
  } catch {
    return false;
  }
}

async function visible(page: Page, selector: string): Promise<Locator[]> {
  const all = await page.locator(selector).all();
  const out: Locator[] = [];
  for (const l of all) if (await l.isVisible().catch(() => false)) out.push(l);
  return out;
}

async function pageBox(page: Page, n = 0) {
  const box = await page.locator("#viewer-scroll .page-wrapper").nth(n).boundingBox({ timeout: 2000 });
  if (!box) throw new Error("page not visible");
  return box;
}

async function drag(page: Page, from: [number, number], to: [number, number]) {
  await page.mouse.move(...from);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / 5, from[1] + ((to[1] - from[1]) * i) / 5);
  await page.mouse.up();
}

async function poke(page: Page, scope: string) {
  await page.evaluate((scope) => {
    const shown = (e: Element) => (e as HTMLElement).offsetParent !== null;
    for (const root of document.querySelectorAll(scope)) {
      if (!shown(root)) continue;
      for (const el of root.querySelectorAll<HTMLElement>("input, select, textarea")) {
        if (!shown(el)) continue;
        if (el instanceof HTMLSelectElement) { if (el.options.length > 1) el.selectedIndex = 1; }
        else if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) el.click();
        else if (el instanceof HTMLInputElement && el.type === "range") el.value = String((Number(el.min) + Number(el.max)) / 2);
        else (el as HTMLInputElement).value = "2";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      for (const b of root.querySelectorAll<HTMLButtonElement>("button")) {
        if (!shown(b) || b.disabled || /close|cancel|primary|wc-/.test(b.className) || /close|cancel/i.test(b.id)) continue;
        b.click();
      }
    }
  }, scope);
  await settle(page, 200);
}

async function everyMenuEntry(page: Page) {
  const menus = await page.locator(".menubar-item").all();
  for (let m = 0; m < menus.length; m++) {
    const entries = page.locator(".menu-dropdown").nth(m).locator(".menu-entry");
    await menus[m]!.click({ timeout: 2000 });
    const count = await entries.count();
    await dismiss(page);
    for (let i = 0; i < count; i++) {
      await menus[m]!.evaluate((e) => (e as HTMLButtonElement).click());
      await entries.nth(i).evaluate((e) => (e as HTMLButtonElement).click()).catch(() => {});
      await settle(page, 400);
      await poke(page, ".modal-backdrop:not(.hidden)");
      await poke(page, ".modal-backdrop:not(.hidden)");
      await dismiss(page);
    }
  }
}

test.describe("opening screen", () => {
  test("menus and settings without a document", async ({ page }) => {
    await start(page);
    await everyMenuEntry(page);
    await page.keyboard.press("Control+,");
    await settle(page);
    await poke(page, "#settings-modal");
    await dismiss(page);
    await page.mouse.move(400, 400);
    await page.mouse.move(600, 500);
    for (const b of await visible(page, "#welcome-screen button")) {
      await tryClick(b);
      await dismiss(page);
    }
  });

  test("no scrollbar after the window grows then shrinks", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await start(page);
    const welcome = page.locator("#welcome-screen");
    await page.setViewportSize({ width: 1700, height: 1600 });
    await settle(page, 150);
    await page.setViewportSize({ width: 1280, height: 860 });
    await settle(page, 150);
    const fits = () => welcome.evaluate((el) => {
      const canvas = el.querySelector("canvas")!.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return canvas.height <= box.height && canvas.width <= box.width;
    });
    expect(await fits()).toBe(true);
    await page.locator("#welcome-open-btn").click();
    await expect(page.locator("#viewer-scroll .page-wrapper").first()).toBeVisible();
    await page.setViewportSize({ width: 1100, height: 760 });
    await settle(page, 150);
    await page.locator(".side-tab-close").first().click({ force: true });
    await expect(welcome).toBeVisible();
    await settle(page, 150);
    expect(await fits()).toBe(true);
  });

  test("the opening screen shrinks to fit a short window", async ({ page }) => {
    await start(page);
    const welcome = page.locator("#welcome-screen");
    for (const height of [480, 600, 760]) {
      await page.setViewportSize({ width: 900, height });
      await settle(page, 150);
      const fit = await welcome.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const inner = el.querySelector(".welcome-inner")!.getBoundingClientRect();
        return { scrolls: getComputedStyle(el).overflowY !== "hidden", top: inner.top >= box.top, bottom: inner.bottom <= box.bottom };
      });
      expect(fit).toEqual({ scrolls: false, top: true, bottom: true });
    }
  });
});

test.describe("document", () => {
  test("every menu entry", async ({ page }) => {
    await start(page, { doc: true });
    await everyMenuEntry(page);
  });

  test("toolbar buttons and keyboard", async ({ page }) => {
    await start(page, { doc: true });
    for (const b of await visible(page, ".icon-btn, .zoom-label, .doc-title-name")) {
      if (SKIP.test((await b.getAttribute("class")) ?? "")) continue;
      await tryClick(b);
      await settle(page);
      await poke(page, ".popover, .modal-backdrop:not(.hidden), [class*=popover]");
      await dismiss(page);
    }
    const box = await pageBox(page);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    for (const key of ["Control+=", "Control+=", "Control+-", "Control+0", "PageDown", "PageDown", "End", "Home", "ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft"]) {
      await page.keyboard.press(key);
      await settle(page, 120);
    }
    await page.keyboard.press("Control+f");
    await page.keyboard.type("a");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Shift+Enter");
    await settle(page, 500);
    await dismiss(page);
    await page.keyboard.press("F5");
    await settle(page, 500);
    for (const key of ["ArrowRight", "ArrowRight", "ArrowLeft", "End", "Home", "Space"]) await page.keyboard.press(key);
    await page.mouse.click(300, 300);
    await page.mouse.wheel(0, 300);
    await dismiss(page);
    await page.locator("#viewer-scroll").hover();
    await page.mouse.wheel(0, 1500);
    await settle(page);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -200);
    await page.keyboard.up("Control");
  });

  test("more tools menu", async ({ page }) => {
    await start(page, { doc: true });
    const more = page.locator(".tb-more");
    const menu = page.locator(".tb-more-menu");
    // With room, the actions sit on the bar and the "…" button is hidden.
    const inline = page.locator(".tb-actions .icon-btn");
    // Export, Compress, Password, Brightness, Page layout, Present, Info.
    await expect(inline).toHaveCount(7);
    await expect(inline.first()).toBeVisible();
    await expect(more).toBeHidden();
    for (let i = 0; i < 7; i++) {
      await inline.nth(i).click();
      await settle(page, 300);
      await dismiss(page);
    }
    // Narrow, they fold into the "…" menu.
    await page.setViewportSize({ width: 760, height: 860 });
    await expect(more).toBeVisible();
    // Brightness and page layout stay on the bar; the rest moves to the menu.
    await expect(inline.first()).toBeHidden();
    await expect(page.locator(".tb-actions .tb-pages")).toBeVisible();
    await more.click();
    await expect(menu).toHaveClass(/open/);
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("End");
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Escape");
    await expect(menu).not.toHaveClass(/open/);
    await expect(more).toBeFocused();
    await more.click();
    await page.mouse.click(300, 400);
    await expect(menu).not.toHaveClass(/open/);
    const count = await menu.locator(".menu-entry").count();
    expect(count).toBe(5);
    for (let i = 0; i < count; i++) {
      await more.click();
      await menu.locator(".menu-entry").nth(i).click();
      await expect(menu).not.toHaveClass(/open/);
      await settle(page, 300);
      await dismiss(page);
    }
  });

  test("page sidebar", async ({ page }) => {
    await start(page, { doc: true });
    const frames = await visible(page, ".page-sidebar-frame");
    await tryClick(frames[1]!);
    await tryClick(frames[2]!, {});
    await page.keyboard.down("Shift");
    await tryClick(frames[3]!);
    await page.keyboard.up("Shift");
    await tryClick(frames[0]!, { button: "right" });
    await settle(page);
    for (const item of await visible(page, ".context-menu button, .ctx-menu button, [role=menu] button")) {
      await tryClick(frames[0]!, { button: "right" });
      await tryClick(item);
      await settle(page);
      await dismiss(page);
    }
    for (const b of await visible(page, ".sb-pill")) {
      await tryClick(b);
      await settle(page);
      await dismiss(page);
    }
    const a = await frames[0]!.boundingBox({ timeout: 1000 }).catch(() => null);
    const c = await frames[2]!.boundingBox({ timeout: 1000 }).catch(() => null);
    if (a && c) await drag(page, [a.x + a.width / 2, a.y + a.height / 2], [c.x + c.width / 2, c.y + c.height - 2]);
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+y");
    await page.keyboard.press("Delete");
    await page.keyboard.press("Control+z");
  });

  for (const mode of ["annotate", "edit"]) {
    test(`${mode} tools`, async ({ page }) => {
      await start(page, { doc: true });
      await page.click(`[data-mode=${mode}]`);
      const groups = await visible(page, ".tool-btn[data-group], .tool-btn[data-adjust]");
      for (let g = 0; g < groups.length; g++) {
        const group = (await visible(page, ".tool-btn[data-group], .tool-btn[data-adjust]"))[g];
        if (!group) continue;
        await tryClick(group);
        await settle(page);
        if (await page.locator("#adjust-view").isVisible()) {
          // Crop and Straighten open over the pages: try each page choice, then leave.
          for (const s of await visible(page, ".adj-scope button")) await tryClick(s);
          await page.keyboard.press("Escape");
          await settle(page);
          continue;
        }
        const subs = await visible(page, ".tool-row button, .studio-panel button");
        for (const s of subs.slice(0, 12)) {
          await tryClick(s);
          await settle(page, 80);
          await dismiss(page);
        }
        await tryClick(group);
        const box = await pageBox(page);
        const x = box.x + box.width * (0.2 + 0.1 * (g % 5));
        const y = box.y + box.height * (0.2 + 0.08 * (g % 6));
        await drag(page, [x, y], [x + 80, y + 50]);
        await settle(page);
        await page.keyboard.type("Hi");
        await page.mouse.click(box.x + 5, box.y + box.height - 5);
        await settle(page);
        await page.mouse.click(x + 40, y + 25);
        await settle(page, 100);
        await drag(page, [x + 40, y + 25], [x + 60, y + 45]);
        await drag(page, [x + 100, y + 70], [x + 140, y + 110]);
        await drag(page, [x + 20, y + 20], [x + 5, y + 5]);
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("Shift+ArrowDown");
        await page.mouse.dblclick(x + 50, y + 35);
        await settle(page, 100);
        await dismiss(page);
        await page.mouse.click(x + 50, y + 35, { button: "right" });
        await settle(page, 100);
        await dismiss(page);
        await page.keyboard.press("Control+z");
        await page.keyboard.press("Control+y");
        await page.keyboard.press("Delete");
        await page.keyboard.press("Control+z");
      }
      await expect(page.locator("#viewer-scroll")).toBeVisible();
    });
  }
});

test.describe("more", () => {
  test("tabs", async ({ page }) => {
    await start(page, { doc: true });
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Control+o");
      await settle(page, 800);
    }
    for (const t of await visible(page, ".side-tab[data-tab]")) {
      await tryClick(t);
      await settle(page, 300);
    }
    const tabs = await visible(page, ".side-tab[data-tab]");
    if (tabs.length > 1) {
      const a = await tabs[0]!.boundingBox({ timeout: 1000 }).catch(() => null);
      const b = await tabs[tabs.length - 1]!.boundingBox({ timeout: 1000 }).catch(() => null);
      if (a && b) await drag(page, [a.x + 20, a.y + a.height / 2], [b.x + b.width - 10, b.y + b.height / 2]);
      if (b) await drag(page, [b.x + 20, b.y + b.height / 2], [b.x + 20, b.y + 300]);
      await settle(page, 300);
    }
    await tryClick(page.locator(".side-tab[data-tab]").first(), { button: "right" });
    await dismiss(page);
    await page.keyboard.press("Control+Tab");
    await page.keyboard.press("Control+Shift+Tab");
    await page.keyboard.press("Control+w");
    await settle(page, 300);
    for (const c of await visible(page, ".side-tab-close")) {
      await tryClick(c);
      await settle(page, 300);
      for (const b of await visible(page, ".modal-backdrop:not(.hidden) button")) if (!(await tryClick(b))) break;
    }
  });

  for (const kind of ["crop", "straighten"]) {
    test(`${kind} pages`, async ({ page }) => {
      await start(page, { doc: true });
      await page.click("[data-mode=edit]");
      for (const n of [1, 2]) await tryClick(page.locator(`[data-page="${n}"] .page-sidebar-check`));
      await tryClick(page.locator(`[data-adjust=${kind}]`));
      await settle(page, 1200);
      for (let round = 0; round < 2; round++) {
        const box = await page.locator(".adj-cropbox").boundingBox({ timeout: 1000 }).catch(() => null);
        if (box) {
          await drag(page, [box.x + 2, box.y + 2], [box.x + 30, box.y + 40]);
          await drag(page, [box.x + box.width - 2, box.y + box.height - 2], [box.x + box.width - 40, box.y + box.height - 30]);
          await drag(page, [box.x + box.width / 2, box.y + 2], [box.x + box.width / 2, box.y + 20]);
          await drag(page, [box.x + 2, box.y + box.height / 2], [box.x + 20, box.y + box.height / 2]);
          await drag(page, [box.x + box.width / 2, box.y + box.height / 2], [box.x + box.width / 2 + 10, box.y + box.height / 2 + 10]);
        }
        for (const c of await visible(page, ".adj-corner")) {
          const cb = await c.boundingBox({ timeout: 1000 }).catch(() => null);
          if (!cb) continue;
          await drag(page, [cb.x + cb.width / 2, cb.y + cb.height / 2], [cb.x + cb.width / 2 + 15, cb.y + cb.height / 2 + 10]);
          for (const key of ["ArrowLeft", "ArrowRight", "Shift+ArrowUp", "ArrowDown"]) await page.keyboard.press(key);
          await settle(page, 800);
          await page.keyboard.press("Escape");
        }
        await page.keyboard.press("Control+s");
        for (const b of await page.locator(".adj-tools button").all()) {
          await b.dispatchEvent("click").catch(() => {});
          await settle(page, 600);
        }
        const thumbs = await visible(page, ".adj-thumb");
        if (thumbs[1]) await tryClick(thumbs[round === 0 ? 1 : 0]!);
        await settle(page, 800);
      }
      await page.locator(".adj-seg button").nth(kind === "crop" ? 1 : 0).dispatchEvent("click").catch(() => {});
      await settle(page, 800);
      await page.keyboard.press("Enter");
      await settle(page, 1500);
      await poke(page, ".modal-backdrop:not(.hidden)");
      await page.keyboard.press("Control+z");
      await page.keyboard.press("Control+y");
    });
  }

  test("signature", async ({ page }) => {
    await start(page, { doc: true });
    await page.click("[data-mode=annotate]");
    for (let round = 0; round < 2; round++) {
      await tryClick(page.locator("[data-group=sign]"));
      await settle(page, 400);
      if (!(await tryClick(page.locator(".sig-new").first()))) await page.locator(".sig-new").first().dispatchEvent("click").catch(() => {});
      await settle(page, 300);
      const canvas = await page.locator("#signature-canvas").boundingBox({ timeout: 1000 }).catch(() => null);
      if (canvas) {
        await drag(page, [canvas.x + 40, canvas.y + 100], [canvas.x + 200, canvas.y + 60]);
        await drag(page, [canvas.x + 200, canvas.y + 60], [canvas.x + 300, canvas.y + 140]);
        if (round === 0) await tryClick(page.locator("#sig-clear-btn"));
        if (round === 0) await drag(page, [canvas.x + 50, canvas.y + 50], [canvas.x + 250, canvas.y + 150]);
        if (round === 1) await tryClick(page.locator("#sig-image-btn"));
        await settle(page, 300);
        await tryClick(page.locator("#sig-place-btn"));
      }
      for (const c of await visible(page, ".sig-saved-card, .sig-chips > *")) await tryClick(c);
      await settle(page, 300);
      const box = await pageBox(page);
      await page.mouse.move(box.x + 150, box.y + 200);
      await page.mouse.click(box.x + 150, box.y + 200);
      await settle(page, 300);
      await drag(page, [box.x + 160, box.y + 205], [box.x + 220, box.y + 260]);
      await page.keyboard.press("Delete");
      await page.keyboard.press("Control+z");
    }
    await tryClick(page.locator("[data-group=sign]"));
    for (const d of await visible(page, ".sig-saved-delete")) await tryClick(d);
    await dismiss(page);
  });
});

test.describe("documents", () => {
  test("outlines, links, forms and passwords", async ({ page }) => {
    await start(page, { doc: true });
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("Control+o");
      await settle(page, 1200);
      const pw = page.locator(".modal-backdrop:not(.hidden) input[type=password]");
      if (await pw.count()) {
        await pw.first().fill("wrong");
        await page.keyboard.press("Enter");
        await settle(page, 400);
        await pw.first().fill("corpus").catch(() => {});
        await page.keyboard.press("Enter");
        await settle(page, 800);
        await dismiss(page);
      }
      await tryClick(page.locator(".sb-outline"));
      await settle(page, 300);
      for (const o of (await visible(page, ".outline-item, .page-sidebar-outline button, [class*=outline] li, [class*=outline-row]")).slice(0, 5)) {
        await tryClick(o);
        await settle(page, 200);
      }
      await tryClick(page.locator(".sb-outline"));
      for (const a of (await visible(page, ".annotationLayer a, .linkAnnotation a")).slice(0, 4)) {
        await tryClick(a);
        await settle(page, 300);
      }
      for (const f of (await visible(page, ".annotationLayer input, .annotationLayer select, .annotationLayer textarea")).slice(0, 8)) {
        const type = await f.getAttribute("type");
        if (type === "checkbox" || type === "radio") await tryClick(f);
        else if ((await f.evaluate((e) => e.tagName)) === "SELECT") await f.selectOption({ index: 1 }).catch(() => {});
        else await f.fill("Ada").catch(() => {});
      }
      await page.keyboard.press("Tab");
    }
    await page.keyboard.press("Control+s");
    await settle(page, 800);
    await poke(page, ".modal-backdrop:not(.hidden)");
    for (let i = 0; i < 7; i++) {
      await page.keyboard.press("Control+w");
      await settle(page, 300);
      for (const b of await visible(page, ".modal-backdrop:not(.hidden) .btn")) if (await tryClick(b)) break;
      await settle(page, 200);
    }
  });

  test("redact and save", async ({ page }) => {
    await start(page, { doc: true });
    await page.click("[data-mode=edit]");
    await tryClick(page.locator("[data-group=redact]"));
    const box = await pageBox(page);
    await drag(page, [box.x + 60, box.y + 60], [box.x + 200, box.y + 120]);
    await tryClick(page.locator("[data-redact=text]"));
    await drag(page, [box.x + 40, box.y + 200], [box.x + 300, box.y + 220]);
    await page.keyboard.press("Control+s");
    await settle(page, 1500);
    await poke(page, ".modal-backdrop:not(.hidden)");
    await page.locator(".modal-backdrop:not(.hidden) .btn-primary").first().click({ timeout: 1000 }).catch(() => {});
    await settle(page, 1500);
  });

  test("watermark a copy", async ({ page }) => {
    await start(page, { doc: true });
    await page.click("[data-mode=edit]");
    await page.locator(".edit-tools .tool-btn", { hasText: "Watermark" }).click();
    const dialog = page.locator(".watermark-box");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("textarea")).toHaveValue("For the sole purpose of ");
    await dialog.locator("textarea").pressSequentially("renting a flat");
    await expect(dialog.locator(".wm-count")).toHaveText("38/100");
    const preview = dialog.locator(".wm-page");
    await expect(preview).toHaveAttribute("data-ready", "true", { timeout: 10_000 });
    const b = (await preview.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 3);
    await page.mouse.move(b.x + b.width / 2 + 5, b.y + b.height / 3 + 5, { steps: 3 });
    await expect(dialog.locator(".wm-loupe")).toHaveClass(/on/);
    await dialog.locator(".btn-primary").click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });
    expect(await page.evaluate(() => (window as unknown as { __EZ_CALLS__: string[] }).__EZ_CALLS__)).toContain("watermark_pages");
  });

  test("create a stamp from a picture and place it", async ({ page }) => {
    await start(page, { doc: true });
    await page.click("[data-mode=edit]");
    await page.click(".edit-tools [data-group=stamp]");
    await page.click(".stamp-new");
    const dialog = page.locator(".stamp-maker-box");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".stm-file-name")).toHaveText("recu.svg");
    await expect(dialog.locator("input.ez-input")).toHaveValue("recu");
    await expect(dialog.locator("canvas")).toHaveAttribute("data-ready", "true");
    await dialog.locator(".stm-seg .opt-btn").nth(1).click();
    await dialog.locator(".stm-swatches .color-swatch").nth(3).click();
    await dialog.locator(".btn-primary").click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".stamp-chip")).toHaveCount(1);
    await expect(page.locator(".stamp-chip")).toHaveClass(/active/);
    const box = await pageBox(page);
    await page.mouse.click(box.x + 200, box.y + 300);
    await expect(page.locator(".studio-ann")).toHaveCount(1);

    await page.keyboard.press("Control+.");
    await expect(page.locator(".studio-panel")).toHaveClass(/collapsed/);
    await expect(page.locator(".tb-summary")).toHaveText("recu · Original · 35 mm");
    await page.click(".tb-summary");
    await expect(page.locator(".studio-panel")).not.toHaveClass(/collapsed/);

    await page.locator(".stamp-chip").hover();
    await page.locator(".stamp-chip .sig-chip-del").click();
    await expect(page.locator(".stamp-chip")).toHaveCount(0);
  });

  test("crop this page, the selection or all pages", async ({ page }) => {
    await start(page, { doc: true });
    await page.click("[data-mode=edit]");
    await page.click(".edit-tools [data-adjust=crop]");
    const title = page.locator(".adj-title");
    await expect(title).toHaveText("Adjust 1 page");
    await page.click(".adj-scope [data-scope=all]");
    await expect(title).toHaveText("Adjust 4 pages");
    await expect(page.locator(".adj-thumb")).toHaveCount(4);
    await page.click(".adj-scope [data-scope=this]");
    await expect(title).toHaveText("Adjust 1 page");
    await page.keyboard.press("Escape");
  });

  test("reorder pages by dragging", async ({ page }) => {
    await start(page, { doc: true });
    const frames = await visible(page, ".page-sidebar-frame");
    const a = await frames[0]!.boundingBox({ timeout: 1000 }).catch(() => null);
    const c = await frames[3]!.boundingBox({ timeout: 1000 }).catch(() => null);
    if (!a || !c) return;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await settle(page, 600);
    for (let i = 1; i <= 15; i++) await page.mouse.move(a.x + a.width / 2, a.y + ((c.y + c.height + 40 - a.y) * i) / 15, { steps: 2 });
    await settle(page, 400);
    await page.mouse.move(a.x + a.width / 2, 2000, { steps: 5 });
    await settle(page, 400);
    await page.mouse.move(c.x + c.width / 2, c.y + c.height - 4, { steps: 5 });
    await page.mouse.up();
    await settle(page, 400);
    const input = page.locator(".page-nav-input");
    await input.fill("3").catch(() => {});
    await input.press("Enter").catch(() => {});
    await input.press("ArrowUp").catch(() => {});
    await input.press("ArrowDown").catch(() => {});
    await page.keyboard.press("Control+z");
  });

  test("drag pages onto the document to open them in a new tab", async ({ page }) => {
    await start(page, { doc: true });
    const frame = page.locator('[data-page="1"] .page-sidebar-frame');
    const a = await frame.boundingBox();
    const viewer = await page.locator("#viewer-scroll").boundingBox();
    if (!a || !viewer) throw new Error("no layout");
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(viewer.x + viewer.width / 2, viewer.y + viewer.height / 2, { steps: 8 });
    await expect(page.locator(".page-sidebar-ghost")).toHaveText("Release to open in a new tab");
    await expect(page.locator("#menubar-row")).toHaveClass(/tab-drop-target/);
    await page.mouse.up();
    await expect(page.locator(".side-tab[data-tab]")).toHaveCount(2);
    await expect(page.locator("#menubar-row")).not.toHaveClass(/tab-drop-target/);
    await expect(page.locator(".side-tab.active")).toContainText("(page 1)");
  });
});

test.describe("motion", () => {
  test.use({ reducedMotion: "no-preference" });
  test("opening screen dots follow the mouse", async ({ page }) => {
    await start(page);
    for (let i = 0; i < 20; i++) {
      await page.mouse.move(200 + i * 30, 300 + (i % 5) * 40);
      await settle(page, 60);
    }
    await page.mouse.click(640, 430);
    await settle(page, 1500);
    await page.setViewportSize({ width: 900, height: 700 });
    await settle(page, 500);
  });
});

test.describe("annotations", () => {
  test("notes, highlights, stamps and text boxes", async ({ page }) => {
    await start(page, { doc: true });
    await page.click("[data-mode=annotate]");
    const box = await pageBox(page);

    await tryClick(page.locator("[data-group=note]"));
    await page.mouse.click(box.x + 120, box.y + 140);
    await settle(page, 300);
    await page.keyboard.type("A sticky note");
    await page.mouse.click(box.x + 10, box.y + box.height - 10);
    await settle(page, 300);
    await page.mouse.dblclick(box.x + 125, box.y + 145);
    await settle(page, 300);
    await page.keyboard.type(" edited");
    await page.keyboard.press("Escape");
    await drag(page, [box.x + 125, box.y + 145], [box.x + 180, box.y + 200]);

    await tryClick(page.locator("[data-group=text]"));
    await page.mouse.click(box.x + 100, box.y + 300);
    await settle(page, 300);
    await page.keyboard.type("Some longer text that wraps");
    await page.keyboard.press("Enter");
    await page.keyboard.type("second line");
    await page.mouse.click(box.x + 10, box.y + box.height - 10);
    await settle(page, 300);
    await page.mouse.click(box.x + 110, box.y + 305);
    await settle(page, 200);
    await poke(page, ".studio-panel");
    await page.mouse.dblclick(box.x + 110, box.y + 305);
    await page.keyboard.type("!");
    await page.keyboard.press("Escape");

    await tryClick(page.locator("[data-group=highlight]"));
    const spans = await visible(page, "#viewer-scroll .textLayer span");
    for (const span of spans.slice(0, 3)) {
      const b = await span.boundingBox({ timeout: 1000 }).catch(() => null);
      if (b) await drag(page, [b.x + 1, b.y + b.height / 2], [b.x + b.width - 1, b.y + b.height / 2]);
      await settle(page, 200);
    }
    await drag(page, [box.x + 50, box.y + 450], [box.x + 300, box.y + 470]);
    await settle(page, 200);
    await page.mouse.click(box.x + 150, box.y + 460);
    await poke(page, ".studio-panel, [class*=popover]");
    await page.keyboard.press("Delete");

    await page.click("[data-mode=edit]");
    await tryClick(page.locator("[data-group=stamp]"));
    for (const [g, dx] of [["check", 60], ["cross", 120]] as const) {
      await tryClick(page.locator(`[data-mark=${g}]`));
      await page.mouse.click(box.x + dx, box.y + 560);
      await settle(page, 200);
      await page.mouse.click(box.x + dx, box.y + 560);
      await drag(page, [box.x + dx, box.y + 560], [box.x + dx + 30, box.y + 600]);
      await poke(page, ".studio-panel");
    }
    await tryClick(page.locator("[data-group=image]"));
    await settle(page, 500);
    await page.mouse.click(box.x + 250, box.y + 250);
    await settle(page, 500);
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+c");
    await page.keyboard.press("Control+v");
    await settle(page, 300);
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+y");
  });
  test("copy, paste and duplicate annotations", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await start(page, { doc: true });
    await page.click("[data-mode=annotate]");
    const box = await pageBox(page);
    const rows = page.locator(".studio-ann");

    await tryClick(page.locator("[data-group=note]"));
    await page.mouse.click(box.x + 120, box.y + 140);
    await settle(page, 300);
    await page.keyboard.type("Copy me");
    await page.mouse.click(box.x + 10, box.y + box.height - 10);
    await settle(page, 300);
    await expect(rows).toHaveCount(1);

    await page.mouse.click(box.x + 125, box.y + 145);
    await settle(page, 200);
    await page.keyboard.press("Control+d");
    await expect(rows).toHaveCount(2);

    await page.keyboard.press("Control+c");
    await settle(page, 200);
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("Copy me");
    await page.keyboard.press("Control+v");
    await expect(rows).toHaveCount(3);
    await page.keyboard.press("Control+v");
    await expect(rows).toHaveCount(4);

    await page.keyboard.press("Control+z");
    await expect(rows).toHaveCount(3);

    await page.evaluate(() => navigator.clipboard.writeText("copied elsewhere"));
    await page.keyboard.press("Control+v");
    await settle(page, 300);
    await expect(rows).toHaveCount(3);
  });
});
