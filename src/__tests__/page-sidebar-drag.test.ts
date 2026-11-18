// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { PageSidebar } from "../page-sidebar";

class FakeIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

const SIDEBAR = { left: 0, top: 0, right: 200, bottom: 700, width: 200, height: 700, x: 0, y: 0 };
const NONE = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };

let root: HTMLElement;

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.stubGlobal("innerWidth", 1000);
  vi.stubGlobal("innerHeight", 700);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const r = this === root ? SIDEBAR : NONE;
    return { ...r, toJSON: () => r } as DOMRect;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function setUp() {
  root = document.createElement("div");
  document.body.appendChild(root);
  const sidebar = new PageSidebar(root);
  const doc = { getPage: vi.fn(() => new Promise(() => {})) } as unknown as PDFDocumentProxy;
  sidebar.load(doc, Array.from({ length: 4 }, () => ({ width: 595, height: 842 })), 0);
  const out = vi.fn();
  const tab = vi.fn();
  const zone = vi.fn();
  const move = vi.fn();
  sidebar.onDragOut(out);
  sidebar.onDragToTab(tab);
  sidebar.onTabZone(zone);
  sidebar.onMove(move);
  const frame = (page: number) => root.querySelector<HTMLElement>(`[data-page="${page}"] .page-sidebar-frame`)!;
  const drag = (page: number, to: { x: number; y: number }) => {
    frame(page).dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 100, clientY: 100 }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 120, clientY: 120 }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: to.x, clientY: to.y }));
    const ghost = document.querySelector(".page-sidebar-ghost")?.textContent ?? "";
    window.dispatchEvent(new MouseEvent("pointerup", { clientX: to.x, clientY: to.y, screenX: 900, screenY: 400 }));
    return ghost;
  };
  return { out, tab, zone, move, drag };
}

describe("PageSidebar drag out", () => {
  it("opens the dragged page in a new tab when dropped on the document area", () => {
    const { out, tab, zone, drag } = setUp();
    const hint = drag(2, { x: 600, y: 300 });
    expect(hint).toBe("Release to open in a new tab");
    expect(tab).toHaveBeenCalledWith([2]);
    expect(out).not.toHaveBeenCalled();
    expect(zone.mock.calls).toEqual([[true], [false]]);
  });

  it("opens the dragged page in a new window when dropped outside the window", () => {
    const { out, tab, drag } = setUp();
    const hint = drag(3, { x: 1200, y: 300 });
    expect(hint).toBe("Release to open in a new window");
    expect(out).toHaveBeenCalledWith([3], 900, 400);
    expect(tab).not.toHaveBeenCalled();
  });

  it("keeps reordering while the pointer stays over the page list", () => {
    const { out, tab, zone, drag } = setUp();
    const hint = drag(1, { x: 150, y: 300 });
    expect(hint).toBe("Page 1");
    expect(out).not.toHaveBeenCalled();
    expect(tab).not.toHaveBeenCalled();
    expect(zone).not.toHaveBeenCalled();
  });
});
