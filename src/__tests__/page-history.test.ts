import { describe, expect, it } from "vitest";
import { PageHistory, type DocState } from "../page-history";

const st = (path: string, page = 1, dirty = true): DocState => ({ path, page, dirty });

describe("PageHistory", () => {
  it("undoes page edits back to the first state, then redoes them", () => {
    const h = new PageHistory();
    h.record(st("a", 3, false)); // a → b
    h.record(st("b", 2));        // b → c
    expect(h.undo(st("c"))).toEqual(st("b", 2));
    expect(h.undo(st("b", 2))).toEqual(st("a", 3, false));
    expect(h.canUndo).toBe(false);
    expect(h.undo(st("a"))).toBeNull();
    expect(h.redo(st("a", 3, false))).toEqual(st("b", 2));
    expect(h.redo(st("b", 2))).toEqual(st("c"));
    expect(h.canRedo).toBe(false);
  });

  it("a new edit or another change drops what could be redone", () => {
    const h = new PageHistory();
    h.record(st("a"));
    h.undo(st("b"));
    expect(h.canRedo).toBe(true);
    h.record(st("a"));
    expect(h.canRedo).toBe(false);
    h.undo(st("c"));
    h.clearRedo();
    expect(h.canRedo).toBe(false);
  });

  it("keeps at most MAX steps and forgets them for another document", () => {
    const h = new PageHistory();
    for (let i = 0; i < PageHistory.MAX + 5; i++) h.record(st(`p${i}`));
    let n = 0;
    while (h.undo(st("x"))) n++;
    expect(n).toBe(PageHistory.MAX);
    h.record(st("y"));
    h.clear();
    expect(h.canUndo || h.canRedo).toBe(false);
  });
});
