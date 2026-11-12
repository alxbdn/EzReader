import { describe, it, expect } from "vitest";
import { moveItems, isUnchangedLayout } from "../page-order";

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

describe("isUnchangedLayout", () => {
  const orig = (page: number, rotation = 0) => ({ kind: "original" as const, page, rotation });

  it("accepts the identity layout", () => {
    expect(isUnchangedLayout([orig(1), orig(2)], 2)).toBe(true);
    expect(isUnchangedLayout([orig(1, 360)], 1)).toBe(true);
  });

  it("detects reorder, rotation, deletion and insertion", () => {
    expect(isUnchangedLayout([orig(2), orig(1)], 2)).toBe(false);
    expect(isUnchangedLayout([orig(1, 90), orig(2)], 2)).toBe(false);
    expect(isUnchangedLayout([orig(1)], 2)).toBe(false);
    expect(isUnchangedLayout([orig(1), { kind: "blank", width: 1, height: 1, rotation: 0 }], 1)).toBe(false);
  });
});
