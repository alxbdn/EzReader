import { OverlayEvents } from "./overlay-events";
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
  HIGHLIGHT_PRESETS,
} from "./models";
import { ICON_CHECK, ICON_CHEVRON_DOWN, ICON_COPY, ICON_TRASH } from "./icons";
import { textUnder, type Box } from "./highlight-text";
import { drawVector } from "./signature-ink";
import type { AnnotationSession } from "./annotation-session";
import type { SelectionOwner, ToolSelection } from "./tool-selection";

export type ShapeAnnotation = RectAnnotation | CircleAnnotation | InkAnnotation;

const NOTE_W = 150;
const NOTE_H = 100;
/** How far, in points, each pasted or duplicated annotation moves from the one before. */
const COPY_NUDGE_PT = 12;
const NOTE_FONT = 10;
const NOTE_PAD = 6;
const noteScroll = new WeakMap<NoteAnnotation, number>();
const noteTextHeight = new WeakMap<NoteAnnotation, number>();

function noteMaxScroll(ann: NoteAnnotation): number {
  return Math.max(0, (noteTextHeight.get(ann) ?? 0) - (ann.height - 2 * NOTE_PAD));
}

const STAMP_SIZE = 22;

const REACHABLE = 24;
const KEEPS_RATIO = new Set<Annotation["kind"]>(["signature", "image", "stamp"]);

const pictures = new Map<string, HTMLImageElement>();

export function pictureSrc(b64: string): string {
  return `data:image/${b64.startsWith("/9j/") ? "jpeg" : "png"};base64,${b64}`;
}

export interface PageTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  family: FontFamilyValue;
  background: RgbColor;
}

const PDF_CHAR_W: Record<string, number> = { helvetica: 0.5, times: 0.45, courier: 0.6 };

interface PdfViewport {
  convertToViewportPoint(pdfX: number, pdfY: number): number[];
  convertToPdfPoint(viewX: number, viewY: number): number[];
  rotation: number;
}

type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const HANDLE_R = 4;
const SELECT = "#E53935";
const HANDLE_HIT = 7;
const HANDLE_CURSORS: Record<ResizeHandle, string> = {
  nw: "nw-resize", n: "n-resize",  ne: "ne-resize",
  e:  "e-resize",  se: "se-resize", s:  "s-resize",
  sw: "sw-resize", w:  "w-resize",
};
const MIN_SIZE_PT = 10;

function endsEditOnly(ev: MouseEvent): void {
  if ((ev.target as Element | null)?.classList?.contains("page-annotation-canvas")) ev.stopPropagation();
}

export class CanvasOverlay implements SelectionOwner {
  private canvas: HTMLCanvasElement;
  private container: HTMLElement;
  private ctx: CanvasRenderingContext2D;
  private hctx: CanvasRenderingContext2D | null;

  private get style(): ActiveToolState { return this.tools.state; }
  private activeTool: ToolKind = "select";
  private editingAnn: Annotation | null = null;

  private isDrawing = false;
  private startX = 0;
  private startY = 0;
  private inkPts: [number, number][] = [];

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
  private resizeAnchorX = 0;
  private resizeAnchorY = 0;
  private dragTarget: Annotation | null = null;
  private dragOrigX = 0;
  private dragOrigY = 0;
  private dragOrigW = 0;
  private dragOrigH = 0;
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private dragStartPdfX = 0;
  private dragStartPdfY = 0;
  private dragBaseX = 0;
  private dragBaseY = 0;
  private tracking = false;
  private static readonly byContainer = new WeakMap<HTMLElement, CanvasOverlay>();
  private changeNotified = true;
  private vertexDrag: { ann: RedactAnnotation; index: number; pts: [number, number][] } | null = null;

  private currentPage = 1;
  private pageHeightPt = 841;
  private scale = 1.5;
  private viewport: PdfViewport | null = null;
  private viewportRotation = 0;

  private readonly stopKeys: () => void;
  private hlPopover: HTMLElement | null = null;
  private containerDownPos: { x: number; y: number } | null = null;

  onHoverCursor: ((offsetX: number, offsetY: number) => string) | null = null;

  private shown = false;

  private get committed(): readonly Annotation[] {
    return this.shown ? this.session.forPage(this.currentPage) : [];
  }

