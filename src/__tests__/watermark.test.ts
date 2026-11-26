// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { dotColor, negateUnder, newCopyCode, watermarkGeometry, watermarkPhrase } from "../watermark";
import { setUpWatermark, watermarkedName, type WatermarkDeps } from "../watermark-flow";
import { WatermarkModal, watermarkPages } from "../watermark-modal";

describe("watermark text", () => {
  it("joins text, code and date in capitals, with a separator to repeat on", () => {
    expect(watermarkPhrase({ text: "  Pour la  location ", code: "7K2Q9F", date: "26/11/2026" }, "Copie unique"))
      .toBe("POUR LA LOCATION :: COPIE UNIQUE 7K2Q9F :: 26/11/2026 ::");
    expect(watermarkPhrase({ text: "Pour la location", code: null, date: null }, "Copie unique")).toBe("POUR LA LOCATION ::");
  });

  it("makes six-character codes without look-alike letters", () => {
    const code = newCopyCode((n) => new Uint8Array(n).map((_, i) => i * 40));
    expect(code).toMatch(/^[2-9A-HJ-KM-NP-Z]{6}$/);
    expect(newCopyCode()).toHaveLength(6);
    // Bytes past the last full round of the alphabet are skipped, not folded onto its start.
    let call = 0;
    const skewed = (n: number) => new Uint8Array(n).fill(call++ === 0 ? 255 : 0);
    expect(newCopyCode(skewed)).toBe("222222");
  });

  it("scales with the page so the preview matches the saved file", () => {
    const small = watermarkGeometry(250);
    const big = watermarkGeometry(1000);
    expect(big.fontSize / small.fontSize).toBeCloseTo(4);
    expect(big.dotStep / small.dotStep).toBeCloseTo(4);
  });

  it("names the copy after the original", () => {
    expect(watermarkedName("C:\\docs\\ID card.pdf", "watermarked")).toBe("C:\\docs\\ID card-watermarked.pdf");
    expect(watermarkedName("/home/a/scan", "filigrane")).toBe("/home/a/scan-filigrane.pdf");
  });
});

describe("watermark dialog", () => {
  function modal(): WatermarkModal {
    document.body.innerHTML = "";
    vi.stubGlobal("requestAnimationFrame", () => 0);
    const m = new WatermarkModal();
    m.open(() => new Promise(() => {}), "26/11/2026");
    return m;
  }

  it("suggests a text, today's date and a code, all switched on", () => {
    const m = modal();
    const o = m.options();
    expect(o.text).toBe("For the sole purpose of ");
    expect(o.date).toBe("26/11/2026");
    expect(o.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(o.opacity).toBeCloseTo(0.6);
    expect(m.box.querySelector(".wm-code")!.textContent).toBe(o.code);
  });

  it("leaves out what is unchecked and blocks an empty text", () => {
    const m = modal();
    const boxes = m.box.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    boxes.forEach((b) => { b.checked = false; b.dispatchEvent(new Event("change")); });
    expect(m.options().date).toBeNull();
    expect(m.options().code).toBeNull();
    const text = m.box.querySelector<HTMLTextAreaElement>("textarea")!;
    text.value = "   ";
    text.dispatchEvent(new Event("input"));
    expect(m.okBtn.disabled).toBe(true);
  });
});

describe("watermark pages and dots", () => {
  it("lists the pages of each choice", () => {
    expect(watermarkPages("all", "", 2, 4)).toEqual([1, 2, 3, 4]);
    expect(watermarkPages("this", "", 2, 4)).toEqual([2]);
    expect(watermarkPages("pick", "1, 3-4", 2, 4)).toEqual([1, 3, 4]);
    expect(watermarkPages("pick", "", 2, 4)).toBeNull();
    expect(watermarkPages("pick", "7", 2, 4)).toBeNull();
  });

  it("darkens light pixels and lightens dark ones, mid-tones included", () => {
    expect(dotColor(255, 255, 255).every((c) => c < 60)).toBe(true);
    expect(dotColor(0, 0, 0).every((c) => c > 200)).toBe(true);
    const [r, g, b] = dotColor(60, 110, 70);
    expect(Math.min(r, g, b)).toBeGreaterThan(200);
    const grey = dotColor(150, 150, 150);
    expect(grey[0]).toBeLessThan(40);
  });

  it("only touches the pixels under the mask, by its alpha and the opacity", () => {
    const page = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255]);
    const mask = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0]);
    negateUnder(page, mask, 0.5);
    expect(page[0]).toBeLessThan(160);
    expect(page[0]).toBeGreaterThan(120);
    expect([...page.slice(4)]).toEqual([255, 255, 255, 255]);
  });
});

