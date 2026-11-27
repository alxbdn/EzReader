import { describe, it, expect, vi } from "vitest";
import { AnnotationSession } from "../annotation-session";
import type { RectAnnotation, RedactAnnotation } from "../models";

const rect = (width: number, page = 1): RectAnnotation => ({
  page, kind: "rect", x: 0, y: 0, width, height: 10,
  color: { r: 0, g: 0, b: 0 }, strokeWidth: 1,
});
const redact = (x: number, page = 1): RedactAnnotation => ({ page, kind: "redact", x, y: 0, width: 10, height: 10 });
const widths = (s: AnnotationSession) => s.all().map(a => a.width);

function setup(opts: { read?: boolean; dirty?: boolean } = {}) {
  const pending = vi.fn();
  const changed = vi.fn();
  const s = new AnnotationSession({ gateEnabled: () => !opts.read, isDirty: () => opts.dirty ?? false });
  s.onPendingChange(pending);
  s.onChange(changed);
  return { s, pending, changed };
}

describe("AnnotationSession page index", () => {
  it("groups annotations by page and forgets empty pages", () => {
    const { s } = setup();
    const a = rect(1), b = rect(2, 3);
    s.add(a); s.add(b);
    expect(s.forPage(1)).toEqual([a]);
    expect(s.forPage(3)).toEqual([b]);
    expect(s.forPage(2)).toEqual([]);
    expect(s.remove(a)).toBe(true);
    expect(s.remove(a)).toBe(false);
    expect(s.has(b)).toBe(true);
    s.remove(b);
    expect(s.isEmpty()).toBe(true);
  });

  it("moveLayer swaps an annotation with its neighbour and stops at the ends", () => {
    const { s } = setup();
    const [a, b, c] = [rect(1), rect(2), rect(3)];
    s.add(a); s.add(b); s.add(c);

    expect(s.moveLayer(a, 1)).toBe(true);
    expect(widths(s)).toEqual([2, 1, 3]);

    expect(s.moveLayer(c, 1)).toBe(false);
    expect(widths(s)).toEqual([2, 1, 3]);

    expect(s.moveLayer(b, -1)).toBe(false);
    s.moveLayer(c, -1);
    expect(widths(s)).toEqual([2, 3, 1]);
  });

  it("notifies every user change, not restores", () => {
    const { s, changed } = setup();
    const a = rect(1);
    s.add(a);
    s.beginEdit(); a.x = 5; s.edited();
    s.moveLayer(a, 1);
    s.remove(a);
    expect(changed).toHaveBeenCalledTimes(3);
    s.undo(); s.redo(); s.load([rect(4)]);
    expect(changed).toHaveBeenCalledTimes(3);
  });
});

describe("AnnotationSession undo / redo", () => {
  it("takes back each change, in-place edits included", () => {
    const { s } = setup();
    const a = rect(1);
    s.add(a);
    s.beginEdit();
    a.width = 9;
    s.edited();
    s.add(rect(2));
    expect(widths(s)).toEqual([9, 2]);

    expect(s.undo()).toBe(true);
    expect(widths(s)).toEqual([9]);
    expect(s.undo()).toBe(true);
    expect(widths(s)).toEqual([1]);
    expect(s.undo()).toBe(true);
    expect(widths(s)).toEqual([]);
    expect(s.undo()).toBe(false);

    expect(s.redo()).toBe(true);
    expect(s.redo()).toBe(true);
    expect(widths(s)).toEqual([9]);
    s.add(rect(3));
    expect(s.redo()).toBe(false);
  });

  it("change() groups several mutations into one undo step", () => {
    const { s } = setup();
    const a = rect(1);
    s.add(a);
    s.change(() => { s.remove(a); s.add(rect(2)); s.add(rect(3)); });
    expect(widths(s)).toEqual([2, 3]);
    s.undo();
    expect(widths(s)).toEqual([1]);
  });

  it("keeps at most 50 steps", () => {
    const { s } = setup();
    for (let i = 0; i < 60; i++) s.add(rect(i));
    let n = 0;
    while (s.undo()) n++;
    expect(n).toBe(50);
    expect(s.all()).toHaveLength(10);
  });

  it("load() starts a fresh history", () => {
    const { s } = setup();
    s.add(rect(1));
    s.load([rect(7)]);
    expect(s.undo()).toBe(false);
    expect(widths(s)).toEqual([7]);
  });
});

