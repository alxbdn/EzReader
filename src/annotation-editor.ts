import type { ActiveToolState, Annotation, HighlightAnnotation, RgbColor, SignatureAnnotation, TextAnnotation } from "./models";
import type { CanvasOverlay, ShapeAnnotation } from "./canvas-overlay";
import { SIGNATURE_INK } from "./signature-ink";

type Styled =
  | { kind: "text"; ann: TextAnnotation }
  | { kind: "shape"; ann: ShapeAnnotation }
  | { kind: "highlight"; ann: HighlightAnnotation };

export type StylePanel = Styled["kind"] | "signature";

export interface StylePanels {
  showText(ann: TextAnnotation): void;
  showShape(ann: ShapeAnnotation, panel: "pencil" | "shapes"): void;
  showHighlight(ann: HighlightAnnotation): void;
  showSignature(color: RgbColor): void;
  hide(panel: StylePanel): void;
}

export interface EditedDocument {
  overlayOf(page: number): CanvasOverlay | null;
  redraw(page: number): void;
  has(ann: Annotation): boolean;
  beginEdit(changing: Annotation): void;
  edited(): void;
  markDirty(): void;
}

export class AnnotationEditor {
  private styled: Styled | null = null;
  private signature: SignatureAnnotation | null = null;

  constructor(private readonly doc: EditedDocument, private readonly panels: StylePanels) {}

  get editing(): TextAnnotation | ShapeAnnotation | HighlightAnnotation | null { return this.styled?.ann ?? null; }

  textSelected(ann: TextAnnotation | null): void {
    if (ann) this.take({ kind: "text", ann });
    else this.leave("text");
  }

  shapeSelected(ann: ShapeAnnotation | null): void {
    if (ann) this.take({ kind: "shape", ann });
    else this.leave("shape");
  }

  highlightSelected(ann: HighlightAnnotation | null): void {
    if (ann) this.take({ kind: "highlight", ann });
    else this.leave("highlight");
  }

  selectionChanged(ann: Annotation | null): void {
    if (ann?.kind === "signature" && ann.vector) {
      this.signature = ann;
      this.panels.showSignature(ann.color ?? SIGNATURE_INK);
    } else if (this.signature) {
      this.signature = null;
      this.panels.hide("signature");
    }
  }

  drop(): void {
    this.styled = null;
    this.panels.hide("text");
    this.panels.hide("shape");
    this.panels.hide("highlight");
  }

  release(): void {
    this.styled = null;
  }

  removed(ann: Annotation): void {
    if (this.styled?.ann === ann) {
      this.panels.hide(this.styled.kind);
      this.styled = null;
    }
  }

  restyle(style: ActiveToolState): void {
    const s = this.styled;
    if (s) {
      const overlay = this.doc.overlayOf(s.ann.page);
      if (s.kind === "text") overlay?.applyTextAnnotationStyle(s.ann, style);
      else if (s.kind === "shape") overlay?.applyShapeAnnotationStyle(s.ann, style.shapeColor, style.strokeWidth, style.fillColor, style.opacity);
      else overlay?.applyHighlightAnnotationStyle(s.ann, style.highlightColor, style.highlightOpacity);
      this.doc.markDirty();
      return;
    }
    const ann = this.signature;
    if (!ann || !this.doc.has(ann)) return;
    const c = style.signatureColor;
    if (ann.color && ann.color.r === c.r && ann.color.g === c.g && ann.color.b === c.b) return;
    this.doc.beginEdit(ann);
    ann.color = { ...c };
    this.doc.redraw(ann.page);
    this.doc.edited();
  }

  reorder(dir: "up" | "down"): void {
    const s = this.styled;
    if (!s || s.kind === "highlight") return;
    this.doc.overlayOf(s.ann.page)?.reorderAnnotation(s.ann, dir);
  }

  private take(next: Styled): void {
    this.styled = next;
    if (next.kind === "text") this.panels.showText(next.ann);
    else if (next.kind === "shape") this.panels.showShape(next.ann, next.ann.kind === "ink" && !next.ann.arrow ? "pencil" : "shapes");
    else this.panels.showHighlight(next.ann);
    for (const kind of ["text", "shape", "highlight"] as const) if (kind !== next.kind) this.panels.hide(kind);
  }

  private leave(kind: Styled["kind"]): void {
    if (this.styled?.kind === kind) this.styled = null;
    this.panels.hide(kind);
  }
}
