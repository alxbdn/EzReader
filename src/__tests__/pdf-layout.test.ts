// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";
import {
  calculateColumnCount,
  buildRows,
  focusedPageAt,
  resolveDestination,
  toViewportRect,
  PdfPageView,
  type DestinationDoc,
  type LinkNavigationHandler,
} from "../pdf-viewer";
import { ToolSelection } from "../tool-selection";
import { AnnotationSession } from "../annotation-session";

describe("calculateColumnCount", () => {
  it("returns 1 when only one page fits (800px container, 600px page)", () => {
    expect(calculateColumnCount(800, 600, 12)).toBe(1);
  });

  it("returns 2 when two pages fit (1300px container, 600px page)", () => {
    expect(calculateColumnCount(1300, 600, 12)).toBe(2);
  });

  it("returns 3 when three pages fit (1900px container, 600px page)", () => {
    expect(calculateColumnCount(1900, 600, 12)).toBe(3);
  });

  it("caps at 3 even when more pages could fit (3000px container)", () => {
    expect(calculateColumnCount(3000, 600, 12)).toBe(3);
  });

  it("returns 1 as minimum when container is smaller than page (400px container)", () => {
    expect(calculateColumnCount(400, 600, 12)).toBe(1);
  });

  it("returns 1 when container equals page width plus gap minus 1", () => {
    // 600 + 12 - 1 = 611 container; floor(623/612) = 1
    expect(calculateColumnCount(611, 600, 12)).toBe(1);
  });

  it("returns 2 when container exactly fits two pages with one gap", () => {
    // 2 pages: (2 * 600) + (1 * 12) = 1212
    expect(calculateColumnCount(1212, 600, 12)).toBe(2);
  });
});

