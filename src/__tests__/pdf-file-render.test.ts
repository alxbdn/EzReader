// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const destroy = vi.fn(async () => {});
const cleanup = vi.fn();
const getDocument = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `asset://${p}` }));
vi.mock("../pdfjs", () => ({ pdfjsLib: async () => ({ getDocument }) }));

const { bakePages, renderRedactedPages, withPdfFile } = await import("../pdf-file-render");

const viewport = (scale: number) => ({
  width: 100 * scale,
  height: 200 * scale,
  convertToViewportPoint: (x: number, y: number) => [x * scale, y * scale],
});

const fakePage = () => ({
  view: [0, 0, 100, 200],
  rotate: 0,
  getViewport: ({ scale }: { scale: number }) => viewport(scale),
  render: () => ({ promise: Promise.resolve() }),
  cleanup,
});

const fakeDoc = (numPages: number) => {
  const doc = { numPages, loadingTask: { destroy }, getPage: vi.fn(async () => fakePage()) };
  getDocument.mockReturnValue({ promise: Promise.resolve(doc) });
  return doc;
};

const drawn: string[] = [];

beforeEach(() => {
  destroy.mockClear();
  cleanup.mockClear();
  getDocument.mockReset();
  drawn.length = 0;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    return {
      canvas: this,
      fillRect: (...a: number[]) => drawn.push(`fill ${a.join(",")}`),
      beginPath() {}, ellipse() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
    };
  } as never;
  HTMLCanvasElement.prototype.toDataURL = () => "data:image/jpeg;base64,AAAA";
});

describe("withPdfFile", () => {
  it("opens the file through the asset protocol and releases it after use", async () => {
    fakeDoc(3);
    const pages = await withPdfFile("/tmp/a.pdf", async (doc) => doc.numPages);
    expect(pages).toBe(3);
    expect(getDocument.mock.calls[0][0].url).toMatch(/^asset:\/\/\/tmp\/a\.pdf\?t=\d+$/);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("releases the file when the work throws", async () => {
    fakeDoc(1);
    await expect(withPdfFile("/tmp/a.pdf", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe("bakePages", () => {
  it("bakes every page in range, reports progress and frees each page", async () => {
    const doc = fakeDoc(3);
    const progress: [number, number][] = [];
    const seen: number[] = [];
    const out = await bakePages("/tmp/a.pdf", [0, 2, 3, 9], 72, (_ctx, _vp, n) => seen.push(n), (d, t) => progress.push([d, t]));
    expect(out.map((p) => p.page)).toEqual([2, 3]);
    expect(out[0]).toMatchObject({ jpegBase64: "AAAA", widthPx: 100, heightPx: 200, view: [0, 0, 100, 200] });
    expect(seen).toEqual([2, 3]);
    expect(progress).toEqual([[1, 2], [2, 2]]);
    expect(doc.getPage).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("takes every page when none are named", async () => {
    fakeDoc(2);
    const out = await bakePages("/tmp/a.pdf", undefined, 72, () => {});
    expect(out.map((p) => p.page)).toEqual([1, 2]);
  });
});

describe("renderRedactedPages", () => {
  it("bakes each redacted page once, in page order, covering the area with a margin", async () => {
    fakeDoc(5);
    const area = (page: number) => ({ page, x: 10, y: 20, width: 30, height: 40 }) as never;
    const out = await renderRedactedPages("/tmp/a.pdf", [area(4), area(2), area(4)], 72);
    expect(out.map((p) => p.page)).toEqual([2, 4]);
    expect(drawn.filter((d) => d === "fill 9,19,32,42")).toHaveLength(3);
  });
});