  constructor(
    canvas: HTMLCanvasElement,
    container: HTMLElement,
    private readonly tools: ToolSelection,
    private readonly session: AnnotationSession,
    private readonly highlightCanvas: HTMLCanvasElement | null = null,
    private readonly events: OverlayEvents = new OverlayEvents(),
  ) {
    this.canvas = canvas;
    this.container = container;
    this.ctx = this.canvas.getContext("2d")!;
    this.hctx = highlightCanvas?.getContext("2d") ?? null;

    this.canvas.addEventListener("mousedown",    this.onMouseDown);
    this.canvas.addEventListener("mousemove",    this.onMouseMove);
    this.canvas.addEventListener("mouseup",      this.onMouseUp);
    this.canvas.addEventListener("mouseleave",   this.onMouseLeave);
    this.canvas.addEventListener("dblclick",     this.onDblClick);
    this.canvas.addEventListener("contextmenu",  this.onContextMenu);
    this.stopKeys = events.listenForKeys(this.onKeyDown);

    CanvasOverlay.byContainer.set(container, this);
    container.addEventListener("mousemove", this.onContainerMouseMove);
    container.addEventListener("mousedown", this.onContainerMouseDown);
    container.addEventListener("mouseup",   this.onContainerMouseUp);
    container.addEventListener("wheel", this.onWheel, { passive: false });

    this.applyPointerEvents(this.activeTool);
  }

  private notifyChangeOnce(): void {
    if (this.changeNotified) return;
    this.changeNotified = true;
    this.session.beginEdit();
  }
  private emitTextSelected     (a: TextAnnotation | null):      void { this.events.textSelected(a); }
  private emitShapeSelected    (a: ShapeAnnotation | null):     void { this.events.shapeSelected(a); }
  private emitHighlightSelected(a: HighlightAnnotation | null): void { this.events.highlightSelected(a); }

  select(ann: Annotation): void {
    if (!this.committed.includes(ann)) return;
    this.selected = ann;
    this.redrawCommitted();
    this.emitTextSelected(ann.kind === "text" ? ann : null);
    this.emitShapeSelected((ann.kind === "rect" || ann.kind === "circle" || ann.kind === "ink") ? ann : null);
    this.emitHighlightSelected(ann.kind === "highlight" ? ann : null);
  }

  get currentTool(): ToolKind { return this.activeTool; }

  private get lassoing(): boolean { return this.activeTool === "redact" && this.style.redactShape === "lasso"; }

  get screenRect(): DOMRect { return this.canvas.getBoundingClientRect(); }

  applyHighlightAnnotationStyle(
    ann: HighlightAnnotation,
    color: RgbColor,
    opacity: number,
  ): void {
    this.session.beginEdit();
    ann.color = { ...color };
    ann.opacity = opacity;
    this.redrawCommitted();
    this.session.edited();
  }

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

  applyTextAnnotationStyle(
    ann: TextAnnotation,
    style: Pick<ActiveToolState, "color" | "fontSize" | "bold" | "italic" | "underline" | "alignment" | "fontFamily" | "fontName" | "textBackground">
  ): void {
    this.session.beginEdit();
    ann.color     = { ...style.color };
    ann.backgroundColor = style.textBackground ? { ...style.textBackground } : null;
    ann.fontFamily = style.fontFamily;
    if (style.fontName) ann.fontName = style.fontName; else delete ann.fontName;
    ann.fontSize  = style.fontSize;
    ann.bold      = style.bold;
    ann.italic    = style.italic;
    ann.underline = style.underline;
    ann.alignment = style.alignment;
    this.redrawCommitted();
    this.session.edited();
  }

