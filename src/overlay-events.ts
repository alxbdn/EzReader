import type { Annotation, HighlightAnnotation, TextAnnotation } from "./models";
import type { CanvasOverlay, ShapeAnnotation } from "./canvas-overlay";

type Handler<T> = (value: T) => void;

export class OverlayEvents {
  private readonly pickHandlers: ((ann: Annotation, overlay: CanvasOverlay) => void)[] = [];
  private readonly textHandlers: Handler<TextAnnotation | null>[] = [];
  private readonly shapeHandlers: Handler<ShapeAnnotation | null>[] = [];
  private readonly highlightHandlers: Handler<HighlightAnnotation | null>[] = [];
  private readonly keyTargets = new Set<Handler<KeyboardEvent>>();
  private listening = false;

  onPick(h: (ann: Annotation, overlay: CanvasOverlay) => void): void { this.pickHandlers.push(h); }
  onTextSelected(h: Handler<TextAnnotation | null>): void { this.textHandlers.push(h); }
  onShapeSelected(h: Handler<ShapeAnnotation | null>): void { this.shapeHandlers.push(h); }
  onHighlightSelected(h: Handler<HighlightAnnotation | null>): void { this.highlightHandlers.push(h); }

  get hasPickListeners(): boolean { return this.pickHandlers.length > 0; }

  picked(ann: Annotation, overlay: CanvasOverlay): void { for (const h of this.pickHandlers) h(ann, overlay); }
  textSelected(ann: TextAnnotation | null): void { for (const h of this.textHandlers) h(ann); }
  shapeSelected(ann: ShapeAnnotation | null): void { for (const h of this.shapeHandlers) h(ann); }
  highlightSelected(ann: HighlightAnnotation | null): void { for (const h of this.highlightHandlers) h(ann); }

  listenForKeys(h: Handler<KeyboardEvent>): () => void {
    if (!this.listening) {
      this.listening = true;
      window.addEventListener("keydown", this.onKeyDown);
    }
    this.keyTargets.add(h);
    return () => { this.keyTargets.delete(h); };
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    for (const h of [...this.keyTargets]) if (this.keyTargets.has(h)) h(e);
  };
}
