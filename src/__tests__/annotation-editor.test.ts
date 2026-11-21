import { describe, it, expect } from "vitest";
import { AnnotationEditor } from "../annotation-editor";

const fromPartial = <T>(v: object): T => v as T;
const idOf = (a: object) => (a as { id: string }).id;
import type { CanvasOverlay } from "../canvas-overlay";
import { defaultToolState, type HighlightAnnotation, type InkAnnotation, type RectAnnotation, type SignatureAnnotation, type TextAnnotation } from "../models";

function setup() {
  const log: string[] = [];
  const overlay = fromPartial<CanvasOverlay>({
    applyTextAnnotationStyle: (a: object) => log.push(`text-style ${idOf(a)}`),
    applyShapeAnnotationStyle: (a: object) => log.push(`shape-style ${idOf(a)}`),
    applyHighlightAnnotationStyle: (a: object) => log.push(`highlight-style ${idOf(a)}`),
    reorderAnnotation: (a: object, dir: string) => log.push(`reorder ${idOf(a)} ${dir}`),
  });
  const kept = new Set<unknown>();
  const editor = new AnnotationEditor({
    overlayOf: () => overlay,
    redraw: (page) => log.push(`redraw ${page}`),
    has: (a) => kept.has(a),
    beginEdit: () => log.push("begin"),
    edited: () => log.push("edited"),
    markDirty: () => log.push("dirty"),
  }, {
    showText: () => log.push("show text"),
    showShape: (_a, panel) => log.push(`show shape ${panel}`),
    showHighlight: () => log.push("show highlight"),
    showSignature: () => log.push("show signature"),
    hide: (p) => log.push(`hide ${p}`),
  });
  return { log, editor, kept };
}

const text = fromPartial<TextAnnotation>({ id: "t", kind: "text", page: 1 });
const rect = fromPartial<RectAnnotation>({ id: "r", kind: "rect", page: 1 });
const pencil = fromPartial<InkAnnotation>({ id: "i", kind: "ink", page: 1 });
const highlight = fromPartial<HighlightAnnotation>({ id: "h", kind: "highlight", page: 1 });

describe("AnnotationEditor", () => {
  it("edits one of text box, shape and highlight at a time", () => {
    const { log, editor } = setup();
    editor.textSelected(text);
    expect(log).toEqual(["show text", "hide shape", "hide highlight"]);
    log.length = 0;
    editor.shapeSelected(pencil);
    expect(log).toEqual(["show shape pencil", "hide text", "hide highlight"]);
    expect(editor.editing).toBe(pencil);
    editor.textSelected(null);
    expect(editor.editing).toBe(pencil);
    editor.shapeSelected(null);
    expect(editor.editing).toBeNull();
  });

  it("applies a style change to the annotation being edited", () => {
    const { log, editor } = setup();
    editor.highlightSelected(highlight);
    log.length = 0;
    editor.restyle(defaultToolState());
    expect(log).toEqual(["highlight-style h", "dirty"]);
    editor.shapeSelected(rect);
    log.length = 0;
    editor.restyle(defaultToolState());
    expect(log).toEqual(["shape-style r", "dirty"]);
  });

  it("does nothing to annotations on a style change when nothing is edited", () => {
    const { log, editor } = setup();
    editor.restyle(defaultToolState());
    expect(log).toEqual([]);
  });

  it("recolours a drawn signature's ink once", () => {
    const { log, editor, kept } = setup();
    const sig = fromPartial<SignatureAnnotation>({ id: "s", kind: "signature", page: 2, vector: fromPartial({}), color: { r: 1, g: 2, b: 3 } });
    kept.add(sig);
    editor.selectionChanged(sig);
    expect(log).toEqual(["show signature"]);
    log.length = 0;
    const style = { ...defaultToolState(), signatureColor: { r: 9, g: 9, b: 9 } };
    editor.restyle(style);
    expect(log).toEqual(["begin", "redraw 2", "edited"]);
    expect(sig.color).toEqual({ r: 9, g: 9, b: 9 });
    log.length = 0;
    editor.restyle(style);
    expect(log).toEqual([]);
    editor.selectionChanged(null);
    expect(log).toEqual(["hide signature"]);
  });

  it("stops editing a deleted annotation and hides its panel only", () => {
    const { log, editor } = setup();
    editor.textSelected(text);
    log.length = 0;
    editor.removed(rect);
    expect(log).toEqual([]);
    editor.removed(text);
    expect(log).toEqual(["hide text"]);
    expect(editor.editing).toBeNull();
  });

  it("reorders text boxes and shapes, not highlights", () => {
    const { log, editor } = setup();
    editor.highlightSelected(highlight);
    log.length = 0;
    editor.reorder("up");
    expect(log).toEqual([]);
    editor.textSelected(text);
    log.length = 0;
    editor.reorder("down");
    expect(log).toEqual(["reorder t down"]);
  });

  it("drops the edit and hides the panels, or releases it quietly", () => {
    const { log, editor } = setup();
    editor.textSelected(text);
    log.length = 0;
    editor.release();
    expect(log).toEqual([]);
    expect(editor.editing).toBeNull();
    editor.textSelected(text);
    log.length = 0;
    editor.drop();
    expect(log).toEqual(["hide text", "hide shape", "hide highlight"]);
  });
});