  refreshStyle(): void {
    this.activeTool = this.style.tool;
    this.applyPointerEvents(this.activeTool);
  }

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
    this.canvas.style.pointerEvents = DRAW_TOOLS.includes(tool) ? "auto" : "none";
  }

  destroy(): void {
    this.stopKeys();
  }

  hide(): void {
    this.selected = null;
    this.syncToPage(this.currentPage, 1, 841);
    this.shown = false;
    this.redrawCommitted();
  }

  private toCanvas(pdfX: number, pdfY: number): [number, number] {
    if (this.viewport) {
      const r = this.viewport.convertToViewportPoint(pdfX, pdfY);
      return [r[0], r[1]];
    }
    const c = pdfToCanvas(pdfX, pdfY, this.scale, this.pageHeightPt);
    return [c.x, c.y];
  }

  private toPdf(canvasX: number, canvasY: number): [number, number] {
    if (this.viewport) {
      const r = this.viewport.convertToPdfPoint(canvasX, canvasY);
      return [r[0], r[1]];
    }
    const p = canvasToPdf(canvasX, canvasY, this.scale, this.pageHeightPt);
    return [p.x, p.y];
  }

  syncToPage(page: number, scale: number, pageHeightPt: number, viewport?: PdfViewport): void {
    this.shown        = true;
    this.currentPage  = page;
    this.scale        = scale;
    this.pageHeightPt = pageHeightPt;
    this.viewport         = viewport ?? null;
    this.viewportRotation = viewport?.rotation ?? 0;
    if (this.selected && !this.committed.includes(this.selected)) this.selected = null;
    this.dragging = false;
    this.resizing = false;
    this.dragTarget = null;

    this.redrawCommitted();
    this.applyPointerEvents(this.activeTool);
  }

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
      const [x1, y1] = this.toCanvas(ann.x, ann.y + ann.height);
      const [x2, y2] = this.toCanvas(ann.x + ann.width, ann.y);
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

  private hitHighlight(cx: number, cy: number): HighlightAnnotation | null {
    const P = 3;
    for (let i = this.committed.length - 1; i >= 0; i--) {
      const ann = this.committed[i];
      if (ann.kind !== "highlight") continue;
      for (const r of ann.rects) {
        const [x1, y1] = this.toCanvas(r.x, r.y + r.height);
        const [x2, y2] = this.toCanvas(r.x + r.width, r.y);
        const left = Math.min(x1, x2), right = Math.max(x1, x2);
        const top = Math.min(y1, y2), bottom = Math.max(y1, y2);
        if (cx >= left - P && cx <= right + P && cy >= top - P && cy <= bottom + P) {
          return ann;
        }
      }
    }
    return null;
  }

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
    if (ann.kind === "highlight") return [];
    if (ann.kind === "text") return ["w", "e"];
    if (ann.kind === "redact" && ann.shape === "poly") return [];
    if (KEEPS_RATIO.has(ann.kind)) return ["nw", "ne", "se", "sw"];
    return ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  }

  private outlineOf(ann: RedactAnnotation): [number, number][] {
    return (ann.points ?? []).map(([u, v]) => [ann.x + u * ann.width, ann.y + v * ann.height]);
  }

  private hitVertex(cx: number, cy: number, ann: Annotation): number | null {
    if (ann.kind !== "redact" || ann.shape !== "poly") return null;
    const pts = this.outlineOf(ann);
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = this.toCanvas(pts[i][0], pts[i][1]);
      if (Math.hypot(cx - x, cy - y) <= HANDLE_HIT + 1) return i;
    }
    return null;
  }

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

  private startResize(ann: Annotation, handle: ResizeHandle): void {
    this.resizing      = true;
    this.resizeHandle  = handle;
    this.dragTarget    = ann;
    this.dragOrigX     = ann.x;
    this.dragOrigY     = ann.y;
    this.dragOrigW     = ann.width;
    this.dragOrigH     = ann.kind !== "text" ? ann.height : 0;

    const eh = ann.kind !== "text" ? this.effectiveHandle(handle) : handle;

    const left   = ann.x;
    const right  = ann.x + ann.width;
    const bottom = ann.y;
    const top    = ann.kind !== "text" ? ann.y + ann.height : ann.y;

    if (["e", "ne", "se"].includes(eh)) this.resizeAnchorX = left;
    else if (["w", "nw", "sw"].includes(eh)) this.resizeAnchorX = right;

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
        const k = Math.max(ann.width / this.dragOrigW, ann.height / this.dragOrigH);
        ann.width = this.dragOrigW * k;
        ann.height = this.dragOrigH * k;
        if (h === "w" || h === "nw" || h === "sw") ann.x = this.resizeAnchorX - ann.width;
        if (h === "s" || h === "se" || h === "sw") ann.y = this.resizeAnchorY - ann.height;
      }
    }
  }

  redrawCommitted(): void {
    const dpr = window.devicePixelRatio || 1;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr);
    if (this.hctx && this.highlightCanvas) {
      this.hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.hctx.clearRect(0, 0, this.highlightCanvas.width / dpr, this.highlightCanvas.height / dpr);
    }
    for (const ann of this.committed) {
      if (ann === this.editingAnn) continue;
      this.drawAnnotation(ann);
    }
    if (this.selected && this.committed.includes(this.selected)) {
      this.drawSelectionBox(this.selected);
    }
    this.syncHighlightPopover();
  }

  private drawSelectionBox(ann: Annotation): void {
    const SEL_PAD = ann.kind === "highlight" ? 2 : 5;
    const b = this.getAnnBounds(ann);
    const box = { left: b.left - SEL_PAD, top: b.top - SEL_PAD, right: b.right + SEL_PAD, bottom: b.bottom + SEL_PAD };

    this.ctx.strokeStyle = ann.kind === "highlight" ? "#4f46e5" : SELECT;
    this.ctx.lineWidth   = 1.5;
    this.ctx.setLineDash(ann.kind === "highlight" ? [] : [5, 3]);
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

  private syncHighlightPopover(): void {
    const ann = this.selected?.kind === "highlight" && this.committed.includes(this.selected)
      ? this.selected
      : null;
    if (!ann) {
      if (this.hlPopover) {
        this.hlPopover.remove();
        this.hlPopover = null;
      }
      return;
    }

    if (!this.hlPopover) {
      const pop = document.createElement("div");
      pop.className = "hl-popover";
      pop.addEventListener("mousedown", (ev) => ev.stopPropagation());
      pop.addEventListener("mouseup",   (ev) => ev.stopPropagation());
      pop.addEventListener("click",     (ev) => ev.stopPropagation());
      this.hlPopover = pop;
      this.container.appendChild(pop);
    }

    const pop = this.hlPopover;
    const wasOpen = pop.classList.contains("swatches-open");
    pop.replaceChildren();
    pop.classList.toggle("swatches-open", wasOpen);

    const colorBtn = document.createElement("button");
    colorBtn.type = "button";
    colorBtn.className = "hl-popover-color";
    const dot = document.createElement("span");
    dot.className = "hl-popover-dot";
    dot.style.background = rgbToCss(ann.color);
    const chev = document.createElement("span");
    chev.className = "hl-popover-chev";
    chev.innerHTML = ICON_CHEVRON_DOWN;
    colorBtn.append(dot, chev);
    colorBtn.addEventListener("click", () => {
      pop.classList.toggle("swatches-open");
    });

    const swatches = document.createElement("div");
    swatches.className = "hl-popover-swatches";
    const activeHex = rgbToHex(ann.color).toLowerCase();
    for (const [hex, label] of HIGHLIGHT_PRESETS) {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = `hl-popover-swatch${hex.toLowerCase() === activeHex ? " active" : ""}`;
      sw.style.background = hex;
      sw.title = label;
      sw.addEventListener("click", () => {
        const nextColor = hexToRgb(hex);
        this.style.highlightColor = { ...nextColor };
        this.applyHighlightAnnotationStyle(ann, nextColor, ann.opacity);
        this.emitHighlightSelected(ann);
      });
      swatches.appendChild(sw);
    }

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "hl-popover-copy";
    const copyLabel = document.getElementById("ctx-copy")?.textContent?.trim() || "Copy";
    copyBtn.title = copyLabel;
    copyBtn.setAttribute("aria-label", copyLabel);
    copyBtn.innerHTML = ICON_COPY;
    copyBtn.addEventListener("click", () => void this.copyHighlight(ann, copyBtn));

    const sep = document.createElement("span");
    sep.className = "hl-popover-sep";

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "hl-popover-del";
    delBtn.innerHTML = ICON_TRASH;
    delBtn.addEventListener("click", () => {
      this.selected = null;
      this.session.remove(ann);
      this.redrawCommitted();
      this.emitHighlightSelected(null);
    });

    pop.append(colorBtn, swatches, copyBtn, sep, delBtn);

    const b = this.getAnnBounds(ann);
    const pageW = this.canvas.clientWidth || (this.canvas.width / (window.devicePixelRatio || 1));
    const pageH = this.canvas.clientHeight || (this.canvas.height / (window.devicePixelRatio || 1));
    const top = Math.min(Math.max(4, pageH - 42), b.bottom + 6);
    const rightOffset = Math.max(4, Math.min(pageW - 128, pageW - b.right));
    pop.style.top = `${Math.round(top)}px`;
    pop.style.right = `${Math.round(rightOffset)}px`;
  }

  highlightText(ann: HighlightAnnotation): string {
    const layer = this.container.querySelector<HTMLElement>(".page-text-layer");
    if (!layer) return "";
    const origin = this.canvas.getBoundingClientRect();
    const boxes: Box[] = ann.rects.map((r) => {
      const [x1, y1] = this.toCanvas(r.x, r.y + r.height);
      const [x2, y2] = this.toCanvas(r.x + r.width, r.y);
      return {
        left: origin.left + Math.min(x1, x2),
        right: origin.left + Math.max(x1, x2),
        top: origin.top + Math.min(y1, y2),
        bottom: origin.top + Math.max(y1, y2),
      };
    });
    return textUnder(layer, boxes);
  }

  private async copyHighlight(ann: HighlightAnnotation, btn: HTMLButtonElement): Promise<void> {
    const selected = window.getSelection()?.toString() ?? "";
    const text = selected || this.highlightText(ann);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    btn.innerHTML = ICON_CHECK;
    btn.classList.add("done");
    setTimeout(() => {
      btn.innerHTML = ICON_COPY;
      btn.classList.remove("done");
    }, 1200);
  }

  private textLineCount(ann: TextAnnotation): number {
    const { scale } = this;
    const saved = this.ctx.font;
    this.ctx.font = `${ann.italic ? "italic" : "normal"} ${ann.bold ? "bold" : "300"} ${ann.fontSize * scale}px ${fontCss(ann.fontFamily, ann.fontName)}`;
    const count = this.wrapLines(this.ctx, ann.content, ann.width * scale).length;
    this.ctx.font = saved;
    return count;
  }

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
      const [x1, y1] = this.toCanvas(ann.x, ann.y + ann.height);
      const [x2, y2] = this.toCanvas(ann.x + ann.width, ann.y);
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
      const hc = this.hctx ?? ctx;
      hc.save();
      hc.globalAlpha = ann.opacity;
      hc.globalCompositeOperation = "multiply";
      hc.fillStyle = rgbToCss(ann.color);
      for (const r of ann.rects) {
        const [x1, y1] = this.toCanvas(r.x, r.y + r.height);
        const [x2, y2] = this.toCanvas(r.x + r.width, r.y);
        hc.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      }
      hc.restore();

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
      ctx.font      = `${ann.italic ? "italic" : "normal"} ${ann.bold ? "bold" : "300"} ${ann.fontSize * scale}px ${fontCss(ann.fontFamily, ann.fontName)}`;
      const lineH   = ann.fontSize * scale * 1.2;
      const maxW    = ann.width * scale;
      const lines   = this.wrapLines(ctx, ann.content, maxW);
      if (ann.backgroundColor) {
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
      const v = ann.vector;
      const [x, y] = this.toCanvas(ann.x, ann.y + ann.height);
      const rotRad = (this.viewportRotation * Math.PI) / 180;
      this.ctx.save();
      this.ctx.translate(x, y);
      if (rotRad !== 0) this.ctx.rotate(rotRad);
      this.ctx.scale((ann.width * this.scale) / v.w, (ann.height * this.scale) / v.h);
      drawVector(this.ctx, v, ann.color);
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
    const [x, y] = this.toCanvas(ann.x, ann.y + ann.height);
    const rotRad = (this.viewportRotation * Math.PI) / 180;
    this.ctx.save();
    this.ctx.translate(x, y);
    if (rotRad !== 0) this.ctx.rotate(rotRad);
    this.ctx.drawImage(img, 0, 0, ann.width * this.scale, ann.height * this.scale);
    this.ctx.restore();
  }

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

  private onContainerMouseMove = (e: MouseEvent): void => {
    if (this.activeTool !== "select") return;
    if (this.dragging || this.resizing) return;

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
    if ((e.target as HTMLElement | null)?.closest(".hl-popover")) return;
    this.containerDownPos = { x: e.clientX, y: e.clientY };
    if (this.activeTool !== "select") return;
    if (this.dragging || this.resizing) return;
    if (!this.selected) return;

    const rect = this.canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    const hitAnn = this.hitTest(cx, cy);
    const hitHl  = this.hitHighlight(cx, cy);
    const hitH   = this.hitHandle(cx, cy, this.selected);
    if (!hitAnn && !hitHl && !hitH && this.hitVertex(cx, cy, this.selected) === null) {
      this.selected = null;
      this.redrawCommitted();
      this.emitTextSelected(null);
      this.emitShapeSelected(null);
      this.emitHighlightSelected(null);
    }
  };

  private onContainerMouseUp = (e: MouseEvent): void => {
    const down = this.containerDownPos;
    this.containerDownPos = null;
    if ((e.target as HTMLElement | null)?.closest(".hl-popover")) return;
    if (this.activeTool !== "select" && this.activeTool !== "highlight") return;
    if (this.dragging || this.resizing || this.isDrawing) return;
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;

    const rect = this.canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    if (this.hitTest(cx, cy)) return;
    const hitHl = this.hitHighlight(cx, cy);
    if (hitHl) {
      this.select(hitHl);
    } else if (this.selected?.kind === "highlight") {
      this.selected = null;
      this.redrawCommitted();
      this.emitHighlightSelected(null);
    }
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (this.activeTool === "signature") return;

    if (this.activeTool === "select") {
      if (this.selected?.kind === "redact") {
        const v = this.hitVertex(e.offsetX, e.offsetY, this.selected);
        if (v !== null) {
          this.changeNotified = false;
          this.vertexDrag = { ann: this.selected, index: v, pts: this.outlineOf(this.selected) };
          this.track();
          return;
        }
      }
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
      this.emitHighlightSelected(null);
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
      if (this.tracking) return;
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
    if (this.activeTool === "select") return;

    if (!this.isDrawing) return;
    this.isDrawing = false;

    if (!this.lassoing && Math.hypot(e.offsetX - this.startX, e.offsetY - this.startY) < 4 && this.events.hasPickListeners) {
      const hit = this.hitTest(this.startX, this.startY);
      if (hit) {
        this.inkPts = [];
        this.redrawCommitted();
        this.events.picked(hit, this);
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

  private canvasPoint(e: MouseEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private clampNearPage([x, y]: [number, number]): [number, number] {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    return [Math.min(Math.max(x, -w), 2 * w), Math.min(Math.max(y, -h), 2 * h)];
  }

  private shiftBy(ann: Annotation, dx: number, dy: number): void {
    if (!dx && !dy) return;
    const [x0, y0] = this.toPdf(0, 0);
    const [x1, y1] = this.toPdf(dx, dy);
    ann.x += x1 - x0;
    ann.y += y1 - y0;
  }

  private keepInside(ann: Annotation): void {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (w <= 0 || h <= 0) return;
    const b = this.getAnnBounds(ann);
    const fit = (lo: number, hi: number, size: number): number =>
      lo < 0 || hi - lo >= size ? -lo : hi > size ? size - hi : 0;
    this.shiftBy(ann, fit(b.left, b.right, w), fit(b.top, b.bottom, h));
  }

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

  private addInside(ann: Annotation): void {
    this.keepInside(ann);
    this.session.add(ann);
  }

  private static canChangePage(ann: Annotation): boolean {
    return !(ann.kind === "text" && ann.cover);
  }

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

    this.selected = ann;
    this.changeNotified = true;
    this.dragging = true;
    this.dragTarget = ann;
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
    if (this.isDrawing) {
      this.isDrawing = false;
      this.inkPts = [];
      this.redrawCommitted();
    }
  };

  private makeInk(canvasPts: [number, number][], arrow: boolean): InkAnnotation | null {
    if (canvasPts.length < 2) return null;
    const lenPx = canvasPts.slice(1).reduce((acc, p, i) => acc + Math.hypot(p[0] - canvasPts[i][0], p[1] - canvasPts[i][1]), 0);
    if (lenPx < 4) return null;
    const pdf = canvasPts.map(([cx, cy]) => this.toPdf(cx, cy));
    const xs = pdf.map(p => p[0]), ys = pdf.map(p => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
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
    const tag = (document.activeElement as HTMLElement)?.tagName ?? "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
        (document.activeElement as HTMLElement)?.isContentEditable) return;
    if ((e.key === "Delete" || e.key === "Backspace") &&
        this.selected && (this.activeTool === "select" || this.selected.kind === "highlight")) {
      const removed = this.selected;
      this.selected = null;
      this.session.remove(removed);
      this.redrawCommitted();
      if (removed.kind === "highlight") this.emitHighlightSelected(null);
    }
  };

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
      font-size: ${fontSize}px; line-height: 1.2; font-family: ${fontCss(this.style.fontFamily, this.style.fontName)};
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
          ...(this.style.fontName ? { fontName: this.style.fontName } : {}),
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
      if (ev.key === "Enter" || ev.key === "Escape") ev.stopPropagation();
      if (ev.key === "Escape") { cleanup(); }
      else if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); commit(); }
    });

    container.appendChild(input);
    input.focus();
    setTimeout(() => document.addEventListener("mousedown", outsideClick, true), 0);
  }

  private onDblClick = (e: MouseEvent): void => {
    if (this.activeTool !== "select") return;
    const hit = this.hitTest(e.offsetX, e.offsetY);
    if (!hit) return;
    e.preventDefault();
    if (hit.kind === "text") this.handleTextEdit(hit);
    else if (hit.kind === "note") this.editNote(hit);

  };

  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  reorderAnnotation(ann: Annotation, dir: "up" | "down"): void {
    if (this.session.moveLayer(ann, dir === "up" ? 1 : -1)) this.redrawCommitted();
  }

  private handleTextEdit(ann: TextAnnotation): void {
    const container = this.container;
    const { scale } = this;
    const [canvasX, canvasY] = this.toCanvas(ann.x, ann.y);
    const boxTop = canvasY - 2 - ann.fontSize * scale;
    const boxW   = ann.width * scale;

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
      font-size: ${ann.fontSize * scale}px; line-height: 1.2; font-family: ${fontCss(ann.fontFamily, ann.fontName)};
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
        ann.width = Math.max(ann.width, this.fitTextWidth(content, { ...ann, fontFamily: ann.fontFamily ?? "helvetica", fontName: ann.fontName }));
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

  private fitTextWidth(content: string, st: Pick<TextAnnotation, "fontSize" | "bold" | "italic"> & { fontFamily: string; fontName?: string | null }): number {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = `${st.italic ? "italic" : "normal"} ${st.bold ? "bold" : "300"} ${st.fontSize}px ${fontCss(st.fontFamily as TextAnnotation["fontFamily"], st.fontName)}`;
    const lines = content.split("\n");
    const measured = Math.max(...lines.map(l => ctx.measureText(l).width));
    ctx.restore();
    const longest = Math.max(...lines.map(l => new TextEncoder().encode(l).length));
    return Math.max(measured + 4, longest * st.fontSize * (PDF_CHAR_W[st.fontFamily] ?? 0.5) + 1);
  }

  private editNote(ann: NoteAnnotation, fresh = false): void {
    const { scale } = this;
    const b = this.boxOf(ann);
    this.editingAnn = ann;
    this.selected = null;
    this.redrawCommitted();

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
      if (fresh) this.events.picked(ann, this);
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
    if (next === cur) return;
    e.preventDefault();
    noteScroll.set(hit, next);
    this.redrawCommitted();
  };

  private handleTextStyleEdit(ann: TextAnnotation): void {
    this.selected = ann;
    this.redrawCommitted();
    this.emitTextSelected(ann);
  }

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

  /**
   * Adds `ann`, a copy made for this page, nudged `steps` times down and right and kept on the
   * page, then selects it. Returns false when the page is not shown.
   */
  placeCopy(ann: Annotation, steps: number): boolean {
    if (!this.shown) return false;
    ann.page = this.currentPage;
    const d = steps * COPY_NUDGE_PT * this.scale;
    this.shiftBy(ann, d, d);
    this.addInside(ann);
    this.select(ann);
    return true;
  }

  get pageSizePt(): { width: number; height: number } {
    const r = this.canvas.getBoundingClientRect();
    return { width: r.width / this.scale, height: r.height / this.scale };
  }

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

  editTextAt(clientX: number, clientY: number): boolean {
    const r = this.canvas.getBoundingClientRect();
    const hit = this.hitTest(clientX - r.left, clientY - r.top);
    if (hit?.kind !== "text") return false;
    this.handleTextEdit(hit);
    return true;
  }

  replaceText(item: PageTextItem): void {
    const st = this.style;
    const fs = st.fontSize * this.scale;
    const [bx, by] = this.toCanvas(item.x, item.y);
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

  placeSignature(
    canvasX: number, canvasY: number, imageData: string, widthPt: number, heightPt: number, vector?: InkVector,
  ): SignatureAnnotation {
    const [pdfX, pdfY] = this.toPdf(canvasX, canvasY);
    const ann: SignatureAnnotation = {
      kind: "signature", page: this.currentPage,
      x: pdfX - widthPt / 2, y: pdfY - heightPt / 2,
      width: widthPt, height: heightPt, imageData,
      ...(vector ? { vector, color: { ...this.style.signatureColor } } : {}),
    };
    this.addInside(ann);
    this.selected = ann;
    this.redrawCommitted();
    return ann;
  }
}
