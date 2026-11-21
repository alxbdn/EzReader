import type { Annotation, HighlightAnnotation, TextAnnotation } from "./models";
import type { CanvasOverlay, ShapeAnnotation } from "./canvas-overlay";

type Handler<T> = (value: T) => void;

/**
 * What the annotation overlays of a document's pages report, wired once for the whole document.
 *
 * Every page has its own overlay, so the viewer passes one instance of this to all of them: a
 * listener added here hears every page, including pages laid out later, and nothing has to be
 * rewired when the layout is rebuilt. It also holds the one window `keydown` listener the
 * overlays share, instead of one per page.
 */
export class OverlayEvents {
  private readonly pickHandlers: ((ann: Annotation, overlay: CanvasOverlay) => void)[] = [];
  private readonly textHandlers: Handler<TextAnnotation | null>[] = [];
  private readonly shapeHandlers: Handler<ShapeAnnotation | null>[] = [];
  private readonly highlightHandlers: Handler<HighlightAnnotation | null>[] = [];
  private readonly keyTargets = new Set<Handler<KeyboardEvent>>();
  private listening = false;

  /** A click on an existing annotation, or one just placed, on `overlay`'s page. */
  onPick(h: (ann: Annotation, overlay: CanvasOverlay) => void): void { this.pickHandlers.push(h); }
  /** The selected text box, or null when it is no longer selected. */
  onTextSelected(h: Handler<TextAnnotation | null>): void { this.textHandlers.push(h); }
  /** The selected rectangle, circle or ink stroke, or null. */
  onShapeSelected(h: Handler<ShapeAnnotation | null>): void { this.shapeHandlers.push(h); }
  /** The selected highlight, or null. */
  onHighlightSelected(h: Handler<HighlightAnnotation | null>): void { this.highlightHandlers.push(h); }

  get hasPickListeners(): boolean { return this.pickHandlers.length > 0; }

  picked(ann: Annotation, overlay: CanvasOverlay): void { for (const h of this.pickHandlers) h(ann, overlay); }
  textSelected(ann: TextAnnotation | null): void { for (const h of this.textHandlers) h(ann); }
  shapeSelected(ann: ShapeAnnotation | null): void { for (const h of this.shapeHandlers) h(ann); }
  highlightSelected(ann: HighlightAnnotation | null): void { for (const h of this.highlightHandlers) h(ann); }

  /** Calls `h` on every key pressed in the window, in the order overlays subscribed, until the returned function is called. */
  listenForKeys(h: Handler<KeyboardEvent>): () => void {
    if (!this.listening) {
      this.listening = true;
      window.addEventListener("keydown", this.onKeyDown);
    }
    this.keyTargets.add(h);
    return () => { this.keyTargets.delete(h); };
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    // Like separate listeners: one removed during the dispatch is skipped, one added waits for the next key.
    for (const h of [...this.keyTargets]) if (this.keyTargets.has(h)) h(e);
  };
}