describe("watermark dialog pages", () => {
  it("offers all pages, this one or a typed list, and blocks an unreadable list", () => {
    document.body.innerHTML = "";
    vi.stubGlobal("requestAnimationFrame", () => 0);
    const m = new WatermarkModal();
    m.open(() => new Promise(() => {}), "26/11/2026", { current: 3, total: 5 });
    expect(m.options().pages).toEqual([1, 2, 3, 4, 5]);
    m.box.querySelector<HTMLButtonElement>("[data-pages=this]")!.click();
    expect(m.options().pages).toEqual([3]);
    m.box.querySelector<HTMLButtonElement>("[data-pages=pick]")!.click();
    const input = m.box.querySelector<HTMLInputElement>(".wm-page-input")!;
    input.value = "2-9";
    input.dispatchEvent(new Event("input"));
    expect(m.okBtn.disabled).toBe(true);
    input.value = "2, 4";
    input.dispatchEvent(new Event("input"));
    expect(m.okBtn.disabled).toBe(false);
    expect(m.options().pages).toEqual([2, 4]);
  });
});

describe("watermark flow", () => {
  function deps(over: Partial<WatermarkDeps> = {}) {
    let confirm: ((o: never) => Promise<void>) | null = null;
    const d = {
      session: { isOpen: true, sourcePath: "/d/id.pdf", materialize: vi.fn(async () => "/tmp/current.pdf") },
      modal: {
        isOpen: false, copyLabel: "Unique copy",
        open: vi.fn(), close: vi.fn(), startRunning: vi.fn(), setProgress: vi.fn(), finishRunning: vi.fn(),
        onConfirm: (h: (o: never) => Promise<void>) => { confirm = h; },
      },
      refuse: () => false,
      messages: { msg: (k: string, v?: Record<string, string>) => (k === "msgWmFileSuffix" ? "watermarked" : `${k}:${v?.name ?? v?.err ?? ""}`), errText: String },
      ui: { notify: vi.fn(), ask: vi.fn() },
      backend: { savePdfDialog: vi.fn(async (s: string) => s) },
      renderPreview: vi.fn(),
      burn: vi.fn(async () => {}),
      today: () => "26/11/2026",
      pages: () => ({ current: 2, total: 3 }),
      ...over,
    } as unknown as WatermarkDeps;
    const open = setUpWatermark(d);
    return { d, open, confirm: () => confirm! };
  }

  it("saves a copy next to the original and leaves the original alone", async () => {
    const { d, open, confirm } = deps();
    await open();
    const o = { text: "x", date: null, code: "ABCDEF", opacity: 0.6, pages: [1, 2] };
    await confirm()(o as never);
    expect(d.backend.savePdfDialog).toHaveBeenCalledWith("/d/id-watermarked.pdf");
    expect(d.burn).toHaveBeenCalledWith("/tmp/current.pdf", "/d/id-watermarked.pdf", o, "Unique copy", expect.any(Function));
    expect(d.modal.close).toHaveBeenCalled();
    expect(d.ui.notify).toHaveBeenCalledWith("msgWatermarked:id-watermarked.pdf");
  });

  it("reports a failure and keeps the dialog open", async () => {
    const { d, open, confirm } = deps({ burn: vi.fn(async () => { throw new Error("disk full"); }) });
    await open();
    await confirm()({ text: "x", date: null, code: null, opacity: 1, pages: [1] } as never);
    expect(d.modal.close).not.toHaveBeenCalled();
    expect(d.ui.notify).toHaveBeenCalledWith("msgWatermarkFailed:Error: disk full", true);
  });

  it("opens on the page in view and saves nothing without pages", async () => {
    const { d, open, confirm } = deps();
    await open();
    expect(d.modal.open).toHaveBeenCalledWith(expect.any(Function), "26/11/2026", { current: 2, total: 3 });
    await confirm()({ text: "x", date: null, code: null, opacity: 1, pages: [] } as never);
    expect(d.backend.savePdfDialog).not.toHaveBeenCalled();
  });

  it("does nothing on a protected document", async () => {
    const { d, open } = deps({ refuse: () => true });
    await open();
    expect(d.modal.open).not.toHaveBeenCalled();
  });
});
