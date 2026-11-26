// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { SideTabs } from "../side-tabs";
import { brightnessLevel } from "../brightness-button";

const tab = (id: number, title: string, dirty = false) => ({ id, title, dirty, parked: null });

describe("SideTabs", () => {
  it("lists every document with the current one marked, and opens files", () => {
    const on = { activate: vi.fn(), close: vi.fn(), move: vi.fn(), detach: vi.fn(), open: vi.fn(), rename: vi.fn() };
    const tabs = new SideTabs(on);
    tabs.render([tab(1, "a.pdf"), tab(2, "b.pdf", true)], 1);
    const items = [...tabs.el.querySelectorAll<HTMLElement>(".side-tab[data-tab]")];
    expect(items.map((i) => i.textContent)).toEqual(["a.pdf", "b.pdf"]);
    expect(items[0]!.classList.contains("active")).toBe(true);
    expect(items[1]!.classList.contains("dirty")).toBe(true);
    items[1]!.dispatchEvent(new PointerEvent("pointerdown", { button: 0 }));
    expect(on.activate).toHaveBeenCalledWith(2);
    items[1]!.querySelector<HTMLButtonElement>(".side-tab-close")!.click();
    expect(on.close).toHaveBeenCalledWith(2);
    tabs.el.querySelector<HTMLButtonElement>(".side-tab-open")!.click();
    expect(on.open).toHaveBeenCalled();
    tabs.render([], null);
    expect(tabs.el.querySelectorAll(".side-tab:not(.side-tab-open)")).toHaveLength(0);
    expect(tabs.el.querySelector(".side-tab-open")).not.toBeNull();
  });

  it("shows no close cross on a tab that is still loading and has no name", () => {
    const on = { activate: vi.fn(), close: vi.fn(), move: vi.fn(), detach: vi.fn(), open: vi.fn(), rename: vi.fn() };
    const tabs = new SideTabs(on);
    tabs.render([tab(1, "a.pdf"), tab(2, "")], 2);
    const items = [...tabs.el.querySelectorAll<HTMLElement>(".side-tab[data-tab]")];
    expect(items[0]!.querySelector(".side-tab-close")).not.toBeNull();
    expect(items[1]!.querySelector(".side-tab-close")).toBeNull();
  });

  it("renames the current document in place: double-click, type, Enter", () => {
    const on = { activate: vi.fn(), close: vi.fn(), move: vi.fn(), detach: vi.fn(), open: vi.fn(), rename: vi.fn() };
    const tabs = new SideTabs(on);
    document.body.append(tabs.el);
    tabs.render([tab(1, "a.pdf"), tab(2, "b.pdf")], 1);
    const other = tabs.el.querySelector<HTMLElement>('.side-tab[data-tab="2"]')!;
    other.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(tabs.el.querySelector(".side-tab-input")).toBeNull();
    const current = tabs.el.querySelector<HTMLElement>('.side-tab[data-tab="1"]')!;
    current.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = tabs.el.querySelector<HTMLInputElement>(".side-tab-input")!;
    expect(input.value).toBe("a");
    expect(tabs.el.querySelector(".side-tab-ext")!.textContent).toBe(".pdf");
    tabs.render([tab(1, "a.pdf"), tab(2, "b.pdf")], 1);
    expect(tabs.el.querySelector(".side-tab-input")).toBe(input);
    input.value = "report";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(on.rename).toHaveBeenCalledWith(1, "report");
    expect(tabs.el.querySelector(".side-tab-input")).toBeNull();
    tabs.el.remove();
  });

  it("drops the new name on Escape, and offers no rename for a book", () => {
    const on = { activate: vi.fn(), close: vi.fn(), move: vi.fn(), detach: vi.fn(), open: vi.fn(), rename: vi.fn() };
    const tabs = new SideTabs(on);
    tabs.render([tab(1, "a.pdf")], 1);
    tabs.startRename(1);
    const input = tabs.el.querySelector<HTMLInputElement>(".side-tab-input")!;
    input.value = "x";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(on.rename).not.toHaveBeenCalled();
    tabs.setRenamable(false);
    tabs.startRename(1);
    expect(tabs.el.querySelector(".side-tab-input")).toBeNull();
  });
});

describe("brightness icon", () => {
  it("lights 1 to 3 rays", () => {
    expect([40, 59, 60, 84, 85, 100].map(brightnessLevel)).toEqual([1, 1, 2, 2, 3, 3]);
  });
});
