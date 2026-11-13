import { describe, it, expect, vi } from "vitest";
import { AnnotationSession } from "../annotation-session";
import type { RectAnnotation, RedactAnnotation } from "../models";

// Each rect is told apart by its width.
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

    expect(s.moveLayer(c, 1)).toBe(false); // already on top
    expect(widths(s)).toEqual([2, 1, 3]);

    expect(s.moveLayer(b, -1)).toBe(false); // already at the bottom
    s.moveLayer(c, -1);
    expect(widths(s)).toEqual([2, 3, 1]);
  });

  it("notifies every user change, not restores", () => {
    const { s, changed } = setup();
    const a = rect(1);
    s.add(a);
    s.beginEdit(); a.x = 5; s.edited();
    s.moveLayer(a, 1); // no-op: no notification
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
    s.add(rect(3)); // a new change drops what could be redone
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
    s.add(rect(2)); // later changes go with the pending ones
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
