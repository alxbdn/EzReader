// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { PageSidebar } from "../page-sidebar";

let observers: { cb: IntersectionObserverCallback; targets: Element[] }[] = [];

class FakeIntersectionObserver {
  private entry: { cb: IntersectionObserverCallback; targets: Element[] };
  constructor(cb: IntersectionObserverCallback) {
    this.entry = { cb, targets: [] };
    observers.push(this.entry);
  }
  observe(el: Element): void { this.entry.targets.push(el); }
  unobserve(): void {}
  disconnect(): void { this.entry.targets = []; }
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

function showAll(): void {
  for (const o of observers) {
    const entries = o.targets.map((target) => ({ target, isIntersecting: true }) as unknown as IntersectionObserverEntry);
    if (entries.length) o.cb(entries, {} as IntersectionObserver);
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const dims = (n: number) => Array.from({ length: n }, () => ({ width: 595, height: 842 }));

beforeEach(() => {
  observers = [];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PageSidebar thumbnails", () => {
  it("draws the next document even when a render of the previous one never settles", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const sidebar = new PageSidebar(root);

    const stuck = { getPage: vi.fn(() => new Promise(() => {})) } as unknown as PDFDocumentProxy;
    sidebar.load(stuck, dims(3), 0);
    showAll();
    await flush();
    expect(stuck.getPage).toHaveBeenCalledTimes(1);

    const page = { rotate: 0, getViewport: () => ({ width: 595, height: 842 }), cleanup: vi.fn() };
    const next = { getPage: vi.fn(async () => page) } as unknown as PDFDocumentProxy;
    sidebar.load(next, dims(3), 0);
    showAll();
    await flush();
    await flush();
    expect(next.getPage).toHaveBeenCalled();
  });
});
