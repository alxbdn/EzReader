import {
  canvasToPdf,
  fontCss,
  hexToRgb,
  pdfToCanvas,
  rgbToCss,
  rgbToHex,
  type ActiveToolState,
  type Annotation,
  type CircleAnnotation,
  type HighlightAnnotation,
  type ImageAnnotation,
  type InkAnnotation,
  type NoteAnnotation,
  type RectAnnotation,
  type RedactAnnotation,
  type RgbColor,
  type SignatureAnnotation,
  type InkVector,
  type StampAnnotation,
  type TextAlignmentValue,
  type TextAnnotation,
  type ToolKind,
  type FontFamilyValue,
  DRAW_TOOLS,
} from "./models";
import { drawVector } from "./signature-ink";
import type { AnnotationSession } from "./annotation-session";
import type { SelectionOwner, ToolSelection } from "./tool-selection";

/** Shapes whose outline, fill, thickness and opacity can be changed. */
export type ShapeAnnotation = RectAnnotation | CircleAnnotation | InkAnnotation;

/** Default sticky-note size, in PDF points. */
/** Size of a sticky note placed by a click (points); a drag sets another size. */
const NOTE_W = 150;
const NOTE_H = 100;
const NOTE_FONT = 10;
const NOTE_PAD = 6;
/** How far each note's text is scrolled (points); kept while the app runs. */
const noteScroll = new WeakMap<NoteAnnotation, number>();
/** Height of each note's text as last drawn (points). */
const noteTextHeight = new WeakMap<NoteAnnotation, number>();

/** How far the text of `ann` can scroll (points). */
function noteMaxScroll(ann: NoteAnnotation): number {
  return Math.max(0, (noteTextHeight.get(ann) ?? 0) - (ann.height - 2 * NOTE_PAD));
}

/** Size of a new check mark or cross, in PDF points. */
const STAMP_SIZE = 22;

/** Pictures keep their proportions when resized from a corner. */
/** Pixels of an annotation (each way) that a drag keeps on its page. */
const REACHABLE = 24;
const KEEPS_RATIO = new Set<Annotation["kind"]>(["signature", "image", "stamp"]);

/** Decoded pictures, by their base64 data, so redraws don't decode again. */
const pictures = new Map<string, HTMLImageElement>();

/** A picture's base64 data as an image URL (JPEG or PNG). */
export function pictureSrc(b64: string): string {
  return `data:image/${b64.startsWith("/9j/") ? "jpeg" : "png"};base64,${b64}`;
}

/** Text of the page under the Edit text tool, in PDF points. */
export interface PageTextItem {
  text: string;
  /** Baseline start. */
  x: number;
  y: number;
  width: number;
  fontSize: number;
  family: FontFamilyValue;
  /** Page colour around the words, to paint them over. */
  background: RgbColor;
}

/** Average glyph width (em) the PDF writer assumes when wrapping text. */
const PDF_CHAR_W: Record<string, number> = { helvetica: 0.5, times: 0.45, courier: 0.6 };

/** Minimal duck-type for pdfjs PageViewport — avoids importing pdfjs-dist here. */
interface PdfViewport {
  convertToViewportPoint(pdfX: number, pdfY: number): number[];
  convertToPdfPoint(viewX: number, viewY: number): number[];
  rotation: number;
}

type TextAnnotationSelectedHandler  = (ann: TextAnnotation | null) => void;
type ShapeAnnotationSelectedHandler = (ann: ShapeAnnotation | null) => void;
type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const HANDLE_R = 4; // half-size of handle squares in px
/** Selection boxes and handles: the app's selection red (as in the page panel). */
const SELECT = "#E53935";
const HANDLE_HIT = 7; // hit radius in px
const HANDLE_CURSORS: Record<ResizeHandle, string> = {
  nw: "nw-resize", n: "n-resize",  ne: "ne-resize",
  e:  "e-resize",  se: "se-resize", s:  "s-resize",
  sw: "sw-resize", w:  "w-resize",
};
const MIN_SIZE_PT = 10; // minimum annotation dimension in PDF pts

/**
 * A click on a page that closes an open text box or note only closes it:
 * it does not also start a new annotation with the active tool.
 */
function endsEditOnly(ev: MouseEvent): void {
  if ((ev.target as Element | null)?.classList?.contains("page-annotation-canvas")) ev.stopPropagation();
}

export class CanvasOverlay implements SelectionOwner {
  private canvas: HTMLCanvasElement;
  private container: HTMLElement;
  private ctx: CanvasRenderingContext2D;

  /** The active tool's style presets, shared by every page. */
  private get style(): ActiveToolState { return this.tools.state; }
  private activeTool: ToolKind = "select";
  private editingAnn: Annotation | null = null;

  // ── Draw state ──────────────────────────────────────────────────────────────
  private isDrawing = false;
  private startX = 0;
  private startY = 0;
  /** Canvas points of the pencil stroke being drawn. */
  private inkPts: [number, number][] = [];

  // ── Select / move / resize state ────────────────────────────────────────────
  /** The selected annotation when it is on this page (one selection across all pages). */
  private get selected(): Annotation | null {
    const s = this.tools.selected;
    return s && this.shown && s.page === this.currentPage ? s : null;
  }
  private set selected(ann: Annotation | null) {
    if (ann) this.tools.select(ann, this);
    else if (this.selected) this.tools.select(null);
  }
  private dragging = false;
  private resizing = false;
  private resizeHandle: ResizeHandle | null = null;
  /** PDF-coord anchor for the FIXED edge during resize */
  private resizeAnchorX = 0;
  private resizeAnchorY = 0;
  private dragTarget: Annotation | null = null;
  private dragOrigX = 0;
  private dragOrigY = 0;
  private dragOrigW = 0;
  private dragOrigH = 0;
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  /** PDF coords of the mouse at drag-start — used for delta-based dragging. */
  private dragStartPdfX = 0;
  private dragStartPdfY = 0;
  /** Where the dragged annotation was when the drag started (on this page). */
  private dragBaseX = 0;
  private dragBaseY = 0;
  /** A move, resize or corner drag follows the pointer anywhere (window listeners). */
  private tracking = false;
  /** The overlay of each page, by its page wrapper: a drag can hand over to another page. */
  private static readonly byContainer = new WeakMap<HTMLElement, CanvasOverlay>();
  /** Whether the current drag has reported "about to modify" yet. */
  private changeNotified = true;
  /** Corner of a stretchable redaction being dragged, as page points. */
  private vertexDrag: { ann: RedactAnnotation; index: number; pts: [number, number][] } | null = null;

  // ── Page state ──────────────────────────────────────────────────────────────
  private currentPage = 1;
  private pageHeightPt = 841;
  private scale = 1.5;
  private viewport: PdfViewport | null = null;
  private viewportRotation = 0;

  // ── Callbacks ───────────────────────────────────────────────────────────────
  private textSelectedHandlers:  TextAnnotationSelectedHandler[]  = [];
  private shapeSelectedHandlers: ShapeAnnotationSelectedHandler[] = [];

  /** Called on hover when no annotation is hit; return the desired cursor string (e.g. "pointer") or "" for default. */
  onHoverCursor: ((offsetX: number, offsetY: number) => string) | null = null;

  /** False while the page is cleared (scrolled out of range): nothing is drawn. */
  private shown = false;

  /** This page's annotations, straight from the session (the single source of truth). */
  private get committed(): readonly Annotation[] {
    return this.shown ? this.session.forPage(this.currentPage) : [];
  }

  constructor(
    canvas: HTMLCanvasElement,
    container: HTMLElement,
    private readonly tools: ToolSelection,
    private readonly session: AnnotationSession,
  ) {
    this.canvas = canvas;
    this.container = container;
    this.ctx = this.canvas.getContext("2d")!;

    this.canvas.addEventListener("mousedown",    this.onMouseDown);
    this.canvas.addEventListener("mousemove",    this.onMouseMove);
    this.canvas.addEventListener("mouseup",      this.onMouseUp);
    this.canvas.addEventListener("mouseleave",   this.onMouseLeave);
    this.canvas.addEventListener("dblclick",     this.onDblClick);
    this.canvas.addEventListener("contextmenu",  this.onContextMenu);
    window.addEventListener("keydown", this.onKeyDown);

    // In select mode the canvas has pointer-events:none by default so text
    // selection works.  We listen on the container (always receives
    // events) to detect when the cursor is over an annotation and temporarily
    // flip pointer-events:auto so the canvas can handle clicks/drags.
    CanvasOverlay.byContainer.set(container, this);
    container.addEventListener("mousemove", this.onContainerMouseMove);
    container.addEventListener("mousedown", this.onContainerMouseDown);
    container.addEventListener("wheel", this.onWheel, { passive: false });

    this.applyPointerEvents(this.activeTool);
  }

  onTextAnnotationSelected (h: TextAnnotationSelectedHandler):  void { this.textSelectedHandlers.push(h); }
  onShapeAnnotationSelected(h: ShapeAnnotationSelectedHandler): void { this.shapeSelectedHandlers.push(h); }

  /** A click only selects; the first actual move or resize opens the change. */
  private notifyChangeOnce(): void {
    if (this.changeNotified) return;
    this.changeNotified = true;
    this.session.beginEdit();
  }
  private emitTextSelected  (a: TextAnnotation | null):                void { this.textSelectedHandlers.forEach(h => h(a)); }
  private emitShapeSelected (a: ShapeAnnotation | null): void { this.shapeSelectedHandlers.forEach(h => h(a)); }

  private pickHandlers: ((ann: Annotation) => void)[] = [];
  /**
   * A click (no drag) with a drawing tool on an existing annotation: the app
   * switches back to selecting, then calls `select(ann)`.
   */
  onPick(h: (ann: Annotation) => void): void { this.pickHandlers.push(h); }

  /** Selects `ann` (ready to move, resize or restyle). */
  select(ann: Annotation): void {
    if (!this.committed.includes(ann)) return;
    this.selected = ann;
    this.redrawCommitted();
    this.emitTextSelected(ann.kind === "text" ? ann : null);
    this.emitShapeSelected((ann.kind === "rect" || ann.kind === "circle" || ann.kind === "ink") ? ann : null);
  }

  get currentTool(): ToolKind { return this.activeTool; }

