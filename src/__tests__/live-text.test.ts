// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { LiveText, hasRealText, layoutOcr, renderOcrLayer } from "../live-text";
import type { OcrResult } from "../ocr-modal";

/** 10 px per character at font size 20, proportional otherwise. */
const measure = (text: string, size: number) => text.length * size / 2;

const result = (lines: { x: number; y: number; w: number; h: number; text: string }[][]): OcrResult => ({
  text: "",
  language: "fr-FR",
  lines: lines.map((words) => ({ text: words.map((w) => w.text).join(" "), words })),
});

describe("hasRealText", () => {
  it("is false for a page with no items or only a page number", () => {
    expect(hasRealText([])).toBe(false);
    expect(hasRealText([{ str: " 12 " }, { str: "" }])).toBe(false);
  });
  it("is true once a few letters are there", () => {
    expect(hasRealText([{ str: "Hello" }, { str: " world" }])).toBe(true);
  });
  it("ignores marked-content items without a string", () => {
    expect(hasRealText([{ type: "beginMarkedContent" }, { str: "abc" }])).toBe(false);
  });
});

describe("layoutOcr", () => {
  it("places each word over its box, a trailing space between words", () => {
    const lines = layoutOcr(result([[
      { text: "Bonjour", x: 0.1, y: 0.2, w: 0.2, h: 0.02 },
      { text: "Alex", x: 0.35, y: 0.2, w: 0.1, h: 0.02 },
    ]]), 1000, 1000, measure);
    expect(lines).toHaveLength(1);
    const [l] = lines;
    expect(l.left).toBeCloseTo(100);
    expect(l.top).toBeCloseTo(200);
    expect(l.fontSize).toBeCloseTo(20);
    expect(l.words.map((w) => w.text)).toEqual(["Bonjour ", "Alex"]);
    // "Bonjour" is 70 px wide naturally and 200 px on the picture.
    expect(l.words[0].margin).toBeCloseTo(0);
    expect(l.words[0].scaleX).toBeCloseTo(200 / 70);
    // The second word starts where "Bonjour " ends in layout (100 + 80) → margin 170.
    expect(l.words[1].margin).toBeCloseTo(350 - 180);
    expect(l.words[1].scaleX).toBeCloseTo(100 / 40);
    expect(l.words[1].dy).toBeCloseTo(0);
  });

  it("sorts words left to right and drops empty words and lines", () => {
    const lines = layoutOcr(result([
      [{ text: "b", x: 0.5, y: 0.1, w: 0.05, h: 0.02 }, { text: "a", x: 0.1, y: 0.1, w: 0.05, h: 0.02 }],
      [{ text: "  ", x: 0.1, y: 0.3, w: 0.05, h: 0.02 }],
    ]), 1000, 1000, measure);
    expect(lines).toHaveLength(1);
    expect(lines[0].words.map((w) => w.text)).toEqual(["a ", "b"]);
  });
});

describe("renderOcrLayer", () => {
  it("adds one line block per line and copies as lines of words", () => {
    const layer = document.createElement("div");
    const pdfSpan = document.createElement("span");
    layer.append(pdfSpan);
    renderOcrLayer(layer, layoutOcr(result([
      [{ text: "Hello", x: 0.1, y: 0.1, w: 0.1, h: 0.02 }, { text: "world", x: 0.25, y: 0.1, w: 0.1, h: 0.02 }],
      [{ text: "Again", x: 0.1, y: 0.2, w: 0.1, h: 0.02 }],
    ]), 800, 1000, measure));
    const lines = layer.querySelectorAll(".ocr-line");
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toBe("Hello world");
    expect(layer.classList.contains("has-ocr")).toBe(true);
    // Laying out again replaces the words, and keeps the PDF's own spans.
    renderOcrLayer(layer, []);
    expect(layer.querySelectorAll(".ocr-line")).toHaveLength(0);
    expect(layer.contains(pdfSpan)).toBe(true);
  });
});

describe("LiveText", () => {
  const fakePage = (n: number) => ({
    pageNumber: n,
    getViewport: () => ({ width: 100, height: 100 }),
    render: () => ({ promise: Promise.resolve() }),
  }) as never;

  // jsdom has no canvas: stub what the reader draws with.
  HTMLCanvasElement.prototype.getContext = (() => ({ fillRect() {}, fillStyle: "" })) as never;
  HTMLCanvasElement.prototype.toDataURL = () => "data:image/jpeg;base64,AA==";

  it("reads a page once and serves it from the cache", async () => {
    const rec = vi.fn(async () => result([]));
    const lt = new LiveText(rec);
    await lt.read(fakePage(1), 0, () => true);
    await lt.read(fakePage(1), 0, () => true);
    expect(rec).toHaveBeenCalledTimes(1);
    await lt.read(fakePage(1), 90, () => true);
    expect(rec).toHaveBeenCalledTimes(2);
    lt.reset();
    await lt.read(fakePage(1), 0, () => true);
    expect(rec).toHaveBeenCalledTimes(3);
  });

  it("skips pages no longer wanted, and reads them when they come back", async () => {
    const rec = vi.fn(async () => result([]));
    const lt = new LiveText(rec);
    expect(await lt.read(fakePage(2), 0, () => false)).toBeNull();
    expect(rec).not.toHaveBeenCalled();
    expect(await lt.read(fakePage(2), 0, () => true)).not.toBeNull();
    expect(rec).toHaveBeenCalledTimes(1);
  });

  it("stops for the session when the system has no OCR", async () => {
    const rec = vi.fn(async () => { throw { code: "no-ocr-language" }; });
    const lt = new LiveText(rec);
    expect(await lt.read(fakePage(1), 0, () => true)).toBeNull();
    expect(await lt.read(fakePage(2), 0, () => true)).toBeNull();
    expect(rec).toHaveBeenCalledTimes(1);
  });
});
