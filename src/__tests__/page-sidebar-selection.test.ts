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

const BOX = { left: 10, top: 10, right: 26, bottom: 26, width: 16, height: 16, x: 10, y: 10 };

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const r = this.classList.contains("page-sidebar-check") ? BOX : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
    return { ...r, toJSON: () => r } as DOMRect;
  });
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function setUp(pages = 4) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const sidebar = new PageSidebar(root);
  const doc = { getPage: vi.fn(() => new Promise(() => {})) } as unknown as PDFDocumentProxy;
  sidebar.load(doc, Array.from({ length: pages }, () => ({ width: 595, height: 842 })), 0);
  const goTo = vi.fn();
  const selection = vi.fn();
  sidebar.onGoTo(goTo);
  sidebar.onSelectionChange(selection);
  const frame = (page: number) => root.querySelector<HTMLElement>(`[data-page="${page}"] .page-sidebar-frame`)!;
  const click = (page: number, x: number, y: number, init: MouseEventInit = {}) =>
    frame(page).dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y, ...init }));
  return { goTo, selection, click };
}

describe("PageSidebar selection", () => {
  it("selects a page when the click lands on its check box, even though the frame is the event target", () => {
    const { goTo, selection, click } = setUp();
    click(2, 18, 18);
    expect(goTo).not.toHaveBeenCalled();
    expect(selection).toHaveBeenLastCalledWith([2]);
  });

  it("counts the enlarged hit area around the check box", () => {
    const { goTo, selection, click } = setUp();
    click(3, 30, 30);
    expect(goTo).not.toHaveBeenCalled();
    expect(selection).toHaveBeenLastCalledWith([3]);
  });

  it("shows the page on a plain click away from the check box, even while pages are selected", () => {
    const { goTo, selection, click } = setUp();
    click(1, 18, 18);
    click(2, 200, 200);
    expect(goTo).toHaveBeenCalledWith(2, false);
    expect(selection).toHaveBeenLastCalledWith([1]);
  });

  it("extends the selection with Shift+click and toggles with Ctrl+click", () => {
    const { selection, click } = setUp(5);
    click(1, 18, 18);
    click(4, 200, 200, { shiftKey: true });
    expect(selection).toHaveBeenLastCalledWith([1, 2, 3, 4]);
    click(2, 200, 200, { ctrlKey: true });
    expect(selection).toHaveBeenLastCalledWith([1, 3, 4]);
  });
});
