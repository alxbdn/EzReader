// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { ContextMenu } from "../context-menu";

describe("ContextMenu", () => {
  it("opens with its entries, runs one and closes", () => {
    const menu = new ContextMenu();
    const run = vi.fn();
    expect(menu.show(10, 10, [{ label: "Rename…", shortcut: "F2", run }, "sep", { label: "Close", run: vi.fn(), disabled: true }])).toBe(true);
    const entries = menu.el.querySelectorAll<HTMLButtonElement>(".menu-entry");
    expect([...entries].map((e) => e.textContent)).toEqual(["Rename…F2", "Close"]);
    expect(entries[1]!.disabled).toBe(true);
    entries[0]!.click();
    expect(run).toHaveBeenCalled();
    expect(menu.isOpen).toBe(false);
  });

  it("does not open with nothing to offer, and drops stray separators", () => {
    const menu = new ContextMenu();
    expect(menu.show(0, 0, [])).toBe(false);
    expect(menu.show(0, 0, ["sep", "sep"])).toBe(false);
    expect(menu.isOpen).toBe(false);
    menu.show(0, 0, ["sep", { label: "A", run: vi.fn() }, "sep", "sep", { label: "B", run: vi.fn() }, "sep"]);
    expect(menu.el.querySelectorAll(".menu-sep")).toHaveLength(1);
  });

  it("closes on Escape and on a press elsewhere", () => {
    const menu = new ContextMenu();
    menu.show(0, 0, [{ label: "A", run: vi.fn() }]);
    menu.el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu.isOpen).toBe(false);
    menu.show(0, 0, [{ label: "A", run: vi.fn() }]);
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(menu.isOpen).toBe(false);
  });
});
