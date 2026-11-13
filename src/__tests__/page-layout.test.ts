import { describe, it, expect } from "vitest";
import { currentSlots, moveItems, planDelete, planInsert, planMove, planRotate } from "../page-layout";

describe("moveItems", () => {
  const list = ["a", "b", "c", "d", "e"];

  it("moves one item forward", () => {
    expect(moveItems(list, [0], 3)).toEqual(["b", "c", "a", "d", "e"]);
  });

  it("moves one item backward", () => {
    expect(moveItems(list, [3], 1)).toEqual(["a", "d", "b", "c", "e"]);
  });

  it("moves to the very start and end", () => {
    expect(moveItems(list, [4], 0)).toEqual(["e", "a", "b", "c", "d"]);
    expect(moveItems(list, [0], 5)).toEqual(["b", "c", "d", "e", "a"]);
  });

  it("is a no-op when dropped next to itself", () => {
    expect(moveItems(list, [2], 2)).toEqual(list);
    expect(moveItems(list, [2], 3)).toEqual(list);
  });

  it("moves a scattered selection as a block, keeping its order", () => {
    expect(moveItems(list, [3, 0], 5)).toEqual(["b", "c", "e", "a", "d"]);
    expect(moveItems(list, [1, 4], 0)).toEqual(["b", "e", "a", "c", "d"]);
    expect(moveItems(list, [0, 4], 2)).toEqual(["b", "a", "e", "c", "d"]);
  });

  it("does not mutate its input", () => {
    const copy = [...list];
    moveItems(copy, [0], 3);
    expect(copy).toEqual(list);
  });
});

const orig = (page: number, rotation = 0) => ({ kind: "original" as const, page, rotation });
const pagesOf = (slots: { kind: string; page?: number }[]) => slots.map((s) => (s.kind === "original" ? s.page : s.kind));

describe("currentSlots", () => {
  it("lists every page unchanged", () => {
    expect(currentSlots(3)).toEqual([orig(1), orig(2), orig(3)]);
  });
});

describe("planDelete", () => {
  it("refuses to delete every page", () => {
    expect(planDelete(2, [1, 2], 1)).toBeNull();
  });

  it("drops the pages and stays on the page shown", () => {
    const plan = planDelete(5, [1, 2], 4)!;
    expect(pagesOf(plan.slots)).toEqual([3, 4, 5]);
    expect(plan.keepPage).toBe(2); // page 4 is now page 2
    expect(plan.select).toEqual([]);
  });

  it("shows the page that took the place of a deleted one, within the document", () => {
    expect(planDelete(5, [3], 3)!.keepPage).toBe(3);
    expect(planDelete(3, [2, 3], 3)!.keepPage).toBe(1);
  });
});

describe("planRotate", () => {
  it("turns the chosen pages only and keeps the view", () => {
    const plan = planRotate(3, [2], -1);
    expect(plan.slots).toEqual([orig(1), orig(2, 270), orig(3)]);
    expect(plan.keepPage).toBeNull();
    expect(plan.select).toEqual([2]);
  });
});

describe("planMove", () => {
  it("moves the pages, follows the page shown and selects the moved ones", () => {
    const plan = planMove(5, [1], 3, 1);
    expect(pagesOf(plan.slots)).toEqual([2, 3, 1, 4, 5]);
    expect(plan.keepPage).toBe(3);
    expect(plan.select).toEqual([3]);
  });
});

describe("planInsert", () => {
  it("inserts after a page, then shows and selects the new pages", () => {
    const blank = { kind: "blank" as const, width: 1, height: 1, rotation: 0 };
    const plan = planInsert(2, 1, [blank, blank]);
    expect(pagesOf(plan.slots)).toEqual([1, "blank", "blank", 2]);
    expect(plan.keepPage).toBe(2);
    expect(plan.select).toEqual([2, 3]);
  });

  it("inserts before the first page", () => {
    const plan = planInsert(1, 0, [orig(9)]);
    expect(pagesOf(plan.slots)).toEqual([9, 1]);
    expect(plan.keepPage).toBe(1);
  });
});