  /** Drawing a freeform redaction area. */
  private get lassoing(): boolean { return this.activeTool === "redact" && this.style.redactShape === "lasso"; }

  /** Where the page's annotation layer is on screen. */
  get screenRect(): DOMRect { return this.canvas.getBoundingClientRect(); }

  /** Apply shape style fields to an existing shape or stroke and redraw. */
  applyShapeAnnotationStyle(
    ann: ShapeAnnotation,
    color: RgbColor,
    strokeWidth: number,
    fillColor: RgbColor | null,
    opacity: number,
  ): void {
    this.session.beginEdit();
    ann.color = { ...color };
    ann.strokeWidth = strokeWidth;
    ann.fillColor = fillColor ? { ...fillColor } : null;
    ann.opacity = opacity;
    this.redrawCommitted();
    this.session.edited();
  }

  /** Apply text style fields to an existing annotation and redraw. */
  applyTextAnnotationStyle(
    ann: TextAnnotation,
    style: Pick<ActiveToolState, "color" | "fontSize" | "bold" | "italic" | "underline" | "alignment" | "fontFamily" | "textBackground">
  ): void {
    this.session.beginEdit();
    ann.color     = { ...style.color };
    ann.backgroundColor = style.textBackground ? { ...style.textBackground } : null;
    ann.fontFamily = style.fontFamily;
    ann.fontSize  = style.fontSize;
    ann.bold      = style.bold;
    ann.italic    = style.italic;
    ann.underline = style.underline;
    ann.alignment = style.alignment;
    this.redrawCommitted();
    this.session.edited();
  }

  /** The shared tool state changed: follow its tool. */
  refreshStyle(): void {
    this.activeTool = this.style.tool;
    this.applyPointerEvents(this.activeTool);
  }

  /** The selection moved to another page: stop drawing its box here. */
  selectionLost(): void {
    this.redrawCommitted();
  }

  setTool(tool: ToolKind): void {
    if (tool !== "select") {
      this.selected = null;
      this.dragging = false;
      this.resizing = false;
      this.dragTarget = null;
      this.redrawCommitted();
    }
    this.activeTool = tool;
    this.applyPointerEvents(tool);
    if (tool === "text" || tool === "highlight") this.canvas.style.cursor = "text";
    else if (tool === "select")  this.canvas.style.cursor = "default";
    else if (tool !== "signature") this.canvas.style.cursor = "crosshair";
    else                         this.canvas.style.cursor = "";
  }

  private applyPointerEvents(tool: ToolKind): void {
    // Annotation canvas only captures events when a draw tool is active.
    // "select" and "signature" keep pointer-events:none so the text layer
    // (below in z-index) receives events and text can be selected.
    this.canvas.style.pointerEvents = DRAW_TOOLS.includes(tool) ? "auto" : "none";
  }

  /** The page was cleared (scrolled out of range): draws nothing until the next sync. */
  hide(): void {
    this.selected = null;
    this.syncToPage(this.currentPage, 1, 841);
    this.shown = false;
    this.redrawCommitted();
  }

  /** Convert PDF user-space point → canvas pixel coords (handles rotation via viewport). */
  private toCanvas(pdfX: number, pdfY: number): [number, number] {
    if (this.viewport) {
      const r = this.viewport.convertToViewportPoint(pdfX, pdfY);
      return [r[0], r[1]];
    }
    const c = pdfToCanvas(pdfX, pdfY, this.scale, this.pageHeightPt);
    return [c.x, c.y];
  }

  /** Convert canvas pixel coords → PDF user-space point (handles rotation via viewport). */
  private toPdf(canvasX: number, canvasY: number): [number, number] {
    if (this.viewport) {
      const r = this.viewport.convertToPdfPoint(canvasX, canvasY);
      return [r[0], r[1]];
    }
    const p = canvasToPdf(canvasX, canvasY, this.scale, this.pageHeightPt);
    return [p.x, p.y];
  }

  /** Shows page `page`'s annotations at this scale (after a render). */
  syncToPage(page: number, scale: number, pageHeightPt: number, viewport?: PdfViewport): void {
    this.shown        = true;
    this.currentPage  = page;
    this.scale        = scale;
    this.pageHeightPt = pageHeightPt;
    this.viewport         = viewport ?? null;
    this.viewportRotation = viewport?.rotation ?? 0;
    // A re-render (zoom, layout) keeps the selection if the annotation is still there.
    if (this.selected && !this.committed.includes(this.selected)) this.selected = null;
    this.dragging = false;
    this.resizing = false;
    this.dragTarget = null;

    this.redrawCommitted();
    // Always reset pointer-events to the correct state for the current tool.
    // Without this, if the canvas was left with pointer-events:auto (from a draw
    // mode or annotation hover) before loading a new PDF, form inputs below the
    // canvas would be unclickable.
    this.applyPointerEvents(this.activeTool);
  }

  // ── Bounding box ─────────────────────────────────────────────────────────────

  private getAnnBounds(ann: Annotation): { left: number; top: number; right: number; bottom: number } {
    const { scale } = this;
    if (ann.kind === "text") {
      const [bx, by]  = this.toCanvas(ann.x, ann.y);
      const lineH     = ann.fontSize * scale * 1.2;
      const lineCount = this.textLineCount(ann);
      const maxW      = ann.width * scale;
      const localTop    = -2 - ann.fontSize * scale;
      const localBottom = lineCount * lineH + 2;

      if (this.viewportRotation === 0) {
        return { left: bx, right: bx + maxW, top: by + localTop, bottom: by + localBottom };
      }
      const cos = Math.cos((this.viewportRotation * Math.PI) / 180);
      const sin = Math.sin((this.viewportRotation * Math.PI) / 180);
      const corners: [number, number][] = [
        [0,    localTop],    [maxW, localTop],
        [maxW, localBottom], [0,    localBottom],
      ];
      const xs = corners.map(([lx, ly]) => bx + lx * cos - ly * sin);
      const ys = corners.map(([lx, ly]) => by + lx * sin + ly * cos);
      return {
        left: Math.min(...xs), right: Math.max(...xs),
        top:  Math.min(...ys), bottom: Math.max(...ys),
      };
    } else {
      // Convert the two opposite PDF corners and take the axis-aligned bounding box.
      const [x1, y1] = this.toCanvas(ann.x, ann.y + ann.height);            // PDF top-left
      const [x2, y2] = this.toCanvas(ann.x + ann.width, ann.y);             // PDF bottom-right
      return {
        left:   Math.min(x1, x2),
        top:    Math.min(y1, y2),
        right:  Math.max(x1, x2),
        bottom: Math.max(y1, y2),
      };
    }
  }

  private hitTest(cx: number, cy: number): Annotation | null {
    const P = 5;
    for (let i = this.committed.length - 1; i >= 0; i--) {
      if (this.committed[i].kind === "highlight") continue;
      const b = this.getAnnBounds(this.committed[i]);
      if (cx >= b.left - P && cx <= b.right  + P &&
          cy >= b.top  - P && cy <= b.bottom + P) return this.committed[i];
    }
    return null;
  }

  // ── Resize handles ───────────────────────────────────────────────────────────

  /** Returns canvas-px positions of all handles for a selection box. */
  private handlePositions(b: { left: number; top: number; right: number; bottom: number }): Record<ResizeHandle, { x: number; y: number }> {
    const mx = (b.left + b.right)  / 2;
    const my = (b.top  + b.bottom) / 2;
    return {
      nw: { x: b.left,  y: b.top    }, n: { x: mx,     y: b.top    }, ne: { x: b.right, y: b.top    },
      e:  { x: b.right, y: my       },                                  w: { x: b.left,  y: my       },
      sw: { x: b.left,  y: b.bottom }, s: { x: mx,     y: b.bottom }, se: { x: b.right, y: b.bottom },
    };
  }

  private handlesFor(ann: Annotation): ResizeHandle[] {
    if (ann.kind === "text") return ["w", "e"];
    if (ann.kind === "redact" && ann.shape === "poly") return []; // its corners are the handles
    if (KEEPS_RATIO.has(ann.kind)) return ["nw", "ne", "se", "sw"];
    return ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  }

  /** Page points of a freeform or stretchable redaction's outline. */
  private outlineOf(ann: RedactAnnotation): [number, number][] {
    return (ann.points ?? []).map(([u, v]) => [ann.x + u * ann.width, ann.y + v * ann.height]);
  }

