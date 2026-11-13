import { describe, expect, it, vi } from "vitest";
import { ToolSelection, type SelectionOwner } from "../tool-selection";
import type { RectAnnotation } from "../models";

const rect = (page: number): RectAnnotation => ({
  page, kind: "rect", x: 0, y: 0, width: 10, height: 10, color: { r: 0, g: 0, b: 0 }, strokeWidth: 1,
});
const owner = () => ({ selectionLost: vi.fn<() => void>() }) satisfies SelectionOwner;

describe("ToolSelection", () => {
  it("starts on the select tool with the default style", () => {
    const t = new ToolSelection();
    expect(t.tool).toBe("select");
    expect(t.selected).toBeNull();
  });

  it("changes the tool and merges style presets into the one shared state", () => {
    const t = new ToolSelection();
    const state = t.state;
    t.setTool("rect");
    t.setStyle({ strokeWidth: 7 });
    expect(t.state).toBe(state);
    expect(state).toMatchObject({ tool: "rect", strokeWidth: 7 });
  });

  it("keeps one selection across pages: the page that loses it is told", () => {
    const t = new ToolSelection();
    const page1 = owner(), page2 = owner();
    const a = rect(1), b = rect(2);
    t.select(a, page1);
    expect(t.selected).toBe(a);
    t.select(b, page2);
    expect(t.selected).toBe(b);
    expect(page1.selectionLost).toHaveBeenCalledTimes(1);
    expect(page2.selectionLost).not.toHaveBeenCalled();
  });

  it("does not tell the owner when it changes the selection on its own page", () => {
    const t = new ToolSelection();
    const page1 = owner();
    t.select(rect(1), page1);
    t.select(rect(1), page1);
    expect(page1.selectionLost).not.toHaveBeenCalled();
    t.select(null);
    expect(page1.selectionLost).toHaveBeenCalledTimes(1);
    expect(t.selected).toBeNull();
  });

  it("deselectOnPage only clears a selection on that page", () => {
    const t = new ToolSelection();
    const a = rect(3);
    t.select(a, owner());
    t.deselectOnPage(2);
    expect(t.selected).toBe(a);
    t.deselectOnPage(3);
    expect(t.selected).toBeNull();
  });
});