describe("buildRows", () => {
  it("groups 5 pages into pairs with a trailing single page", () => {
    expect(buildRows(5, 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("groups 6 pages into triplets evenly", () => {
    expect(buildRows(6, 3)).toEqual([[1, 2, 3], [4, 5, 6]]);
  });

  it("handles single page with 2-column layout", () => {
    expect(buildRows(1, 2)).toEqual([[1]]);
  });

  it("stacks 4 pages in a single column", () => {
    expect(buildRows(4, 1)).toEqual([[1], [2], [3], [4]]);
  });

  it("handles 0 pages", () => {
    expect(buildRows(0, 2)).toEqual([]);
  });

  it("handles exactly matching page count for column count (4 pages, 2 columns)", () => {
    expect(buildRows(4, 2)).toEqual([[1, 2], [3, 4]]);
  });
});

describe("focusedPageAt", () => {
  // Three landscape pages, 400 px tall with 20 px gaps, in a 1000 px view.
  const pages = [{ start: 20, size: 400 }, { start: 440, size: 400 }, { start: 860, size: 400 }];
  it("picks the page nearest a third of the way down", () => {
    expect(focusedPageAt(0, 1000, 280, pages)).toBe(1);
    expect(focusedPageAt(200, 1000, 280, pages)).toBe(2);
  });
  it("is the last page once scrolled to the very end", () => {
    // At the end the third line (280 + 333) is nearer page 2's middle.
    expect(focusedPageAt(280, 1000, 280, pages)).toBe(3);
  });
  it("stays on page 1 when nothing scrolls", () => {
    expect(focusedPageAt(0, 1000, 0, pages)).toBe(1);
  });
});

describe("resolveDestination", () => {
  it("resolves a named string destination via getDestination and getPageIndex", async () => {
    const ref3 = { num: 12, gen: 0 };
    const doc: DestinationDoc = {
      numPages: 10,
      getDestination: vi.fn(async (id) => (id === "chap2" ? [ref3, { name: "XYZ" }, 72, 640, null] : null)),
      getPageIndex: vi.fn(async (ref) => (ref === ref3 ? 4 : -1)),
    };

    const res = await resolveDestination(doc, "chap2");
    expect(res).toEqual({ page: 5, point: [72, 640] });
    expect(doc.getDestination).toHaveBeenCalledWith("chap2");
    expect(doc.getPageIndex).toHaveBeenCalledWith(ref3);
  });

  it("resolves explicit arrays with integer indices and FitH / FitR / Fit modes", async () => {
    const ref2 = { num: 8, gen: 0 };
    const doc: DestinationDoc = {
      numPages: 8,
      getDestination: vi.fn(async () => null),
      getPageIndex: vi.fn(async (ref) => (ref === ref2 ? 1 : 0)),
    };

    expect(await resolveDestination(doc, [ref2, { name: "FitH" }, 510])).toEqual({
      page: 2,
      point: [0, 510],
    });
    expect(await resolveDestination(doc, [3, { name: "FitR" }, 50, 100, 400, 700])).toEqual({
      page: 4,
      point: [50, 700],
    });
    expect(await resolveDestination(doc, [ref2, { name: "Fit" }])).toEqual({
      page: 2,
      point: null,
    });
  });

  it("returns null for unknown, invalid, or out-of-bounds destinations", async () => {
    const doc: DestinationDoc = {
      numPages: 5,
      getDestination: vi.fn(async () => null),
      getPageIndex: vi.fn(async () => { throw new Error("missing ref"); }),
    };

    expect(await resolveDestination(doc, "missing")).toBeNull();
    expect(await resolveDestination(doc, [{ num: 99, gen: 0 }, { name: "Fit" }])).toBeNull();
    expect(await resolveDestination(doc, [5, { name: "Fit" }])).toBeNull();
    expect(await resolveDestination(doc, [-1, { name: "Fit" }])).toBeNull();
    expect(await resolveDestination(doc, null)).toBeNull();
  });
});

describe("PdfPageView internal link layer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  function stubCanvas2d() {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({
      setTransform: () => {},
      clearRect: () => {},
      drawImage: () => {},
      measureText: (t: string) => ({ width: t.length * 8 }),
      font: "",
    }) as unknown as CanvasRenderingContext2D);
  }

  it("renders clickable anchors for internal TOC dests, named actions, hash URLs and quadPoints", async () => {
    stubCanvas2d();

    const annotations = [
      { subtype: "Link", dest: "section-1", rect: [50, 700, 300, 720] },
      { subtype: "Link", dest: [{ num: 7, gen: 0 }, { name: "XYZ" }, 0, 500, null], rect: [50, 670, 300, 690] },
      { subtype: "Link", action: "LastPage", rect: [50, 640, 150, 660] },
      { subtype: "Link", unsafeUrl: "#page=4", rect: [50, 610, 150, 630] },
      {
        subtype: "Link",
        dest: "multiline",
        rect: [50, 500, 400, 540],
        quadPoints: new Float32Array([
          50, 540, 250, 540, 50, 525, 250, 525,
          50, 520, 180, 520, 50, 505, 180, 505,
        ]),
      },
    ];

    const fakeViewport = {
      width: 600,
      height: 800,
      rotation: 0,
      scale: 1,
      convertToViewportRectangle: ([x1, y1, x2, y2]: number[]) => [x1, 800 - y2, x2, 800 - y1],
      convertToViewportPoint: (x: number, y: number) => [x, 800 - y],
      convertToPdfPoint: (x: number, y: number) => [x, 800 - y],
    } as unknown as PageViewport;

    const fakePage = {
      rotate: 0,
      getViewport: () => fakeViewport,
      render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
      getTextContent: async () => ({ items: [], styles: {} }),
      getAnnotations: async () => annotations,
    } as unknown as PDFPageProxy;

    const fakeDoc = {
      getPage: async () => fakePage,
    } as unknown as PDFDocumentProxy;

    const handler: LinkNavigationHandler = {
      goToDestination: vi.fn(),
      executeNamedAction: vi.fn(),
      goToPage: vi.fn(),
    };

    const view = new PdfPageView(1, new ToolSelection(), new AnnotationSession());
    await view.render(fakeDoc, 1, 0, new Map(), () => {}, handler);

    const links = Array.from(view.wrapper.querySelectorAll<HTMLAnchorElement>(".page-link-layer a"));
    // 3 single-rect links + 1 hash link + 2 quadPoints rects = 6 anchors
    expect(links).toHaveLength(6);
    expect(links.every((a) => a.dataset.internalLink === "true")).toBe(true);

    // Multi-line quadPoints rendered as two separate line rectangles
    expect(links[4].style.width).toBe("200px");
    expect(links[5].style.width).toBe("130px");

    links[0].click();
    expect(handler.goToDestination).toHaveBeenCalledWith("section-1");

    links[1].click();
    expect(handler.goToDestination).toHaveBeenCalledWith([{ num: 7, gen: 0 }, { name: "XYZ" }, 0, 500, null]);

    links[2].click();
    expect(handler.executeNamedAction).toHaveBeenCalledWith("LastPage");

    links[3].click();
    expect(handler.goToPage).toHaveBeenCalledWith(4);

    links[5].click();
    expect(handler.goToDestination).toHaveBeenCalledWith("multiline");
  });

  it("tracks rendered scale/rotation, stretches canvas on zoom placeholder resize, and cancels obsolete renders", async () => {
    stubCanvas2d();

    const makeViewport = (scale: number, rotation: number) => ({
      width: 600 * scale,
      height: 800 * scale,
      rotation,
      scale,
      convertToViewportPoint: (x: number, y: number) => [x * scale, (800 - y) * scale],
      convertToPdfPoint: (x: number, y: number) => [x / scale, 800 - y / scale],
    }) as unknown as PageViewport;

    let cancelCalls = 0;
    let pendingResolve: (() => void) | null = null;
    const fakePage = {
      rotate: 0,
      getViewport: ({ scale, rotation }: { scale: number; rotation: number }) => makeViewport(scale, rotation),
      render: () => {
        if (pendingResolve) {
          const p = new Promise<void>((r) => { pendingResolve = r; });
          return { promise: p, cancel: () => { cancelCalls++; pendingResolve?.(); } };
        }
        return { promise: Promise.resolve(), cancel: () => { cancelCalls++; } };
      },
      getTextContent: async () => ({ items: [], styles: {} }),
      getAnnotations: async () => [],
      cleanup: () => {},
    } as unknown as PDFPageProxy;

    const fakeDoc = {
      getPage: async () => fakePage,
    } as unknown as PDFDocumentProxy;

    const view = new PdfPageView(1, new ToolSelection(), new AnnotationSession());
    expect(view.isRenderedAt(1, 0, 1)).toBe(false);

    await view.render(fakeDoc, 1, 0, new Map(), () => {});
    expect(view.isRenderedAt(1, 0, 1)).toBe(true);
    expect(view.isRenderedAt(1.5, 0, 1)).toBe(false);
    expect(view.isRenderedAt(1, 90, 1)).toBe(false);

    // Stretching placeholder during zoom keeps existing canvas pixels and updates CSS size
    view.setPlaceholderSize(900, 1200, true);
    const canvas = view.wrapper.querySelector<HTMLCanvasElement>(".page-canvas")!;
    expect(view.hasPixels).toBe(true);
    expect(canvas.style.width).toBe("900px");
    expect(canvas.style.height).toBe("1200px");

    // Start an in-flight render that hangs until cancelled, then cancel it and render at scale 2
    pendingResolve = () => {};
    const slowRender = view.render(fakeDoc, 1.5, 0, new Map(), () => {});
    await Promise.resolve();
    view.cancelRender();
    expect(cancelCalls).toBe(1);
    expect(view.hasPixels).toBe(true); // previous bitmap kept on screen
    await slowRender;

    pendingResolve = null;
    await view.render(fakeDoc, 2, 0, new Map(), () => {});
    expect(view.isRenderedAt(2, 0, 1)).toBe(true);
    const nextCanvas = view.wrapper.querySelector<HTMLCanvasElement>(".page-canvas")!;
    expect(nextCanvas.width).toBe(1200);
    expect(nextCanvas.height).toBe(1600);
  });
});

describe("toViewportRect", () => {
  it("maps both corners through the viewport, without normalising", () => {
    // 90° rotation at scale 2 on a 100×200 page: (x, y) → (2y, 2x).
    const viewport = { convertToViewportPoint: (x: number, y: number) => [2 * y, 2 * x] };
    expect(toViewportRect(viewport, [10, 20, 30, 40])).toEqual([40, 20, 80, 60]);
    expect(toViewportRect(viewport, new Float32Array([30, 40, 10, 20]))).toEqual([80, 60, 40, 20]);
  });
});
