// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { joinPages, OcrModal, type OcrDeps, type OcrResult } from "../ocr-modal";

const result = (text: string): OcrResult => ({
  text,
  language: "en-US",
  lines: text.split("\n").map((t) => ({ text: t, words: t.split(" ").map((w, i) => ({ text: w, x: i * 0.2, y: 0.1, w: 0.15, h: 0.05 })) })),
});

const flush = () => new Promise((r) => setTimeout(r, 0));

function setUp(pageCount = 3, over: Partial<OcrDeps> = {}) {
  document.body.innerHTML = "";
  const deps: OcrDeps = {
    pageCount: () => pageCount,
    currentPage: () => 2,
    materialize: vi.fn(async () => "/tmp/doc.pdf"),
    renderPage: vi.fn(async (_p: string, n: number) => `data:image/png;base64,PAGE${n}`),
    languages: async () => [{ tag: "fr-FR", name: "Français" }, { tag: "en-US", name: "English" }],
    recognize: vi.fn(async (data: string) => result(`Hello ${data.slice(-5)}`)),
    pickPicture: async () => ({ dataUrl: "data:image/png;base64,PIC", name: "scan.png" }),
    copy: vi.fn(async () => {}),
    errText: (e) => String(e),
    ...over,
  };
  const modal = new OcrModal(deps);
  return { modal, deps, q: <T extends Element>(sel: string) => modal.box.querySelector<T & HTMLElement>(sel)! };
}

describe("OCR dialog", () => {
  it("reads the current page, outlines the words and copies the text", async () => {
    const { modal, deps, q } = setUp();
    modal.open();
    await flush(); await flush();
    expect(deps.renderPage).toHaveBeenCalledWith("/tmp/doc.pdf", 2);
    expect(q<HTMLTextAreaElement>(".ocr-text").value).toBe("Hello PAGE2");
    expect(modal.box.querySelectorAll(".ocr-word")).toHaveLength(2);
    expect(q(".ocr-page").textContent).toBe("Page 2 / 3");
    expect(q(".ocr-status").textContent).toBe("2 words found.");
    modal.okBtn.click();
    await flush();
    expect(deps.copy).toHaveBeenCalledWith("Hello PAGE2");
    expect(q(".ocr-status").textContent).toBe("Text copied to the clipboard.");
  });

  it("reads every page, once each", async () => {
    const { modal, deps, q } = setUp();
    modal.open();
    await flush(); await flush();
    [...modal.box.querySelectorAll<HTMLButtonElement>(".btn")].find((b) => b.textContent === "All pages")!.click();
    for (let i = 0; i < 10; i++) await flush();
    expect(q<HTMLTextAreaElement>(".ocr-text").value).toBe("— 1 —\nHello PAGE1\n\n— 2 —\nHello PAGE2\n\n— 3 —\nHello PAGE3");
    expect(deps.recognize).toHaveBeenCalledTimes(3);
    expect(deps.materialize).toHaveBeenCalledTimes(1);
  });

  it("reads a picture when no document is open", async () => {
    const { modal, deps, q } = setUp(0);
    modal.open();
    await flush();
    expect(q(".ocr-nav").hidden).toBe(true);
    expect(modal.okBtn.disabled).toBe(true);
    [...modal.box.querySelectorAll<HTMLButtonElement>(".btn")].find((b) => b.textContent === "Open a picture…")!.click();
    for (let i = 0; i < 5; i++) await flush();
    expect(deps.recognize).toHaveBeenCalledWith("data:image/png;base64,PIC", "");
    expect(q<HTMLTextAreaElement>(".ocr-text").value).toBe("Hello 4,PIC");
    expect(modal.okBtn.disabled).toBe(false);
  });

  it("shows why it failed", async () => {
    const { modal, q } = setUp(1, { recognize: async () => { throw new Error("no language"); } });
    modal.open();
    for (let i = 0; i < 5; i++) await flush();
    expect(q(".ocr-status").textContent).toBe("Error: no language");
    expect(q(".ocr-status").classList.contains("error")).toBe(true);
  });

  it("puts a heading per page only when there are several", () => {
    expect(joinPages([[1, "a"]])).toBe("a");
    expect(joinPages([[1, "a"], [3, "b"]])).toBe("— 1 —\na\n\n— 3 —\nb");
  });
});
