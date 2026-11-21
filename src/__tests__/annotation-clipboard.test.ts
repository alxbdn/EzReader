import { describe, it, expect } from "vitest";
import { AnnotationClipboard, clipboardText, copyable } from "../annotation-clipboard";
import type { Annotation, NoteAnnotation, RectAnnotation, TextAnnotation } from "../models";

const red = { r: 255, g: 0, b: 0 };
const rect = (page = 1): RectAnnotation => ({ kind: "rect", page, x: 10, y: 20, width: 30, height: 40, color: red, strokeWidth: 2 });
const note = (content: string): NoteAnnotation => ({ kind: "note", page: 2, x: 0, y: 0, width: 150, height: 100, content, color: red });
const text = (cover?: TextAnnotation["cover"]): TextAnnotation => ({
  kind: "text", page: 1, x: 0, y: 0, width: 100, content: "Hi", color: red, fontSize: 12,
  bold: false, italic: false, underline: false, alignment: "left", ...(cover ? { cover } : {}),
});

describe("copyable", () => {
  it("takes notes, shapes, text boxes and pictures", () => {
    expect(copyable(rect())).toBe(true);
    expect(copyable(note("x"))).toBe(true);
    expect(copyable(text())).toBe(true);
    expect(copyable({ kind: "image", page: 1, x: 0, y: 0, width: 1, height: 1, imageData: "" })).toBe(true);
  });

  it("leaves highlights, redactions and replaced page text where they are", () => {
    expect(copyable({ kind: "highlight", page: 1, x: 0, y: 0, width: 1, height: 1, rects: [], color: red, opacity: 1 })).toBe(false);
    expect(copyable({ kind: "redact", page: 1, x: 0, y: 0, width: 1, height: 1 })).toBe(false);
    expect(copyable(text({ x: 0, y: 0, width: 1, height: 1, color: red }))).toBe(false);
  });
});

describe("clipboardText", () => {
  it("is what a note or text box says, and empty for the rest", () => {
    expect(clipboardText(note("Call Bob"))).toBe("Call Bob");
    expect(clipboardText(text())).toBe("Hi");
    expect(clipboardText(rect())).toBe("");
  });
});

describe("AnnotationClipboard", () => {
  it("holds nothing at first", () => {
    const c = new AnnotationClipboard();
    expect(c.holds("")).toBe(false);
    expect(c.next(1)).toBeNull();
  });

  it("keeps a copy that later edits to the original don't reach", () => {
    const c = new AnnotationClipboard();
    const ann = rect();
    c.copy(ann);
    ann.x = 999;
    ann.color.r = 0;
    const pasted = c.next(1)!.ann as RectAnnotation;
    expect(pasted.x).toBe(10);
    expect(pasted.color.r).toBe(255);
    expect(pasted).not.toBe(ann);
  });

  it("pastes only while the system clipboard still holds the copied text", () => {
    const c = new AnnotationClipboard();
    expect(c.copy(note("line 1\nline 2"))).toBe("line 1\nline 2");
    expect(c.holds("line 1\r\nline 2")).toBe(true);
    expect(c.holds("something else")).toBe(false);
  });

  it("nudges each paste on the source page, and starts in place on another page", () => {
    const c = new AnnotationClipboard();
    c.copy(rect(1));
    expect(c.next(1)!.steps).toBe(1);
    expect(c.next(1)!.steps).toBe(2);
    const other = c.next(3)!;
    expect(other.steps).toBe(0);
    expect(other.ann.page).toBe(3);
    expect(c.next(3)!.steps).toBe(1);
  });

  it("starts over when something new is copied", () => {
    const c = new AnnotationClipboard();
    c.copy(rect(1));
    c.next(1);
    c.copy(rect(1) as Annotation);
    expect(c.next(1)!.steps).toBe(1);
  });
});
