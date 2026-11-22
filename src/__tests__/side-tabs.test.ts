// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { SideTabs } from "../side-tabs";
import { brightnessLevel } from "../brightness-button";

const tab = (id: number, title: string, dirty = false) => ({ id, title, dirty, parked: null });

describe("SideTabs", () => {
  it("lists every document with the current one marked, and opens files", () => {
    const on = { activate: vi.fn(), close: vi.fn(), move: vi.fn(), detach: vi.fn(), open: vi.fn() };
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
    expect(tabs.el.hidden).toBe(true);
  });
});

describe("brightness icon", () => {
  it("lights 1 to 3 rays", () => {
    expect([40, 59, 60, 84, 85, 100].map(brightnessLevel)).toEqual([1, 1, 2, 2, 3, 3]);
  });
});
