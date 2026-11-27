import type { Page } from "@playwright/test";
import { expect, start, test } from "./fixture";
import { drag, pageBox, settle } from "./helpers";

type Saved = { kind: string; page: number; color?: { r: number; g: number; b: number }; opacity?: number; strokeWidth?: number; content?: string; bold?: boolean; fontFamily?: string; points?: [number, number][]; x: number; y: number };

async function saved(page: Page): Promise<Saved[]> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    (window as unknown as { __EZ_SAVED__: unknown }).__EZ_SAVED__ = null;
  });
  await page.keyboard.press("Control+s");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __EZ_SAVED__: unknown }).__EZ_SAVED__)).not.toBeNull();
  return page.evaluate(() => (window as unknown as { __EZ_SAVED__: Saved[] }).__EZ_SAVED__);
}

async function selectWords(page: Page, from: number, to: number) {
  const spans = page.locator("#viewer-scroll .page-wrapper").first().locator(".page-text-layer span");
  const a = (await spans.nth(from).boundingBox())!;
  const b = (await spans.nth(to).boundingBox())!;
  await page.mouse.move(a.x + 1, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 1, b.y + b.height / 2, { steps: 6 });
  await page.mouse.up();
  await settle(page, 200);
}

async function drawRect(page: Page, from: [number, number], to: [number, number]) {
  await page.click("[data-group=shapes]");
  await drag(page, from, to);
  await page.keyboard.press("Escape");
  await settle(page, 150);
}

const options = (page: Page) => page.locator(".studio-panel .opt-panel:not([hidden])");
const rows = (page: Page) => page.locator(".studio-ann");
const slider = (page: Page, n: number) => options(page).locator(".slider-row input:visible").nth(n);