  /** Index of the stretchable redaction's corner under the cursor, if any. */
  private hitVertex(cx: number, cy: number, ann: Annotation): number | null {
    if (ann.kind !== "redact" || ann.shape !== "poly") return null;
    const pts = this.outlineOf(ann);
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = this.toCanvas(pts[i][0], pts[i][1]);
      if (Math.hypot(cx - x, cy - y) <= HANDLE_HIT + 1) return i;
    }
    return null;
  }

  /** Stores page points as the box and points of `ann` (relative to the box). */
  private setOutline(ann: RedactAnnotation, pts: [number, number][]): void {
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    const w = Math.max(Math.max(...xs) - x0, 1), h = Math.max(Math.max(...ys) - y0, 1);
    const round = (n: number) => Math.round(n * 10000) / 10000;
    ann.x = x0; ann.y = y0; ann.width = w; ann.height = h;
    ann.points = pts.map(([x, y]) => [round((x - x0) / w), round((y - y0) / h)]);
  }

  private hitHandle(cx: number, cy: number, ann: Annotation): ResizeHandle | null {
    const SEL_PAD = 5;
    const b = this.getAnnBounds(ann);
    const box = { left: b.left - SEL_PAD, top: b.top - SEL_PAD, right: b.right + SEL_PAD, bottom: b.bottom + SEL_PAD };
    const positions = this.handlePositions(box);
    for (const h of this.handlesFor(ann)) {
      const p = positions[h];
      if (Math.abs(cx - p.x) <= HANDLE_HIT && Math.abs(cy - p.y) <= HANDLE_HIT) return h;
    }
    return null;
  }

  /** Remaps a canvas-space handle to the PDF-space handle that accounts for
   *  the current viewport rotation, so startResize/applyResize always anchor
   *  the correct PDF edge and resize the correct PDF dimension.
   *
   *  At rotation 0 the mapping is identity.  At 90° the canvas up direction
   *  corresponds to PDF x+ (east), canvas right to PDF y+ (north), etc.
   *  Only applied for rect/circle annotations; text uses e/w exclusively. */
  private effectiveHandle(h: ResizeHandle): ResizeHandle {
    const rot = ((this.viewportRotation % 360) + 360) % 360;
    if (rot === 0) return h;
    const maps: Record<number, Record<ResizeHandle, ResizeHandle>> = {
       90: { n:"w",  ne:"nw", e:"n",  se:"ne", s:"e",  sw:"se", w:"s",  nw:"sw" },
      180: { n:"s",  ne:"sw", e:"w",  se:"nw", s:"n",  sw:"ne", w:"e",  nw:"se" },
      270: { n:"e",  ne:"se", e:"s",  se:"sw", s:"w",  sw:"nw", w:"n",  nw:"ne" },
    };
    return maps[rot]?.[h] ?? h;
  }

  /** Compute fixed-edge anchors in PDF pts for the given handle. */
  private startResize(ann: Annotation, handle: ResizeHandle): void {
    this.resizing      = true;
    this.resizeHandle  = handle;
    this.dragTarget    = ann;
    this.dragOrigX     = ann.x;
    this.dragOrigY     = ann.y;
    this.dragOrigW     = ann.width;
    this.dragOrigH     = ann.kind !== "text" ? ann.height : 0;

    // For rect/circle, remap the canvas-space handle to PDF-space so the
    // correct edge is anchored when the viewport is rotated.
    const eh = ann.kind !== "text" ? this.effectiveHandle(handle) : handle;

    // anchorX = the FIXED x edge (left or right) in PDF pts
    const left   = ann.x;
    const right  = ann.x + ann.width;
    const bottom = ann.y;
    const top    = ann.kind !== "text" ? ann.y + ann.height : ann.y;

    if (["e", "ne", "se"].includes(eh)) this.resizeAnchorX = left;
    else if (["w", "nw", "sw"].includes(eh)) this.resizeAnchorX = right;

    // anchorY = the FIXED y edge (top or bottom) in PDF pts
    if (["n", "ne", "nw"].includes(eh)) this.resizeAnchorY = bottom;
    else if (["s", "se", "sw"].includes(eh)) this.resizeAnchorY = top;
  }

  private applyResize(mouseX: number, mouseY: number): void {
    const ann = this.dragTarget!;
    const h   = ann.kind !== "text"
      ? this.effectiveHandle(this.resizeHandle!)
      : this.resizeHandle!;
    const [mx, my] = this.toPdf(mouseX, mouseY);
    const M   = MIN_SIZE_PT;

    if (h === "e" || h === "ne" || h === "se") {
      ann.width = Math.max(M, mx - this.resizeAnchorX);
    }
    if (h === "w" || h === "nw" || h === "sw") {
      const newLeft = Math.min(this.resizeAnchorX - M, mx);
      ann.width = this.resizeAnchorX - newLeft;
      ann.x = newLeft;
    }
    if (ann.kind !== "text") {
      if (h === "n" || h === "ne" || h === "nw") {
        ann.height = Math.max(M, my - this.resizeAnchorY);
      }
      if (h === "s" || h === "se" || h === "sw") {
        const newBottom = Math.min(this.resizeAnchorY - M, my);
        ann.y      = newBottom;
        ann.height = this.resizeAnchorY - newBottom;
      }
      if (KEEPS_RATIO.has(ann.kind) && this.dragOrigW > 0 && this.dragOrigH > 0) {
        // Follow the larger change and keep the proportions.
        const k = Math.max(ann.width / this.dragOrigW, ann.height / this.dragOrigH);
        ann.width = this.dragOrigW * k;
        ann.height = this.dragOrigH * k;
        if (h === "w" || h === "nw" || h === "sw") ann.x = this.resizeAnchorX - ann.width;
        if (h === "s" || h === "se" || h === "sw") ann.y = this.resizeAnchorY - ann.height;
      }
    }
  }

  // ── Redraw ───────────────────────────────────────────────────────────────────

  redrawCommitted(): void {
    const dpr = window.devicePixelRatio || 1;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr);
    for (const ann of this.committed) {
      if (ann === this.editingAnn) continue;
      this.drawAnnotation(ann);
    }
    if (this.selected && this.committed.includes(this.selected)) {
      this.drawSelectionBox(this.selected);
    }
  }

  private drawSelectionBox(ann: Annotation): void {
    const SEL_PAD = 5;
    const b = this.getAnnBounds(ann);
    const box = { left: b.left - SEL_PAD, top: b.top - SEL_PAD, right: b.right + SEL_PAD, bottom: b.bottom + SEL_PAD };

    this.ctx.strokeStyle = SELECT;
    this.ctx.lineWidth   = 1.5;
    this.ctx.setLineDash([5, 3]);
    this.ctx.strokeRect(box.left, box.top, box.right - box.left, box.bottom - box.top);
    this.ctx.setLineDash([]);

    if (ann.kind === "redact" && ann.shape === "poly") {
      this.ctx.fillStyle = "#fff";
      this.ctx.strokeStyle = SELECT;
      this.ctx.lineWidth = 1.5;
      for (const [px, py] of this.outlineOf(ann)) {
        const [x, y] = this.toCanvas(px, py);
        this.ctx.beginPath();
        this.ctx.arc(x, y, HANDLE_R + 1, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.stroke();
      }
    }

    // Draw resize handles
    const positions = this.handlePositions(box);
    this.ctx.fillStyle   = "#fff";
    this.ctx.strokeStyle = SELECT;
    this.ctx.lineWidth   = 1;
    for (const h of this.handlesFor(ann)) {
      const { x, y } = positions[h];
      this.ctx.fillRect  (x - HANDLE_R, y - HANDLE_R, HANDLE_R * 2, HANDLE_R * 2);
      this.ctx.strokeRect(x - HANDLE_R, y - HANDLE_R, HANDLE_R * 2, HANDLE_R * 2);
    }
  }

  // ── Annotation drawing ───────────────────────────────────────────────────────

  /** Compute the number of rendered lines for a text annotation (accounts for word-wrap). */
  private textLineCount(ann: TextAnnotation): number {
    const { scale } = this;
    const saved = this.ctx.font;
    this.ctx.font = `${ann.italic ? "italic" : "normal"} ${ann.bold ? "bold" : "300"} ${ann.fontSize * scale}px ${fontCss(ann.fontFamily)}`;
    const count = this.wrapLines(this.ctx, ann.content, ann.width * scale).length;
    this.ctx.font = saved;
    return count;
  }

  /** Split text on explicit newlines then word-wrap each paragraph to maxWidth. */
  private wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
    const result: string[] = [];
    for (const para of text.split("\n")) {
      if (!para) { result.push(""); continue; }
      const words = para.split(" ");
      let line = "";
      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (line && ctx.measureText(candidate).width > maxWidth) {
          result.push(line);
          line = word;
        } else {
          line = candidate;
        }
      }
      result.push(line);
    }
    return result;
  }

  private drawAnnotation(ann: Annotation): void {
    const ctx = this.ctx;
    ctx.save();
    if ((ann.kind === "rect" || ann.kind === "circle" || ann.kind === "ink") && ann.opacity != null) {
      ctx.globalAlpha = Math.max(0, Math.min(1, ann.opacity));
    }
    this.drawAnnotationBody(ann);
    ctx.restore();
  }

  private drawAnnotationBody(ann: Annotation): void {
    const ctx = this.ctx;
    const { scale } = this;

    if (ann.kind === "rect") {
      const [x1, y1] = this.toCanvas(ann.x, ann.y + ann.height); // PDF top-left
      const [x2, y2] = this.toCanvas(ann.x + ann.width, ann.y);  // PDF bottom-right
      const l = Math.min(x1, x2), t = Math.min(y1, y2), w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
      if (ann.fillColor) { ctx.fillStyle = rgbToCss(ann.fillColor); ctx.fillRect(l, t, w, h); }
      if (ann.strokeWidth > 0) {
        ctx.strokeStyle = rgbToCss(ann.color);
        ctx.lineWidth   = ann.strokeWidth * scale;
        ctx.strokeRect(l, t, w, h);
      }

    } else if (ann.kind === "circle") {
      const [x1, y1] = this.toCanvas(ann.x, ann.y + ann.height);
      const [x2, y2] = this.toCanvas(ann.x + ann.width, ann.y);
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
      if (ann.fillColor) { ctx.fillStyle = rgbToCss(ann.fillColor); ctx.fill(); }
      if (ann.strokeWidth > 0) {
        ctx.strokeStyle = rgbToCss(ann.color);
        ctx.lineWidth   = ann.strokeWidth * scale;
        ctx.stroke();
      }

    } else if (ann.kind === "ink") {
      this.strokeInk(ann.points.map(([u, v]) => this.toCanvas(ann.x + u * ann.width, ann.y + v * ann.height)),
        ann.color, ann.strokeWidth, ann.fillColor ?? null, !!ann.arrow);

    } else if (ann.kind === "highlight") {
      ctx.save();
      ctx.globalAlpha = ann.opacity;
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = rgbToCss(ann.color);
      for (const r of ann.rects) {
        const [x1, y1] = this.toCanvas(r.x, r.y + r.height);
        const [x2, y2] = this.toCanvas(r.x + r.width, r.y);
        ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      }
      ctx.restore();

    } else if (ann.kind === "note") {
      this.drawNote(ann);

    } else if (ann.kind === "text") {
      if (ann.cover) {
        const c = this.boxOf(ann.cover);
        ctx.fillStyle = rgbToCss(ann.cover.color);
        ctx.fillRect(c.l, c.t, c.w, c.h);
      }
      const [x, y] = this.toCanvas(ann.x, ann.y);
      const rotRad = (this.viewportRotation * Math.PI) / 180;
      ctx.save();
      ctx.translate(x, y);
      if (rotRad !== 0) ctx.rotate(rotRad);
      ctx.font      = `${ann.italic ? "italic" : "normal"} ${ann.bold ? "bold" : "300"} ${ann.fontSize * scale}px ${fontCss(ann.fontFamily)}`;
      const lineH   = ann.fontSize * scale * 1.2;
      const maxW    = ann.width * scale;
      const lines   = this.wrapLines(ctx, ann.content, maxW);
      if (ann.backgroundColor) {
        // Same box as the PDF writer: first line's ascent to last line's descent.
        const fs = ann.fontSize * scale;
        const top = -(fs * 0.95 + 2 * scale);
        const bottom = (lines.length - 1) * lineH + fs * 0.3 + 2 * scale;
        ctx.fillStyle = rgbToCss(ann.backgroundColor);
        ctx.fillRect(-3 * scale, top, maxW + 6 * scale, bottom - top);
      }
      ctx.fillStyle = rgbToCss(ann.color);
      ctx.textAlign = ann.alignment as CanvasTextAlign;
      const tx      = ann.alignment === "left" ? 0 : ann.alignment === "right" ? maxW : maxW / 2;
      lines.forEach((line, i) => {
        const ly = i * lineH;
        ctx.fillText(line, tx, ly);
        if (ann.underline) {
          const w      = ctx.measureText(line).width;
          const ulY    = ly + ann.fontSize * scale * 0.12;
          const startX = ann.alignment === "left" ? 0 : ann.alignment === "right" ? tx - w : tx - w / 2;
          ctx.strokeStyle = rgbToCss(ann.color);
          ctx.lineWidth   = 1;
          ctx.beginPath();
          ctx.moveTo(startX, ulY);
          ctx.lineTo(startX + w, ulY);
          ctx.stroke();
        }
      });
      ctx.restore();

    } else if (ann.kind === "redact") {
      // Solid black, outline included, like the saved result.
      this.redactPath(ann);
      ctx.fillStyle = "#000";
      ctx.fill();
      ctx.strokeStyle = "#000";
      ctx.lineWidth   = 1.5;
      ctx.stroke();

    } else if (ann.kind === "signature" || ann.kind === "image") {
      this.drawPicture(ann);

    } else if (ann.kind === "stamp") {
      this.drawStamp(ann);
    }
  }

  /** Outline of a redaction area as the current canvas path. */
  private redactPath(ann: RedactAnnotation): void {
    const ctx = this.ctx;
    const b = this.boxOf(ann);
    ctx.beginPath();
    if (ann.shape === "ellipse") {
      ctx.ellipse(b.l + b.w / 2, b.t + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
    } else if ((ann.shape === "lasso" || ann.shape === "poly") && ann.points && ann.points.length > 2) {
      this.outlineOf(ann).forEach(([px, py], i) => {
        const [x, y] = this.toCanvas(px, py);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.closePath();
    } else {
      ctx.rect(b.l, b.t, b.w, b.h);
    }
  }

  private drawPicture(ann: SignatureAnnotation | ImageAnnotation): void {
    if (ann.kind === "signature" && ann.vector && ann.vector.w > 0 && ann.vector.h > 0) {
      // Pen strokes: drawn as curves, sharp at any zoom.
      const v = ann.vector;
      const [x, y] = this.toCanvas(ann.x, ann.y + ann.height);
      const rotRad = (this.viewportRotation * Math.PI) / 180;
      this.ctx.save();
      this.ctx.translate(x, y);
      if (rotRad !== 0) this.ctx.rotate(rotRad);
      this.ctx.scale((ann.width * this.scale) / v.w, (ann.height * this.scale) / v.h);
      drawVector(this.ctx, v);
      this.ctx.restore();
      return;
    }
    let img = pictures.get(ann.imageData);
    if (!img) {
      img = new Image();
      img.onload = () => this.redrawCommitted();
      img.src = pictureSrc(ann.imageData);
      pictures.set(ann.imageData, img);
    }
    if (!img.complete || img.naturalWidth === 0) return;
    const [x, y] = this.toCanvas(ann.x, ann.y + ann.height); // PDF top-left → canvas anchor
    const rotRad = (this.viewportRotation * Math.PI) / 180;
    this.ctx.save();
    this.ctx.translate(x, y);
    if (rotRad !== 0) this.ctx.rotate(rotRad);
    this.ctx.drawImage(img, 0, 0, ann.width * this.scale, ann.height * this.scale);
    this.ctx.restore();
  }

  /** Same strokes as the PDF writer: a check is one stroke, a cross two. */
  private drawStamp(ann: StampAnnotation): void {
    const ctx = this.ctx;
    const at = (u: number, v: number) => this.toCanvas(ann.x + u * ann.width, ann.y + v * ann.height);
    const strokes: [number, number][][] = ann.mark === "check"
      ? [[[0.12, 0.52], [0.4, 0.22], [0.9, 0.82]]]
      : [[[0.15, 0.85], [0.85, 0.15]], [[0.85, 0.85], [0.15, 0.15]]];
    ctx.save();
    ctx.strokeStyle = rgbToCss(ann.color);
    ctx.lineWidth = Math.max(0.5, Math.min(ann.width, ann.height) * 0.14) * this.scale;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const stroke of strokes) {
      ctx.beginPath();
      stroke.forEach(([u, v], i) => {
        const [x, y] = at(u, v);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Draws a stroke through canvas points, with an optional fill or arrowhead. */
  private strokeInk(pts: [number, number][], color: RgbColor, strokeWidth: number, fill: RgbColor | null, arrow: boolean): void {
    if (pts.length < 2) return;
    const ctx = this.ctx;
    const lw = Math.max(0.5, strokeWidth * this.scale);
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = lw;
    ctx.strokeStyle = rgbToCss(color);
    ctx.fillStyle = rgbToCss(color);
    const path = pts.slice();
    let head: [number, number][] | null = null;
    if (arrow) {
      const [tx, ty] = path[path.length - 1];
      const [px, py] = path[path.length - 2];
      const len = Math.hypot(tx - px, ty - py);
      if (len > 0) {
        const ux = (tx - px) / len, uy = (ty - py) / len;
        const l = Math.min(len, Math.max(6, strokeWidth * 3.5) * this.scale);
        const hw = l * 0.55;
        const bx = tx - ux * l, by = ty - uy * l;
        head = [[tx, ty], [bx - uy * hw, by + ux * hw], [bx + uy * hw, by - ux * hw]];
        path[path.length - 1] = [tx - ux * l * 0.8, ty - uy * l * 0.8];
      }
    }
    ctx.beginPath();
    ctx.moveTo(path[0][0], path[0][1]);
    for (const [x, y] of path.slice(1)) ctx.lineTo(x, y);
    if (fill && !arrow) {
      ctx.closePath();
      ctx.fillStyle = rgbToCss(fill);
      ctx.fill();
    }
    if (strokeWidth > 0) ctx.stroke();
    if (head) {
      ctx.fillStyle = rgbToCss(color);
      ctx.beginPath();
      ctx.moveTo(head[0][0], head[0][1]);
      ctx.lineTo(head[1][0], head[1][1]);
      ctx.lineTo(head[2][0], head[2][1]);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  /** Canvas box of an annotation stored as x/y/width/height (any rotation). */
  private boxOf(ann: { x: number; y: number; width: number; height: number }): { l: number; t: number; w: number; h: number } {
    const [x1, y1] = this.toCanvas(ann.x, ann.y + ann.height);
    const [x2, y2] = this.toCanvas(ann.x + ann.width, ann.y);
    return { l: Math.min(x1, x2), t: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  }

  private drawNote(ann: NoteAnnotation): void {
    const ctx = this.ctx;
    const { scale } = this;
    const b = this.boxOf(ann);
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.18)";
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = rgbToCss(ann.color);
    ctx.fillRect(b.l, b.t, b.w, b.h);
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = rgbToCss({ r: ann.color.r * 0.8, g: ann.color.g * 0.8, b: ann.color.b * 0.8 });
    ctx.lineWidth = 0.75 * scale;
    ctx.strokeRect(b.l, b.t, b.w, b.h);
    if (ann !== this.editingAnn && ann.content) {
      ctx.beginPath();
      ctx.rect(b.l, b.t, b.w, b.h);
      ctx.clip();
      const [x, y] = this.toCanvas(ann.x + NOTE_PAD, ann.y + ann.height - NOTE_PAD - NOTE_FONT);
      ctx.translate(x, y);
      const rot = (this.viewportRotation * Math.PI) / 180;
      if (rot) ctx.rotate(rot);
      ctx.font = `${NOTE_FONT * scale}px ${fontCss("helvetica")}`;
      const lines = this.wrapLines(ctx, ann.content, (ann.width - 2 * NOTE_PAD) * scale);
      // Text taller than the note scrolls (vertically) inside it; a thin
      // bar on the right shows where you are.
      const lineH = NOTE_FONT * 1.2;
      const textH = lines.length * lineH;
      noteTextHeight.set(ann, textH);
      const innerH = ann.height - 2 * NOTE_PAD;
      const scroll = Math.min(noteScroll.get(ann) ?? 0, noteMaxScroll(ann));
      if (textH > innerH) {
        const thumbH = Math.max(8, innerH * (innerH / textH));
        const thumbY = -NOTE_FONT + (innerH - thumbH) * (scroll / (textH - innerH));
        ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
        ctx.fillRect((ann.width - 1.5 * NOTE_PAD - 1) * scale, thumbY * scale, 2 * scale, thumbH * scale);
      }
      ctx.beginPath();
      ctx.rect(-1, -NOTE_FONT * scale, (ann.width - 2 * NOTE_PAD) * scale + 2, innerH * scale);
      ctx.clip();
      ctx.fillStyle = "#262626";
      lines.forEach((line, i) => ctx.fillText(line, 0, (i * lineH - scroll) * scale));
    }
    ctx.restore();
  }

  private drawLivePreview(curX: number, curY: number): void {
    this.redrawCommitted();
    const ctx = this.ctx;
    if (this.activeTool === "ink" || this.activeTool === "line" || this.activeTool === "arrow") {
      const pts: [number, number][] = this.activeTool === "ink"
        ? this.inkPts
        : [[this.startX, this.startY], [curX, curY]];
      ctx.save();
      ctx.globalAlpha = this.style.opacity;
      this.strokeInk(pts, this.style.shapeColor, this.style.strokeWidth,
        this.activeTool === "ink" ? null : null, this.activeTool === "arrow");
      ctx.restore();
      return;
    }
    const x0 = Math.min(this.startX, curX);
    const y0 = Math.min(this.startY, curY);
    const w  = Math.abs(curX - this.startX);
    const h  = Math.abs(curY - this.startY);
    ctx.strokeStyle = rgbToCss(this.style.shapeColor);
    ctx.lineWidth   = Math.max(1, this.style.strokeWidth * this.scale);
    ctx.setLineDash([4, 3]);
    if (this.style.fillColor && (this.activeTool === "rect" || this.activeTool === "circle")) {
      ctx.fillStyle = rgbToCss(this.style.fillColor);
      ctx.globalAlpha = 0.6;
      if (this.activeTool === "rect") ctx.fillRect(x0, y0, w, h);
      else { ctx.beginPath(); ctx.ellipse(x0 + w / 2, y0 + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); ctx.fill(); }
      ctx.globalAlpha = 1;
    }
    if (this.activeTool === "rect") {
      ctx.strokeRect(x0, y0, w, h);
    } else if (this.activeTool === "note") {
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = rgbToCss(this.style.noteColor);
      ctx.fillRect(x0, y0, w, h);
      ctx.globalAlpha = 1;
    } else if (this.activeTool === "redact") {
      ctx.beginPath();
      if (this.lassoing) {
        this.inkPts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.closePath();
      } else if (this.style.redactShape === "ellipse") {
        ctx.ellipse(x0 + w / 2, y0 + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      } else {
        ctx.rect(x0, y0, w, h);
      }
      ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
      ctx.fill();
      ctx.strokeStyle = "#000";
      ctx.lineWidth   = 1.5;
      ctx.stroke();
    } else if (this.activeTool === "circle") {
      ctx.beginPath();
      ctx.ellipse(x0 + w / 2, y0 + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (this.activeTool === "text") {
      ctx.strokeStyle = "#aaaaaa";
      ctx.lineWidth   = 1;
      const lineH = this.style.fontSize * this.scale * 1.4;
      ctx.strokeRect(x0, y0, w, lineH);
    }
    ctx.setLineDash([]);
  }

  // ── Mouse handlers ────────────────────────────────────────────────────────────

  /** Runs on the parent viewer-container (always receives events regardless of
   *  canvas pointer-events).  In select mode, enables pointer-events on the
   *  canvas only when the cursor is actually over an annotation or resize handle,
   *  keeping text selection available for the rest of the page. */
  private onContainerMouseMove = (e: MouseEvent): void => {
    if (this.activeTool !== "select") return;
    if (this.dragging || this.resizing) return; // keep state stable mid-drag

    const rect = this.canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    const hitAnn = this.hitTest(cx, cy);
    const hitH   = this.selected ? this.hitHandle(cx, cy, this.selected) : null;
    const hitV   = this.selected ? this.hitVertex(cx, cy, this.selected) : null;
    const over   = hitAnn !== null || hitH !== null || hitV !== null;

    this.canvas.style.pointerEvents = over ? "auto" : "none";
    this.canvas.style.cursor = hitV !== null ? "move" : over
      ? (hitH ? HANDLE_CURSORS[hitH] : "grab")
      : "default";
  };

  private onContainerMouseDown = (e: MouseEvent): void => {
    if (this.activeTool !== "select") return;
    if (this.dragging || this.resizing) return;
    if (!this.selected) return;

    const rect = this.canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    const hitAnn = this.hitTest(cx, cy);
    const hitH   = this.hitHandle(cx, cy, this.selected);
    if (!hitAnn && !hitH && this.hitVertex(cx, cy, this.selected) === null) {
      this.selected = null;
      this.redrawCommitted();
      this.emitTextSelected(null);
      this.emitShapeSelected(null);
    }
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (this.activeTool === "signature") return;

    if (this.activeTool === "select") {
      // 0. A corner of the selected stretchable redaction
      if (this.selected?.kind === "redact") {
        const v = this.hitVertex(e.offsetX, e.offsetY, this.selected);
        if (v !== null) {
          this.changeNotified = false;
          this.vertexDrag = { ann: this.selected, index: v, pts: this.outlineOf(this.selected) };
          this.track();
          return;
        }
      }
      // 1. Check resize handle on selected annotation first
      if (this.selected) {
        const h = this.hitHandle(e.offsetX, e.offsetY, this.selected);
        if (h) {
          this.changeNotified = false;
          this.startResize(this.selected, h);
          this.canvas.style.cursor = HANDLE_CURSORS[h];
          this.track();
          return;
        }
      }
      // 2. Check for annotation hit (drag/select)
      const hit = this.hitTest(e.offsetX, e.offsetY);
      this.selected = hit;
      if (hit) {
        this.changeNotified = false;
        const bounds = this.getAnnBounds(hit);
        this.dragging    = true;
        this.dragTarget  = hit;
        this.dragOrigX   = hit.x;
        this.dragOrigY   = hit.y;
        this.dragBaseX   = hit.x;
        this.dragBaseY   = hit.y;
        this.dragOrigW   = hit.width;
        this.dragOrigH   = hit.kind !== "text" ? hit.height : 0;
        this.dragOffsetX = e.offsetX - bounds.left;
        this.dragOffsetY = e.offsetY - bounds.top;
        [this.dragStartPdfX, this.dragStartPdfY] = this.toPdf(e.offsetX, e.offsetY);
        this.canvas.style.cursor = "grabbing";
        this.track();
      }
      this.redrawCommitted();
      this.emitTextSelected(hit?.kind === "text" ? hit : null);
      this.emitShapeSelected((hit?.kind === "rect" || hit?.kind === "circle" || hit?.kind === "ink") ? hit : null);
      return;
    }

    if (this.activeTool === "text") {
      e.preventDefault();
      this.isDrawing = true;
      this.startX = e.offsetX;
      this.startY = e.offsetY;
      return;
    }

    if (this.activeTool === "ink" || this.lassoing) this.inkPts = [[e.offsetX, e.offsetY]];
    this.isDrawing = true;
    this.startX = e.offsetX;
    this.startY = e.offsetY;
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (this.activeTool === "select") {
      if (this.tracking) return; // the window listener follows the gesture
      // Hover: check handle cursor, then grab cursor
      if (this.selected) {
        const h = this.hitHandle(e.offsetX, e.offsetY, this.selected);
        if (h) { this.canvas.style.cursor = HANDLE_CURSORS[h]; return; }
      }
      if (this.hitTest(e.offsetX, e.offsetY)) {
        this.canvas.style.cursor = "grab";
      } else {
        const override = this.onHoverCursor?.(e.offsetX, e.offsetY);
        this.canvas.style.cursor = override || "default";
      }
      return;
    }

    if (!this.isDrawing) return;
    if (this.activeTool === "ink" || this.lassoing) {
      const last = this.inkPts[this.inkPts.length - 1];
      if (!last || Math.hypot(e.offsetX - last[0], e.offsetY - last[1]) >= 1.5) this.inkPts.push([e.offsetX, e.offsetY]);
    }
    this.drawLivePreview(e.offsetX, e.offsetY);
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (this.activeTool === "select") return; // gestures end in onGestureUp

    if (!this.isDrawing) return;
    this.isDrawing = false;

    // A plain click on an existing annotation picks it instead of adding one.
    if (!this.lassoing && Math.hypot(e.offsetX - this.startX, e.offsetY - this.startY) < 4 && this.pickHandlers.length > 0) {
      const hit = this.hitTest(this.startX, this.startY);
      if (hit) {
        this.inkPts = [];
        this.redrawCommitted();
        this.pickHandlers.forEach(h => h(hit));
        return;
      }
    }

    if (this.activeTool === "ink" || this.activeTool === "line" || this.activeTool === "arrow") {
      const pts: [number, number][] = this.activeTool === "ink"
        ? [...this.inkPts, [e.offsetX, e.offsetY]]
        : [[this.startX, this.startY], [e.offsetX, e.offsetY]];
      this.inkPts = [];
      const ann = this.makeInk(pts, this.activeTool === "arrow");
      if (ann) this.session.add(ann);
      this.redrawCommitted();
      return;
    }

    if (this.activeTool === "stamp") {
      const [px, py] = this.toPdf(this.startX, this.startY);
      const ann: StampAnnotation = {
        kind: "stamp", page: this.currentPage,
        x: px - STAMP_SIZE / 2, y: py - STAMP_SIZE / 2, width: STAMP_SIZE, height: STAMP_SIZE,
        mark: this.style.stampMark, color: { ...this.style.stampColor },
      };
      this.addInside(ann);
      this.redrawCommitted();
      return;
    }

    if (this.lassoing) {
      const pts: [number, number][] = [...this.inkPts, [e.offsetX, e.offsetY]];
      this.inkPts = [];
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      if (pts.length > 2 && Math.max(...xs) - Math.min(...xs) >= 4 && Math.max(...ys) - Math.min(...ys) >= 4) {
        const ann: RedactAnnotation = { kind: "redact", page: this.currentPage, x: 0, y: 0, width: 1, height: 1, shape: "lasso" };
        this.setOutline(ann, pts.map(([cx, cy]) => this.toPdf(cx, cy) as [number, number]));
        this.session.add(ann);
      }
      this.redrawCommitted();
      return;
    }

    if (this.activeTool === "note") {
      this.redrawCommitted();
      // A click sticks a note of the default size; a drag sets its size.
      // Text longer than the note scrolls inside it.
      const dragged = Math.abs(e.offsetX - this.startX) >= 12 && Math.abs(e.offsetY - this.startY) >= 12;
      const [ax, ay] = this.toPdf(this.startX, this.startY);
      const [bx, by] = dragged ? this.toPdf(e.offsetX, e.offsetY) : [ax + NOTE_W, ay - NOTE_H];
      const ann: NoteAnnotation = {
        kind: "note", page: this.currentPage,
        x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay),
        content: "", color: { ...this.style.noteColor },
      };
      this.addInside(ann);
      this.editNote(ann, true);
      return;
    }

    const x0 = Math.min(this.startX, e.offsetX);
    const y0 = Math.min(this.startY, e.offsetY);
    const w  = Math.abs(e.offsetX - this.startX);
    const h  = Math.abs(e.offsetY - this.startY);
    if (this.activeTool === "text") {
      this.redrawCommitted();
      const isDrag = w >= 8;
      if (isDrag) {
        this.openTextInput(x0, y0, w);
      } else {
        this.openTextInput(
          this.startX,
          this.startY - this.style.fontSize * this.scale,
          0
        );
      }
      return;
    }

    if (w < 4 || h < 4) { this.redrawCommitted(); return; }

    const [p1x, p1y] = this.toPdf(x0,     y0    );
    const [p2x, p2y] = this.toPdf(x0 + w, y0 + h);
    const px = Math.min(p1x, p2x), py = Math.min(p1y, p2y);
    const pw = Math.abs(p2x - p1x), ph = Math.abs(p2y - p1y);

    if (this.activeTool === "rect") {
      const ann: RectAnnotation = {
        kind: "rect", page: this.currentPage,
        x: px, y: py, width: pw, height: ph,
        color: { ...this.style.shapeColor }, strokeWidth: this.style.strokeWidth,
        fillColor: this.style.fillColor ? { ...this.style.fillColor } : null,
        opacity: this.style.opacity,
      };
      this.session.add(ann);
      this.redrawCommitted();
    } else if (this.activeTool === "redact") {
      const shape = this.style.redactShape;
      const ann: RedactAnnotation = {
        kind: "redact", page: this.currentPage,
        x: px, y: py, width: pw, height: ph,
        ...(shape === "rect" ? {} : { shape }),
        // A stretchable area starts as the rectangle drawn; drag its corners.
        ...(shape === "poly" ? { points: [[0, 1], [1, 1], [1, 0], [0, 0]] as [number, number][] } : {}),
      };
      this.session.add(ann);
      this.redrawCommitted();
    } else if (this.activeTool === "circle") {
      const ann: CircleAnnotation = {
        kind: "circle", page: this.currentPage,
        x: px, y: py, width: pw, height: ph,
        color: { ...this.style.shapeColor }, strokeWidth: this.style.strokeWidth,
        fillColor: this.style.fillColor ? { ...this.style.fillColor } : null,
        opacity: this.style.opacity,
      };
      this.session.add(ann);
      this.redrawCommitted();
    }
  };

  // ── Move / resize / corner drag: followed anywhere on screen ────────────────

  private track(): void {
    if (this.tracking) return;
    this.tracking = true;
    window.addEventListener("mousemove", this.onGestureMove, true);
    window.addEventListener("mouseup", this.onGestureUp, true);
  }

  private untrack(): void {
    if (!this.tracking) return;
    this.tracking = false;
    window.removeEventListener("mousemove", this.onGestureMove, true);
    window.removeEventListener("mouseup", this.onGestureUp, true);
  }

  /** The pointer in this canvas's pixels (it may be outside the page). */
  private canvasPoint(e: MouseEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /**
   * `p` held within one page size around the page: an annotation may be
   * stretched past the edge (the page cuts it off), not without end.
   */
  private clampNearPage([x, y]: [number, number]): [number, number] {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    return [Math.min(Math.max(x, -w), 2 * w), Math.min(Math.max(y, -h), 2 * h)];
  }

  /** Moves `ann` by (dx, dy) canvas pixels. */
  private shiftBy(ann: Annotation, dx: number, dy: number): void {
    if (!dx && !dy) return;
    const [x0, y0] = this.toPdf(0, 0);
    const [x1, y1] = this.toPdf(dx, dy);
    ann.x += x1 - x0;
    ann.y += y1 - y0;
  }

  /** Shifts `ann` back inside the page, keeping its size (top left first when it is bigger). */
  private keepInside(ann: Annotation): void {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (w <= 0 || h <= 0) return;
    const b = this.getAnnBounds(ann);
    const fit = (lo: number, hi: number, size: number): number =>
      lo < 0 || hi - lo >= size ? -lo : hi > size ? size - hi : 0;
    this.shiftBy(ann, fit(b.left, b.right, w), fit(b.top, b.bottom, h));
  }

  /**
   * Shifts `ann` just enough that some of it stays on the page (REACHABLE
   * pixels each way, or all of it when smaller): it may hang off the edge,
   * where the page cuts it off, but can't be lost off the page.
   */
  private keepReachable(ann: Annotation): void {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (w <= 0 || h <= 0) return;
    const b = this.getAnnBounds(ann);
    const fit = (lo: number, hi: number, size: number): number => {
      const m = Math.min(REACHABLE, hi - lo, size);
      return hi < m ? m - hi : lo > size - m ? size - m - lo : 0;
    };
    this.shiftBy(ann, fit(b.left, b.right, w), fit(b.top, b.bottom, h));
  }

  /** Adds an annotation placed by a click, kept inside the page. */
  private addInside(ann: Annotation): void {
    this.keepInside(ann);
    this.session.add(ann);
  }

  /** Text that replaces words of the page stays with them; anything else can go to another page. */
  private static canChangePage(ann: Annotation): boolean {
    return !(ann.kind === "text" && ann.cover);
  }

  /** The page overlay under the pointer, if any. */
  private static overlayAt(e: MouseEvent): CanvasOverlay | null {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const wrap = el?.closest?.(".page-wrapper") as HTMLElement | null;
    return wrap ? CanvasOverlay.byContainer.get(wrap) ?? null : null;
  }

  private onGestureMove = (e: MouseEvent): void => {
    if (this.vertexDrag) {
      this.notifyChangeOnce();
      const { ann, index, pts } = this.vertexDrag;
      pts[index] = this.toPdf(...this.clampNearPage(this.canvasPoint(e))) as [number, number];
      this.setOutline(ann, pts);
      this.session.settle();
      this.redrawCommitted();
      return;
    }
    if (this.resizing && this.dragTarget) {
      this.notifyChangeOnce();
      this.applyResize(...this.clampNearPage(this.canvasPoint(e)));
      this.session.settle();
      this.redrawCommitted();
      return;
    }
    if (this.dragging && this.dragTarget) {
      this.notifyChangeOnce();
      const other = CanvasOverlay.overlayAt(e);
      if (other && other !== this && other.shown && CanvasOverlay.canChangePage(this.dragTarget)) {
        other.adoptDrag(this, this.dragTarget, e);
        return;
      }
      const [curPdfX, curPdfY] = this.toPdf(...this.canvasPoint(e));
      this.dragTarget.x = this.dragBaseX + (curPdfX - this.dragStartPdfX);
      this.dragTarget.y = this.dragBaseY + (curPdfY - this.dragStartPdfY);
      this.keepReachable(this.dragTarget);
      this.session.settle();
      this.redrawCommitted();
    }
  };

  private onGestureUp = (): void => {
    this.untrack();
    if (this.vertexDrag) {
      if (this.changeNotified) this.session.edited();
      this.vertexDrag = null;
      return;
    }
    if (this.resizing && this.dragTarget) {
      this.session.edited();
      this.resizing     = false;
      this.resizeHandle = null;
      this.dragTarget   = null;
      this.canvas.style.cursor = "default";
      return;
    }
    if (this.dragging && this.dragTarget) {
      const moved = this.dragTarget.x !== this.dragOrigX || this.dragTarget.y !== this.dragOrigY;
      if (moved) this.session.edited();
      this.dragging   = false;
      this.dragTarget = null;
      this.canvas.style.cursor = "grab";
    }
  };

  /**
   * A drag from page `from` reached this page: `ann` moves here, under the
   * pointer at the same grab point, and this page carries on the drag.
   */
  private adoptDrag(from: CanvasOverlay, ann: Annotation, e: MouseEvent): void {
    const offX = from.dragOffsetX, offY = from.dragOffsetY;
    from.untrack();
    from.dragging = false;
    from.dragTarget = null;
    from.canvas.style.cursor = "default";

    this.session.relocate(ann, this.currentPage);
    const [cx, cy] = this.canvasPoint(e);
    const b = this.getAnnBounds(ann);
    this.shiftBy(ann, cx - offX - b.left, cy - offY - b.top);
    this.keepReachable(ann);
    this.session.settle();

    this.selected = ann; // the other page stops drawing it as selected
    this.changeNotified = true;
    this.dragging = true;
    this.dragTarget = ann;
    // Never equal: the drop counts as a change even back at the same spot.
    this.dragOrigX = Number.NaN;
    this.dragOrigY = Number.NaN;
    this.dragBaseX = ann.x;
    this.dragBaseY = ann.y;
    this.dragOffsetX = offX;
    this.dragOffsetY = offY;
    [this.dragStartPdfX, this.dragStartPdfY] = this.toPdf(cx, cy);
    this.canvas.style.cursor = "grabbing";
    this.track();
    from.redrawCommitted();
    this.redrawCommitted();
    this.emitTextSelected(ann.kind === "text" ? ann : null);
    this.emitShapeSelected((ann.kind === "rect" || ann.kind === "circle" || ann.kind === "ink") ? ann : null);
  }

  private onMouseLeave = (): void => {
    // A move or resize carries on outside the page (see onGestureMove).
    if (this.isDrawing) {
      this.isDrawing = false;
      this.inkPts = [];
      this.redrawCommitted();
    }
  };

  /** Turns canvas points into a stroke whose points are relative to its box. */
  private makeInk(canvasPts: [number, number][], arrow: boolean): InkAnnotation | null {
    if (canvasPts.length < 2) return null;
    const lenPx = canvasPts.slice(1).reduce((acc, p, i) => acc + Math.hypot(p[0] - canvasPts[i][0], p[1] - canvasPts[i][1]), 0);
    if (lenPx < 4) return null;
    const pdf = canvasPts.map(([cx, cy]) => this.toPdf(cx, cy));
    const xs = pdf.map(p => p[0]), ys = pdf.map(p => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    // A flat line still gets a box of 1 pt so its points stay well defined.
    const w = Math.max(maxX - minX, 1), h = Math.max(maxY - minY, 1);
    const x0 = (minX + maxX) / 2 - w / 2, y0 = (minY + maxY) / 2 - h / 2;
    const round = (n: number) => Math.round(n * 10000) / 10000;
    return {
      kind: "ink", page: this.currentPage,
      x: x0, y: y0, width: w, height: h,
      points: pdf.map(([x, y]) => [round((x - x0) / w), round((y - y0) / h)]),
      color: { ...this.style.shapeColor },
      strokeWidth: this.style.strokeWidth,
      fillColor: !arrow && this.activeTool === "ink" && this.style.fillColor ? { ...this.style.fillColor } : null,
      opacity: this.style.opacity,
      ...(arrow ? { arrow: true } : {}),
    };
  }

  // ── Highlighter ──────────────────────────────────────────────────────────────

  /**
   * Highlights the text under `rects` (canvas px, one per selected span).
   * Highlighting text that is already highlighted removes that highlight.
   */
  applyHighlight(rects: { left: number; top: number; right: number; bottom: number }[], color: RgbColor, opacity: number): void {
    const pdfRects = rects
      .filter(r => r.right - r.left > 0.5 && r.bottom - r.top > 0.5)
      .map(r => {
        const [x1, y1] = this.toPdf(r.left, r.bottom);
        const [x2, y2] = this.toPdf(r.right, r.top);
        return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
      });
    if (pdfRects.length === 0) return;

    const area = (r: { width: number; height: number }) => r.width * r.height;
    const overlap = (a: typeof pdfRects[number], b: typeof pdfRects[number]) =>
      Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
      Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    const total = pdfRects.reduce((acc, r) => acc + area(r), 0);
    const existing = this.committed.filter((a): a is HighlightAnnotation => a.kind === "highlight");
    const touched = existing.filter(h => h.rects.some(hr => pdfRects.some(r => overlap(hr, r) > 0)));
    const covered = pdfRects.reduce((acc, r) =>
      acc + Math.min(area(r), touched.reduce((s2, h) => s2 + h.rects.reduce((s3, hr) => s3 + overlap(hr, r), 0), 0)), 0);

    if (touched.length > 0 && covered >= total * 0.6) {
      // Already highlighted: highlighting it again takes the highlight off.
      this.session.change(() => {
        for (const h of touched) this.session.remove(h);
      });
      this.redrawCommitted();
      return;
    }

    const xs = pdfRects.flatMap(r => [r.x, r.x + r.width]);
    const ys = pdfRects.flatMap(r => [r.y, r.y + r.height]);
    const ann: HighlightAnnotation = {
      kind: "highlight", page: this.currentPage,
      x: Math.min(...xs), y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys),
      rects: pdfRects, color: { ...color }, opacity,
    };
    this.session.add(ann);
    this.redrawCommitted();
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // Don't intercept keys while the user is typing in a form field
    const tag = (document.activeElement as HTMLElement)?.tagName ?? "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
        (document.activeElement as HTMLElement)?.isContentEditable) return;
    if ((e.key === "Delete" || e.key === "Backspace") &&
        this.selected && this.activeTool === "select") {
      const removed = this.selected;
      this.selected = null;
      this.session.remove(removed);
      this.redrawCommitted();
    }
  };

  // ── Text placement ───────────────────────────────────────────────────────────

  /**
   * @param left    canvas-px left edge of the text box
   * @param top     canvas-px top edge of the text box
   * @param widthPx drawn width in canvas-px; 0 = auto (default size)
   */
  private openTextInput(left: number, top: number, widthPx: number): void {
    const container = this.container;
    const fontSize  = this.style.fontSize * this.scale;
    const hasWidth  = widthPx > 0;

    const input = document.createElement("div");
    input.contentEditable = "true";
    input.style.cssText = `
      position: absolute;
      left: ${left}px; top: ${top}px;
      ${hasWidth ? `width: ${widthPx}px;` : "min-width: 120px;"}
      font-size: ${fontSize}px; line-height: 1.2; font-family: ${fontCss(this.style.fontFamily)};
      font-weight: ${this.style.bold ? "bold" : "300"};
      font-style: ${this.style.italic ? "italic" : "normal"};
      text-decoration: ${this.style.underline ? "underline" : "none"};
      text-align: ${this.style.alignment};
      color: ${rgbToCss(this.style.color)};
      outline: 1px dashed #aaa; background: ${this.style.textBackground ? rgbToCss(this.style.textBackground) : "rgba(0,0,0,0.08)"};
      padding: 2px 4px; white-space: pre-wrap; z-index: 20;
    `;

    const cleanup = (): void => {
      const scrollEl = document.getElementById("viewer-scroll");
      const savedScroll = scrollEl?.scrollTop ?? 0;
      const lock = () => { scrollEl!.scrollTop = savedScroll; };
      if (scrollEl) scrollEl.addEventListener("scroll", lock);
      input.remove();
      document.removeEventListener("mousedown", outsideClick, true);
      if (scrollEl) {
        scrollEl.scrollTop = savedScroll;
        setTimeout(() => { scrollEl.removeEventListener("scroll", lock); scrollEl.scrollTop = savedScroll; }, 300);
      }
    };

    const commit = (): void => {
      if (!input.isConnected) return;
      const content = (input.innerText ?? input.textContent ?? "").trim();
      cleanup();
      if (content) {
        // baseline = top of box + top padding (2px) + font size
        const baselineCanvasY = top + 2 + fontSize;
        const [pdfX, pdfY] = this.toPdf(left, baselineCanvasY);
        const annWidth = hasWidth
          ? widthPx / this.scale
          : this.fitTextWidth(content, this.style);
        const ann: TextAnnotation = {
          kind: "text", page: this.currentPage,
          x: pdfX, y: pdfY,
          width: annWidth,
          content,
          color: { ...this.style.color },
          fontSize: this.style.fontSize,
          bold: this.style.bold, italic: this.style.italic, underline: this.style.underline,
          alignment: this.style.alignment,
          fontFamily: this.style.fontFamily,
          backgroundColor: this.style.textBackground ? { ...this.style.textBackground } : null,
        };
        this.addInside(ann);
        this.redrawCommitted();
      }
    };

    const outsideClick = (ev: MouseEvent): void => {
      if (input.contains(ev.target as Node)) return;
      endsEditOnly(ev);
      commit();
    };

    input.addEventListener("keydown", (ev: KeyboardEvent) => {
      // Enter / Escape belong to the text box, not to the ✓ / ✕ shortcuts.
      if (ev.key === "Enter" || ev.key === "Escape") ev.stopPropagation();
      if (ev.key === "Escape") { cleanup(); }
      // Enter places the text; Shift+Enter starts a new line.
      else if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); commit(); }
    });

    container.appendChild(input);
    input.focus();
    setTimeout(() => document.addEventListener("mousedown", outsideClick, true), 0);
  }

  // ── Double-click edit ─────────────────────────────────────────────────────────

  private onDblClick = (e: MouseEvent): void => {
    if (this.activeTool !== "select") return;
    const hit = this.hitTest(e.offsetX, e.offsetY);
    if (!hit) return;
    e.preventDefault();
    if (hit.kind === "text") this.handleTextEdit(hit);
    else if (hit.kind === "note") this.editNote(hit);

  };

  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault(); // suppress browser context menu
  };

  /** Moves `ann` one layer up or down among this page's annotations. */
  reorderAnnotation(ann: Annotation, dir: "up" | "down"): void {
    if (this.session.moveLayer(ann, dir === "up" ? 1 : -1)) this.redrawCommitted();
  }

  private handleTextEdit(ann: TextAnnotation): void {
    const container = this.container;
    const { scale } = this;
    const [canvasX, canvasY] = this.toCanvas(ann.x, ann.y); // baseline
    // boxTop = baseline - 2px padding - fontSize (mirrors openTextInput commit logic)
    const boxTop = canvasY - 2 - ann.fontSize * scale;
    const boxW   = ann.width * scale;

    // Hide the canvas rendering while the edit div is visible
    this.editingAnn = ann;
    this.selected = null;
    this.redrawCommitted();

    const input = document.createElement("div");
    input.contentEditable = "true";
    input.textContent = ann.content;
    input.style.cssText = `
      position: absolute;
      left: ${canvasX}px; top: ${boxTop}px;
      width: ${boxW}px;
      font-size: ${ann.fontSize * scale}px; line-height: 1.2; font-family: ${fontCss(ann.fontFamily)};
      font-weight: ${ann.bold ? "bold" : "300"};
      font-style: ${ann.italic ? "italic" : "normal"};
      text-decoration: ${ann.underline ? "underline" : "none"};
      text-align: ${ann.alignment};
      color: ${rgbToCss(ann.color)};
      outline: 1px dashed #aaa; background: transparent;
      padding: 2px 4px; white-space: pre-wrap; z-index: 10;
    `;
    const finish = (): void => {
      this.editingAnn = null;
      const scrollEl = document.getElementById("viewer-scroll");
      const savedScroll = scrollEl?.scrollTop ?? 0;
      const lock = () => { scrollEl!.scrollTop = savedScroll; };
      if (scrollEl) scrollEl.addEventListener("scroll", lock);
      input.remove();
      document.removeEventListener("mousedown", outsideClick, true);
      if (scrollEl) {
        scrollEl.scrollTop = savedScroll;
        setTimeout(() => { scrollEl.removeEventListener("scroll", lock); scrollEl.scrollTop = savedScroll; }, 300);
      }
    };
    const commit = (): void => {
      if (!input.isConnected) return;
      const content = (input.innerText ?? input.textContent ?? "").trim();
      finish();
      if (content && content !== ann.content) {
        this.session.beginEdit();
        ann.content = content;
        // Text placed with a click grows with what is typed.
        ann.width = Math.max(ann.width, this.fitTextWidth(content, { ...ann, fontFamily: ann.fontFamily ?? "helvetica" }));
        this.session.edited();
      }
      this.redrawCommitted();
    };
    const outsideClick = (ev: MouseEvent): void => {
      if (input.contains(ev.target as Node)) return;
      endsEditOnly(ev);
      commit();
    };
    input.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.key === "Enter" || ev.key === "Escape") ev.stopPropagation();
      if (ev.key === "Escape") {
        finish();
        this.redrawCommitted();
      } else if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        commit();
      }
    });
    container.appendChild(input);
    input.focus();
    const range = document.createRange();
    range.selectNodeContents(input);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    setTimeout(() => document.addEventListener("mousedown", outsideClick, true), 0);
  }

  /** Width (pt) that fits every line on screen and in the saved PDF. */
  private fitTextWidth(content: string, st: Pick<TextAnnotation, "fontSize" | "bold" | "italic"> & { fontFamily: string }): number {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = `${st.italic ? "italic" : "normal"} ${st.bold ? "bold" : "300"} ${st.fontSize}px ${fontCss(st.fontFamily as TextAnnotation["fontFamily"])}`;
    const lines = content.split("\n");
    const measured = Math.max(...lines.map(l => ctx.measureText(l).width));
    ctx.restore();
    const longest = Math.max(...lines.map(l => new TextEncoder().encode(l).length));
    return Math.max(measured + 4, longest * st.fontSize * (PDF_CHAR_W[st.fontFamily] ?? 0.5) + 1);
  }

  /** Lets the user type in a sticky note, right on the page. */
  private editNote(ann: NoteAnnotation, fresh = false): void {
    const { scale } = this;
    const b = this.boxOf(ann);
    this.editingAnn = ann;
    this.selected = null;
    this.redrawCommitted();

    // The note itself is the writing surface: the same paper as drawn on
    // the page, typed on directly.
    const darker = { r: ann.color.r * 0.8, g: ann.color.g * 0.8, b: ann.color.b * 0.8 };
    const area = document.createElement("textarea");
    area.className = "note-editor";
    area.value = ann.content;
    area.spellcheck = false;
    area.style.cssText = `
      position: absolute; left: ${b.l}px; top: ${b.t}px; width: ${b.w}px; height: ${b.h}px;
      box-sizing: border-box; padding: ${NOTE_PAD * scale}px; margin: 0; resize: none;
      border: ${0.75 * scale}px solid ${rgbToCss(darker)}; border-radius: 0; outline: none;
      background: ${rgbToCss(ann.color)}; box-shadow: 0 2px 6px rgba(0,0,0,0.18); color: #262626;
      font: ${NOTE_FONT * scale}px/1.2 ${fontCss("helvetica")}; z-index: 20;
      overflow-x: hidden; overflow-y: auto; overflow-wrap: break-word;
    `;
    const done = (keep: boolean): void => {
      if (!area.isConnected) return;
      document.removeEventListener("mousedown", outside, true);
      noteScroll.set(ann, area.scrollTop / scale);
      area.remove();
      this.editingAnn = null;
      if (keep && area.value !== ann.content) {
        this.session.beginEdit();
        ann.content = area.value.replace(/\s+$/, "");
        this.session.edited();
      }
      this.redrawCommitted();
      // A new note stays (even empty) and is selected, ready to move or
      // resize; a double click writes in it again.
      if (fresh) this.pickHandlers.forEach(h => h(ann));
    };
    const outside = (ev: MouseEvent): void => {
      if (ev.target === area) return;
      endsEditOnly(ev);
      done(true);
    };
    area.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Escape") done(false);
      else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) done(true);
    });
    this.container.appendChild(area);
    area.scrollTop = (noteScroll.get(ann) ?? 0) * scale;
    area.focus({ preventScroll: true });
    setTimeout(() => document.addEventListener("mousedown", outside, true), 0);
  }

  /** The wheel over a note whose text overflows scrolls the text, not the page (until it ends). */
  private onWheel = (e: WheelEvent): void => {
    if (e.ctrlKey || e.metaKey || e.deltaY === 0 || !this.shown) return;
    const [cx, cy] = this.canvasPoint(e);
    const hit = this.hitTest(cx, cy);
    if (hit?.kind !== "note" || hit === this.editingAnn) return;
    const max = noteMaxScroll(hit);
    if (max <= 0) return;
    const px = e.deltaMode === 1 ? e.deltaY * NOTE_FONT * 1.2 * this.scale : e.deltaMode === 2 ? e.deltaY * hit.height * this.scale : e.deltaY;
    const cur = Math.min(noteScroll.get(hit) ?? 0, max);
    const next = Math.min(max, Math.max(0, cur + px / this.scale));
    if (next === cur) return; // at the end: the page scrolls on
    e.preventDefault();
    noteScroll.set(hit, next);
    this.redrawCommitted();
  };

  private handleTextStyleEdit(ann: TextAnnotation): void {
    this.selected = ann;
    this.redrawCommitted();
    this.emitTextSelected(ann);
  }

  /** Places a picture centred on the given canvas point and selects it. */
  placeImage(canvasX: number, canvasY: number, imageData: string, widthPt: number, heightPt: number): ImageAnnotation {
    const [pdfX, pdfY] = this.toPdf(canvasX, canvasY);
    const ann: ImageAnnotation = {
      kind: "image", page: this.currentPage,
      x: pdfX - widthPt / 2, y: pdfY - heightPt / 2,
      width: widthPt, height: heightPt, imageData,
    };
    this.addInside(ann);
    this.selected = ann;
    this.redrawCommitted();
    return ann;
  }

  /** Size of the page in PDF points, as shown (rotation included). */
  get pageSizePt(): { width: number; height: number } {
    const r = this.canvas.getBoundingClientRect();
    return { width: r.width / this.scale, height: r.height / this.scale };
  }

  // ── Redact text ─────────────────────────────────────────────────────────────

  /**
   * Marks the text under `rects` (canvas px, one per selected line) for
   * redaction. Selecting text that is already marked takes the mark off.
   */
  applyRedactText(rects: { left: number; top: number; right: number; bottom: number }[]): void {
    const pdfRects = rects
      .filter(r => r.right - r.left > 0.5 && r.bottom - r.top > 0.5)
      .map(r => {
        const [x1, y1] = this.toPdf(r.left - 1, r.bottom + 1);
        const [x2, y2] = this.toPdf(r.right + 1, r.top - 1);
        return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
      });
    if (pdfRects.length === 0) return;
    const area = (r: { width: number; height: number }) => r.width * r.height;
    const overlap = (a: typeof pdfRects[number], b: typeof pdfRects[number]) =>
      Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
      Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    const marked = this.committed.filter((a): a is RedactAnnotation => a.kind === "redact" && (a.shape ?? "rect") === "rect");
    const touched = marked.filter(m => pdfRects.some(r => overlap(m, r) > 0));
    const total = pdfRects.reduce((acc, r) => acc + area(r), 0);
    const covered = pdfRects.reduce((acc, r) => acc + Math.min(area(r), touched.reduce((s2, m) => s2 + overlap(m, r), 0)), 0);

    if (touched.length > 0 && covered >= total * 0.6) {
      this.session.change(() => {
        for (const m of touched) this.session.remove(m);
      });
      this.redrawCommitted();
      return;
    }
    this.session.change(() => {
      for (const r of pdfRects) this.session.add({ kind: "redact", page: this.currentPage, ...r });
    });
    this.redrawCommitted();
  }

  // ── Edit text ───────────────────────────────────────────────────────────────

  /** Opens text already added (or replaced) at the screen point for editing. */
  editTextAt(clientX: number, clientY: number): boolean {
    const r = this.canvas.getBoundingClientRect();
    const hit = this.hitTest(clientX - r.left, clientY - r.top);
    if (hit?.kind !== "text") return false;
    this.handleTextEdit(hit);
    return true;
  }

  /**
   * Opens a box over existing text of the page to type its replacement.
   * The result is text drawn over a patch of the page's own colour.
   */
  replaceText(item: PageTextItem): void {
    const st = this.style;
    const fs = st.fontSize * this.scale;
    const [bx, by] = this.toCanvas(item.x, item.y); // baseline start
    // Area of the original words: descent below the baseline, ascent above.
    const cover = {
      x: item.x - 1, y: item.y - item.fontSize * 0.28,
      width: item.width + 2, height: item.fontSize * 1.18,
      color: { ...item.background },
    };
    const c = this.boxOf(cover);

    const input = document.createElement("div");
    input.contentEditable = "true";
    input.className = "etext-input";
    input.textContent = item.text;
    input.style.cssText = `
      position: absolute; left: ${bx - 4}px; top: ${by - fs - 2}px; min-width: ${c.w + 8}px;
      font-size: ${fs}px; line-height: 1.2; font-family: ${fontCss(st.fontFamily)};
      font-weight: ${st.bold ? "bold" : "300"}; font-style: ${st.italic ? "italic" : "normal"};
      text-decoration: ${st.underline ? "underline" : "none"};
      color: ${rgbToCss(st.color)}; background: ${rgbToCss(item.background)};
      outline: 1.5px dashed #E53935; padding: 2px 4px; white-space: pre; z-index: 20;
    `;
    const patch = document.createElement("div");
    patch.style.cssText = `position: absolute; left: ${c.l}px; top: ${c.t}px; width: ${c.w}px; height: ${c.h}px;
      background: ${rgbToCss(item.background)}; z-index: 19; pointer-events: none;`;

    const close = (): void => {
      input.remove();
      patch.remove();
      document.removeEventListener("mousedown", outside, true);
    };
    const commit = (): void => {
      if (!input.isConnected) return;
      const content = (input.innerText ?? input.textContent ?? "").replace(/\s+$/, "");
      close();
      if (content === item.text) return;
      const s2 = this.style;
      const ann: TextAnnotation = {
        kind: "text", page: this.currentPage,
        x: item.x, y: item.y,
        width: Math.max(1, this.fitTextWidth(content || " ", s2)),
        content: content || " ",
        color: { ...s2.color }, fontSize: s2.fontSize,
        bold: s2.bold, italic: s2.italic, underline: s2.underline,
        alignment: "left", fontFamily: s2.fontFamily, backgroundColor: null,
        cover,
      };
      this.session.add(ann);
      this.selected = ann;
      this.redrawCommitted();
      this.emitTextSelected(ann);
    };
    const outside = (ev: MouseEvent): void => {
      if (input.contains(ev.target as Node)) return;
      // Clicking other text of the page moves on to that text.
      commit();
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Escape") { ev.preventDefault(); close(); }
      else if (ev.key === "Enter") { ev.preventDefault(); commit(); }
    });
    this.container.append(patch, input);
    input.focus();
    const range = document.createRange();
    range.selectNodeContents(input);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    setTimeout(() => document.addEventListener("mousedown", outside, true), 0);
  }

  /** Place a signature image centred on the given canvas coordinates. */
  placeSignature(
    canvasX: number, canvasY: number, imageData: string, widthPt: number, heightPt: number, vector?: InkVector,
  ): SignatureAnnotation {
    const [pdfX, pdfY] = this.toPdf(canvasX, canvasY);
    const ann: SignatureAnnotation = {
      kind: "signature", page: this.currentPage,
      x: pdfX - widthPt / 2, y: pdfY - heightPt / 2,
      width: widthPt, height: heightPt, imageData,
      ...(vector ? { vector } : {}),
    };
    this.addInside(ann);
    this.selected = ann;
    this.redrawCommitted();
    return ann;
  }
}
