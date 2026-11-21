// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { OverlayEvents } from "../overlay-events";
import { PdfPageView } from "../pdf-viewer";
import { ToolSelection } from "../tool-selection";
import { AnnotationSession } from "../annotation-session";

const key = (k: string) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k }));

describe("OverlayEvents", () => {
  it("adds one window keydown listener whatever the number of pages", () => {
    const add = vi.spyOn(window, "addEventListener");
    const events = new OverlayEvents();
    const tools = new ToolSelection();
    const session = new AnnotationSession();
    const views = Array.from({ length: 50 }, (_, i) => new PdfPageView(i + 1, tools, session, null, events));
    for (const v of views) void v.overlay;
    expect(add.mock.calls.filter(([type]) => type === "keydown")).toHaveLength(1);
    for (const v of views) v.destroy();
    add.mockRestore();
  });

  it("stops calling a page once it is destroyed", () => {
    const events = new OverlayEvents();
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = events.listenForKeys(first);
    events.listenForKeys(second);
    key("Delete");
    stopFirst();
    key("Delete");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("skips a listener removed by an earlier one during the same key", () => {
    const events = new OverlayEvents();
    const late = vi.fn();
    let stopLate = () => {};
    events.listenForKeys(() => stopLate());
    stopLate = events.listenForKeys(late);
    key("Delete");
    expect(late).not.toHaveBeenCalled();
  });

  it("reports every page's selection to listeners added once", () => {
    const events = new OverlayEvents();
    const text = vi.fn();
    const pick = vi.fn();
    events.onTextSelected(text);
    events.onPick(pick);
    expect(events.hasPickListeners).toBe(true);
    events.textSelected(null);
    expect(text).toHaveBeenCalledWith(null);
    expect(pick).not.toHaveBeenCalled();
  });
});

describe("PdfPageView before it is drawn", () => {
  it("is one empty box until its overlay is used, then picks up the current tool", () => {
    const tools = new ToolSelection();
    const view = new PdfPageView(1, tools, new AnnotationSession());
    view.setPlaceholderSize(200, 300);
    view.clear();
    expect(view.wrapper.childElementCount).toBe(0);
    expect(view.builtOverlay).toBeNull();
    expect(view.hasPixels).toBe(false);
    expect(view.highlight("x", 0)).toBeNull();

    tools.setTool("rect");
    expect(view.overlay.currentTool).toBe("rect");
    expect(view.builtOverlay).toBe(view.overlay);
    expect(view.wrapper.querySelector(".page-canvas")).not.toBeNull();
    view.destroy();
  });
});