describe("AnnotationSession redaction gate", () => {
  it("ordinary changes apply at once", () => {
    const { s, pending } = setup();
    s.add(rect(1));
    expect(s.pending).toBe(false);
    expect(pending).not.toHaveBeenCalled();
  });

  it("adding a redaction waits for ✓; apply keeps it", () => {
    const { s, pending } = setup();
    s.add(redact(0));
    expect(s.pending).toBe(true);
    expect(pending).toHaveBeenLastCalledWith(true);
    s.apply();
    expect(s.pending).toBe(false);
    expect(pending).toHaveBeenLastCalledWith(false);
    expect(s.all()).toHaveLength(1);
  });

  it("discard restores the state before the redactions and the dirty flag; Ctrl+Z brings them back", () => {
    const { s } = setup({ dirty: true });
    s.add(rect(1));
    s.add(redact(0));
    s.add(rect(2));
    expect(s.discard()).toBe(true);
    expect(s.pending).toBe(false);
    expect(s.all().map(a => a.kind)).toEqual(["rect"]);
    expect(s.discard()).toBeNull();
    s.undo();
    expect(s.all().map(a => a.kind)).toEqual(["rect", "redact", "rect"]);
  });

  it("dragging a redaction opens the gate on the first step, deterministically", () => {
    const { s } = setup();
    const r = redact(0);
    s.add(r);
    s.apply();
    s.beginEdit();
    r.x = 4;
    s.settle();
    expect(s.pending).toBe(true);
    r.x = 8;
    s.edited();
    expect(s.discard()).toBe(false);
    expect((s.all()[0] as RedactAnnotation).x).toBe(0);
  });

  it("moving a non-redaction does not open the gate", () => {
    const { s } = setup();
    const a = rect(1);
    s.add(a);
    s.beginEdit(); a.x = 3; s.settle(); s.edited();
    expect(s.pending).toBe(false);
  });

  it("undoing every pending redaction closes the gate without reverting", () => {
    const { s } = setup();
    s.add(rect(1));
    s.add(redact(0));
    s.undo();
    expect(s.pending).toBe(false);
    expect(widths(s)).toEqual([1]);
    s.redo();
    expect(s.pending).toBe(false);
  });

  it("redactions apply at once in read mode", () => {
    const { s } = setup({ read: true });
    s.add(redact(0));
    expect(s.pending).toBe(false);
  });

  it("load() drops what was pending", () => {
    const { s, pending } = setup();
    s.add(redact(0));
    s.load([]);
    expect(s.pending).toBe(false);
    expect(pending).toHaveBeenLastCalledWith(false);
  });
});

describe("AnnotationSession.relocate", () => {
  it("moves an annotation to the top of another page as part of one undo step", () => {
    const { s } = setup();
    const a = rect(1), b = rect(2, 2);
    s.add(a); s.add(b);
    s.beginEdit();
    a.x = 5;
    s.relocate(a, 2);
    s.edited();
    expect(s.forPage(1)).toEqual([]);
    expect(s.forPage(2)).toEqual([b, a]);
    expect(a.page).toBe(2);
    s.undo();
    expect(s.forPage(1).map(x => [x.width, x.x])).toEqual([[1, 0]]);
    expect(s.forPage(2).map(x => x.width)).toEqual([2]);
  });

  it("ignores an annotation that is not in the session", () => {
    const { s } = setup();
    const a = rect(1);
    s.relocate(a, 4);
    expect(a.page).toBe(1);
    expect(s.isEmpty()).toBe(true);
  });

  it("moving a redaction to another page opens the gate", () => {
    const { s } = setup();
    const r = redact(0);
    s.add(r); s.apply();
    s.beginEdit();
    s.relocate(r, 3);
    s.settle();
    expect(s.pending).toBe(true);
  });
});

describe("AnnotationSession undo memory", () => {
  it("keeps a copy only of the annotation an edit names", () => {
    const { s } = setup();
    const all = Array.from({ length: 100 }, (_, i) => rect(i + 1));
    s.load(all);
    s.beginEdit(all[3]!);
    all[3]!.width = 500;
    s.edited();
    const [step] = s.snapshot().undo;
    expect(step!.refs).toHaveLength(100);
    expect([...step!.pinned.keys()]).toEqual([all[3]]);
    s.undo();
    expect(widths(s)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    s.redo();
    expect(s.all()[3]!.width).toBe(500);
  });

  it("takes back a chain of named edits on several annotations, both ways", () => {
    const { s } = setup();
    const a = rect(1), b = rect(2);
    s.load([a, b]);
    s.beginEdit(a); a.width = 10; s.edited();
    s.beginEdit(b); b.width = 20; s.edited();
    s.beginEdit(a); a.width = 100; s.edited();
    expect(widths(s)).toEqual([100, 20]);
    s.undo(); expect(widths(s)).toEqual([10, 20]);
    s.undo(); expect(widths(s)).toEqual([10, 2]);
    s.undo(); expect(widths(s)).toEqual([1, 2]);
    s.redo(); expect(widths(s)).toEqual([10, 2]);
    s.redo(); expect(widths(s)).toEqual([10, 20]);
    s.redo(); expect(widths(s)).toEqual([100, 20]);
  });

  it("an edit made after an undo does not change what redo brings back", () => {
    const { s } = setup();
    const a = rect(1);
    s.load([a]);
    s.beginEdit(a); a.width = 5; s.edited();
    s.undo();
    const shown = s.all()[0]!;
    s.beginEdit(shown); shown.width = 7; s.edited();
    expect(s.redo()).toBe(false);
    s.undo();
    expect(widths(s)).toEqual([1]);
  });

  it("an annotation edited after it was undone away leaves the history alone", () => {
    const { s } = setup();
    const a = rect(1);
    s.load([a]);
    s.beginEdit(a); a.width = 5; s.edited();
    s.undo();
    s.beginEdit(a); a.width = 99; s.edited();
    expect(widths(s)).toEqual([1]);
    s.undo();
    expect(widths(s)).toEqual([1]);
    s.redo();
    expect(widths(s)).toEqual([1]);
  });

  it("an edit that names nothing still keeps every step right", () => {
    const { s } = setup();
    const a = rect(1), b = rect(2);
    s.load([a, b]);
    s.beginEdit(a); a.width = 10; s.edited();
    s.beginEdit(); a.width = 11; b.width = 22; s.edited();
    s.undo(); expect(widths(s)).toEqual([10, 2]);
    s.undo(); expect(widths(s)).toEqual([1, 2]);
  });

  it("a parked tab brings its history back with it", () => {
    const { s } = setup();
    const a = rect(1);
    s.load([a]);
    s.beginEdit(a); a.width = 3; s.edited();
    const parked = s.snapshot();
    s.load([rect(50)]);
    s.restoreParked(parked);
    s.undo();
    expect(widths(s)).toEqual([1]);
  });
});