test.describe("annotation editing", () => {
  test("highlight text, recolor it and copy its words", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await start(page, { doc: true });
    await page.click("[data-mode=annotate]");
    await page.click("[data-group=highlight]");
    await selectWords(page, 0, 2);
    await expect(rows(page)).toHaveCount(1);
    const [first] = await saved(page);
    expect(first).toMatchObject({ kind: "highlight", page: 1, color: { r: 254, g: 240, b: 138 } });

    await page.keyboard.press("Escape");
    const span = (await page.locator("#viewer-scroll .page-wrapper").first().locator(".page-text-layer span").first().boundingBox())!;
    await page.mouse.click(span.x + 5, span.y + span.height / 2);
    await expect(page.locator(".sel-pill")).toBeVisible();
    await page.click(".sel-pill-color");
    await page.click(".sel-pill-swatch >> nth=1");
    expect((await saved(page))[0]!.color).not.toEqual(first!.color);

    await page.mouse.click(span.x + 5, span.y + span.height / 2);
    await page.click(".sel-pill-copy");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("contrat");

    await page.mouse.click(span.x + 5, span.y + span.height / 2);
    const opacity = slider(page, 0);
    await opacity.fill(String(await opacity.getAttribute("min")));
    expect((await saved(page))[0]!.opacity).toBeLessThan(first!.opacity!);

    await page.click("[data-group=highlight]");
    await selectWords(page, 0, 2);
    await expect(rows(page)).toHaveCount(0);
  });

  test("restyle a selected shape and text box from the panel", async ({ page }) => {
    await start(page, { doc: true });
    await page.click("[data-mode=annotate]");
    const box = await pageBox(page);
    await drawRect(page, [box.x + 100, box.y + 400], [box.x + 250, box.y + 500]);
    await page.mouse.click(box.x + 100, box.y + 450);
    await options(page).locator(".color-swatch[data-hex='#2563eb']").first().click();
    const thickness = slider(page, 0);
    await thickness.fill(String(await thickness.getAttribute("max")));
    const rect = (await saved(page)).find((a) => a.kind === "rect")!;
    expect(rect.color).toEqual({ r: 37, g: 99, b: 235 });
    expect(rect.strokeWidth).toBeGreaterThan(2);

    await page.click("[data-group=text]");
    await page.mouse.click(box.x + 100, box.y + 200);
    await settle(page, 300);
    await page.keyboard.type("Styled");
    await page.mouse.click(box.x + 10, box.y + box.height - 10);
    await page.keyboard.press("Escape");
    await settle(page, 200);
    await page.mouse.click(box.x + 108, box.y + 195);
    await options(page).locator(".opt-bold").click();
    await options(page).locator("select").first().selectOption("times");
    await options(page).locator(".color-swatch[data-hex='#e53935']").first().click();
    const text = (await saved(page)).find((a) => a.kind === "text")!;
    expect(text).toMatchObject({ content: "Styled", bold: true, fontFamily: "times", color: { r: 229, g: 57, b: 53 } });
  });

  test("drag a shape onto the next page", async ({ page }) => {
    await start(page, { doc: true });
    await page.click("[data-mode=annotate]");
    await expect(async () => {
      await page.locator("#viewer-scroll").evaluate((el) => { el.scrollTop = 400; });
      await settle(page, 200);
      expect((await pageBox(page, 1)).y).toBeLessThan(500);
    }).toPass();
    const one = await pageBox(page, 0);
    const two = await pageBox(page, 1);
    const top = one.y + one.height - 120;
    await drawRect(page, [one.x + 100, top], [one.x + 200, top + 60]);
    await expect(rows(page).first()).toHaveAttribute("data-page", "1");
    await page.mouse.click(one.x + 125, top);
    await drag(page, [one.x + 125, top], [two.x + 120, two.y + 100]);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toHaveAttribute("data-page", "2");
    expect((await saved(page))[0]!.page).toBe(2);
    await page.keyboard.press("Control+z");
    await expect(rows(page).first()).toHaveAttribute("data-page", "1");
  });

  test("move a corner of a freeform redaction", async ({ page }) => {
    await start(page, { doc: true });
    await page.click("[data-mode=edit]");
    await page.click("[data-group=redact]");
    await page.click("[data-redact=area]");
    await page.click(".studio-panel button:visible:has-text(\"Freeform\")");
    const box = await pageBox(page);
    const corners: [number, number][] = [[100, 300], [260, 300], [260, 420], [100, 420]];
    await page.mouse.move(box.x + corners[0]![0], box.y + corners[0]![1]);
    await page.mouse.down();
    for (const [x, y] of [...corners.slice(1), corners[0]!]) await page.mouse.move(box.x + x, box.y + y, { steps: 4 });
    await page.mouse.up();
    await expect(rows(page)).toHaveCount(1);
    await page.keyboard.press("Escape");
    const pill = page.locator(".sel-pill");
    const outside: [number, number] = [box.x + 320, box.y + 470];
    const away: [number, number] = [box.x + 400, box.y + 150];
    await page.mouse.click(...outside);
    await expect(pill).toHaveCount(0);
    await page.mouse.click(box.x + 180, box.y + 360);
    await expect(pill).toBeVisible();
    await drag(page, [box.x + 260, box.y + 420], [box.x + 340, box.y + 490]);
    await page.mouse.click(...away);
    await expect(pill).toHaveCount(0);
    await page.mouse.click(...outside);
    await expect(pill).toBeVisible();
    await page.mouse.click(...away);
    await page.keyboard.press("Control+z");
    await page.mouse.click(...outside);
    await expect(pill).toHaveCount(0);
  });

  test("edit the words of a text box after placing it", async ({ page }) => {
    await start(page, { doc: true });
    await page.click("[data-mode=annotate]");
    const box = await pageBox(page);
    await page.click("[data-group=text]");
    await page.mouse.click(box.x + 100, box.y + 200);
    await settle(page, 300);
    await page.keyboard.type("Draft");
    await page.mouse.click(box.x + 10, box.y + box.height - 10);
    await page.keyboard.press("Escape");
    await settle(page, 200);
    await page.mouse.dblclick(box.x + 108, box.y + 195);
    await settle(page, 200);
    await page.keyboard.type("Final wording");
    await page.keyboard.press("Enter");
    expect((await saved(page)).find((a) => a.kind === "text")!.content).toBe("Final wording");
    await page.keyboard.press("Control+z");
    expect((await saved(page)).find((a) => a.kind === "text")!.content).toBe("Draft");
  });

  test("pick and delete annotations from the list", async ({ page }) => {
    await start(page, { doc: true });
    await page.click("[data-mode=annotate]");
    const one = await pageBox(page);
    await drawRect(page, [one.x + 100, one.y + 100], [one.x + 200, one.y + 160]);
    await page.locator("#viewer-scroll .page-wrapper").nth(3).scrollIntoViewIfNeeded();
    await settle(page, 400);
    const four = await pageBox(page, 3);
    await drawRect(page, [four.x + 100, four.y + 100], [four.x + 200, four.y + 160]);
    await expect(rows(page)).toHaveCount(2);

    const scroll = page.locator("#viewer-scroll");
    await page.locator(".studio-ann[data-page='1']").click();
    await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeLessThan(200);
    await expect(page.locator(".sel-pill")).toBeVisible();
    await page.locator(".studio-ann[data-page='4']").focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(1000);

    await page.locator(".studio-ann[data-page='4'] .studio-ann-del").click();
    await expect(rows(page)).toHaveCount(1);
    await page.locator(".studio-ann[data-page='1']").focus();
    await page.keyboard.press("Delete");
    await expect(rows(page)).toHaveCount(0);
    await page.keyboard.press("Control+z");
    await expect(rows(page)).toHaveCount(1);
  });
});
