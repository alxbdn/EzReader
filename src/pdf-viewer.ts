import * as pdfjs from "pdfjs-dist";
import { AnnotationMode } from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, PageViewport, RenderTask } from "pdfjs-dist";
import { convertFileSrc } from "@tauri-apps/api/core";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { CanvasOverlay } from "./canvas-overlay";
import { AnnotationStore } from "./annotation-store";
import { defaultToolState, type ActiveToolState, type RedactAnnotation, CSS_UNITS } from "./models";
import { openUrl, type RedactedPage } from "./tauri-bridge";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// ── Pure layout functions (exported for unit tests) ───────────────────────────

const MAX_COLUMNS = 3;
const PAGE_GAP = 12; // px between columns

/**
 * Calculate how many pages fit side-by-side in the viewer, capped at MAX_COLUMNS.
 */
export function calculateColumnCount(
  containerWidth: number,
  refPageWidthPx: number,
  gap: number
): number {
  return Math.min(MAX_COLUMNS, Math.max(1, Math.floor((containerWidth + gap) / (refPageWidthPx + gap))));
}

/**
 * Group 1-indexed page numbers into rows of `columnCount`.
 */
export function buildRows(pageCount: number, columnCount: number): number[][] {
  const rows: number[][] = [];
  for (let i = 0; i < pageCount; i += columnCount) {
    const row: number[] = [];
    for (let j = i; j < Math.min(i + columnCount, pageCount); j++) {
      row.push(j + 1);
    }
    rows.push(row);
  }
  return rows;
}

/** Start offsets of the non-overlapping occurrences of `needle` (already lower-cased) in `text`. */
export function matchOffsets(text: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  const hay = text.toLocaleLowerCase();
  // Lower-casing can change the length of a few characters; fall back to no hits.
  if (hay.length !== text.length) return out;
  let at = hay.indexOf(needle);
  while (at !== -1) {
    out.push(at);
    at = hay.indexOf(needle, at + needle.length);
  }
  return out;
}

// ── PdfPageView ───────────────────────────────────────────────────────────────

export class PdfPageView {
  readonly pageNum: number;
  readonly wrapper: HTMLElement;
  readonly overlay: CanvasOverlay;
  rendered = false;
  rendering = false;

  private canvas: HTMLCanvasElement;
  private textLayer: HTMLElement;
  private linkLayer: HTMLElement;
  private formLayer: HTMLElement;
  private annotationCanvas: HTMLCanvasElement;
  private _viewport: PageViewport | null = null;
  /** Bumped by clear(); an in-flight render that sees a new value stops. */
  private _generation = 0;
  private _renderTask: RenderTask | null = null;

  constructor(pageNum: number, toolState: ActiveToolState) {
    this.pageNum = pageNum;

    this.wrapper = document.createElement("div");
    this.wrapper.className = "page-wrapper";
    this.wrapper.dataset.page = String(pageNum);

    this.canvas = document.createElement("canvas");
    this.canvas.className = "page-canvas";

    this.textLayer = document.createElement("div");
    this.textLayer.className = "page-text-layer";

    this.linkLayer = document.createElement("div");
    this.linkLayer.className = "page-link-layer";

    this.formLayer = document.createElement("div");
    this.formLayer.className = "page-form-layer";

    this.annotationCanvas = document.createElement("canvas");
    this.annotationCanvas.className = "page-annotation-canvas";

    this.wrapper.append(
      this.canvas,
      this.textLayer,
      this.linkLayer,
      this.formLayer,
      this.annotationCanvas
    );
    this.overlay = new CanvasOverlay(this.annotationCanvas, this.wrapper, toolState);
  }

  get viewport(): PageViewport | null { return this._viewport; }

  setPlaceholderSize(width: number, height: number): void {
    this.wrapper.style.width  = `${Math.round(width)}px`;
    this.wrapper.style.height = `${Math.round(height)}px`;
  }

  async render(
    pdfDoc: PDFDocumentProxy,
    scale: number,
    rotation: number,
    store: AnnotationStore,
    formValues: Map<string, string>,
    onFormChange: (name: string, val: string) => void
  ): Promise<void> {
    if (this.rendering) return;
    this.rendering = true;
    const generation = this._generation;
    const stale = () => generation !== this._generation;
    try {
      const page = await pdfDoc.getPage(this.pageNum);
      if (stale()) return;
      const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });
      this._viewport = viewport;

      // Render PDF content into an off-screen buffer first so the visible
      // canvas is never blank — old content stays until the new frame is ready.
      //
      // The canvas must map 1:1 onto screen pixels to look sharp.  Pick a
      // whole number of device pixels first, then derive the CSS size from
      // it.  (Flooring the backing store while keeping the fractional CSS
      // size made the browser stretch every page slightly, blurring text.)
      const dpr = window.devicePixelRatio || 1;
      const pxW = Math.max(1, Math.round(viewport.width  * dpr));
      const pxH = Math.max(1, Math.round(viewport.height * dpr));
      const cssW = pxW / dpr;
      const cssH = pxH / dpr;
      const buf = document.createElement("canvas");
      buf.width  = pxW;
      buf.height = pxH;
      const bufCtx = buf.getContext("2d")!;
      const sx = pxW / viewport.width;
      const sy = pxH / viewport.height;
      const transform = sx !== 1 || sy !== 1 ? [sx, 0, 0, sy, 0, 0] : undefined;
      this._renderTask = page.render({ canvasContext: bufCtx, viewport, transform, annotationMode: AnnotationMode.ENABLE_FORMS });
      try {
        await this._renderTask.promise;
      } catch (err) {
        // clear() cancels the task when the page scrolls out of range.
        if (stale()) return;
        throw err;
      } finally {
        this._renderTask = null;
      }
      if (stale()) return;

      // Atomic swap: resize + blit in one synchronous block.
      this.canvas.width  = buf.width;
      this.canvas.height = buf.height;
      this.canvas.style.width  = `${cssW}px`;
      this.canvas.style.height = `${cssH}px`;
      this.canvas.getContext("2d")!.drawImage(buf, 0, 0);

      // Size annotation canvas (no content to preserve here).
      this.annotationCanvas.width  = pxW;
      this.annotationCanvas.height = pxH;
      this.annotationCanvas.style.width  = `${cssW}px`;
      this.annotationCanvas.style.height = `${cssH}px`;

      // Snap wrapper to actual rendered size
      this.setPlaceholderSize(viewport.width, viewport.height);

      // Build overlay layers (text first — link layer scans text spans)
      await this.buildTextLayer(page, viewport);
      if (stale()) return;
      await this.buildLinkLayer(page, viewport);
      if (stale()) return;
      await this.buildFormLayer(page, viewport, formValues, onFormChange);
      if (stale()) return;

      // Sync annotation overlay
      this.overlay.syncToPage(
        this.pageNum,
        scale,
        viewport.height / scale,
        store.getForPage(this.pageNum),
        viewport
      );

      this.rendered = true;
    } finally {
      this.rendering = false;
    }
  }

  /** Remove rendered content while preserving placeholder dimensions. */
  clear(): void {
    // Stop any render still running for this page.  Without this, a render
    // that finishes after the page was cleared marks it "rendered" while its
    // canvas is blank, and the page is never drawn again (fast scrolling).
    this._generation++;
    this._renderTask?.cancel();
    this._renderTask = null;
    const ctx = this.canvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.textLayer.innerHTML  = "";
    this.linkLayer.innerHTML  = "";
    this.formLayer.innerHTML  = "";
    this.overlay.syncToPage(this.pageNum, 1, 841, []);
    this.rendered = false;
  }

  // ── Text layer ──────────────────────────────────────────────────────────────

  private async buildTextLayer(page: PDFPageProxy, viewport: PageViewport): Promise<void> {
    this.textLayer.innerHTML = "";
    this.textLayer.style.width  = `${viewport.width}px`;
    this.textLayer.style.height = `${viewport.height}px`;

    const textContent = await page.getTextContent();
    const fragment = document.createDocumentFragment();
    const measureCtx = document.createElement("canvas").getContext("2d")!;

    for (const rawItem of textContent.items) {
      if (!("str" in rawItem)) continue;
      const item = rawItem as { str: string; transform: number[]; width: number; height: number };
      if (!item.str) continue;

      const [a, b, , , tx, ty] = item.transform;
      const [vx, vy]  = viewport.convertToViewportPoint(tx, ty);
      const [vpx, vpy] = viewport.convertToViewportPoint(tx + a, ty + b);
      const fontSizePx = Math.hypot(vpx - vx, vpy - vy);
      if (fontSizePx < 1) continue;

      const angleDeg = Math.atan2(vpy - vy, vpx - vx) * (180 / Math.PI);
      const widthPx  = Math.max(item.width * viewport.scale, 1);

      const span = document.createElement("span");
      span.textContent = item.str;
      span.style.position        = "absolute";
      span.style.left            = `${vx}px`;
      span.style.top             = `${vy - fontSizePx}px`;
      span.style.fontSize        = `${fontSizePx}px`;
      span.style.fontFamily      = "sans-serif";
      span.style.lineHeight      = "1";
      span.style.color           = "transparent";
      span.style.whiteSpace      = "pre";
      span.style.cursor          = "text";
      span.style.pointerEvents   = "auto";
      span.style.transformOrigin = "0% 100%";
      span.style.setProperty("user-select",        "text");
      span.style.setProperty("-webkit-user-select", "text");

      measureCtx.font = `${fontSizePx}px sans-serif`;
      const measured = measureCtx.measureText(item.str).width;
      const scaleX   = measured > 0.5 ? widthPx / measured : 1;

      const transforms: string[] = [];
      if (Math.abs(angleDeg) > 0.5) transforms.push(`rotate(${angleDeg}deg)`);
      if (Math.abs(scaleX - 1) > 0.02) transforms.push(`scaleX(${scaleX})`);
      if (transforms.length) span.style.transform = transforms.join(" ");

      fragment.appendChild(span);
    }
    this.textLayer.appendChild(fragment);
  }

  // ── Search highlights ──────────────────────────────────────────────────────

  /**
   * Wraps each occurrence of `query` (case-insensitive, within one text item,
   * as `countMatches` counts them) in a <mark>. The `active`-th one on this
   * page gets the "active" class and is returned.
   */
  highlight(query: string, active: number): HTMLElement | null {
    const needle = query.toLocaleLowerCase();
    let n = 0;
    let activeMark: HTMLElement | null = null;
    for (const span of this.textLayer.querySelectorAll<HTMLSpanElement>(":scope > span")) {
      const text = span.dataset.text ?? span.textContent ?? "";
      const hits = needle ? matchOffsets(text, needle) : [];
      if (hits.length === 0) {
        if (span.dataset.text !== undefined) {
          span.textContent = text;
          delete span.dataset.text;
        }
        continue;
      }
      span.dataset.text = text;
      const frag = document.createDocumentFragment();
      let pos = 0;
      for (const at of hits) {
        if (at > pos) frag.append(text.slice(pos, at));
        const mark = document.createElement("mark");
        mark.className = "search-hit";
        mark.textContent = text.slice(at, at + needle.length);
        if (n === active) {
          mark.classList.add("active");
          activeMark = mark;
        }
        n++;
        frag.append(mark);
        pos = at + needle.length;
      }
      if (pos < text.length) frag.append(text.slice(pos));
      span.replaceChildren(frag);
    }
    return activeMark;
  }

  // ── Link layer ──────────────────────────────────────────────────────────────

  private async buildLinkLayer(page: PDFPageProxy, viewport: PageViewport): Promise<void> {
    this.linkLayer.innerHTML = "";

    // Collect text span positions for URL detection
    const mc = document.createElement("canvas").getContext("2d")!;
    const measure = (text: string, span: HTMLSpanElement): number => {
      mc.font = `${span.style.fontSize} ${span.style.fontFamily || "sans-serif"}`;
      return mc.measureText(text).width;
    };

    interface SpanEntry {
      span: HTMLSpanElement;
      start: number;
      end: number;
      text: string;
      pivotX: number;   // canvas x of text origin (= CSS left)
      pivotY: number;   // canvas y of text origin (= CSS top + fontSize)
      top: number;      // CSS top (used for line-break detection only)
      fontSize: number;
      angle: number;    // CSS rotation in degrees (from transform:rotate())
    }
    type Rect = { left: number; top: number; right: number; bottom: number };

    let combined = "";
    const entries: SpanEntry[] = [];
    const lineBreakPos = new Set<number>();
    let prevTop = NaN;

    for (const span of this.textLayer.querySelectorAll("span") as NodeListOf<HTMLSpanElement>) {
      const text = span.textContent ?? "";
      if (!text) continue;
      const spanTop  = parseFloat(span.style.top)      || 0;
      const fontSize = parseFloat(span.style.fontSize) || 12;
      if (combined.length > 0 && Math.abs(spanTop - prevTop) > 2) {
        lineBreakPos.add(combined.length);
        combined += " ";
      }
      const start = combined.length;
      combined += text;
      const rotMatch = /rotate\(([+-]?\d+(?:\.\d+)?)deg\)/.exec(span.style.transform || "");
      entries.push({
        span,
        start,
        end: combined.length,
        text,
        pivotX:   parseFloat(span.style.left) || 0,
        pivotY:   spanTop + fontSize,   // transform-origin is 0% 100% = bottom-left
        top:      spanTop,
        fontSize,
        angle:    rotMatch ? parseFloat(rotMatch[1]) : 0,
      });
      prevTop = spanTop;
    }

    const domRectsForRange = (urlStart: number, urlEnd: number): Rect[] => {
      const rects: Rect[] = [];
      for (const e of entries) {
        if (e.end <= urlStart || e.start >= urlEnd) continue;
        const urlL = Math.max(e.start, urlStart) - e.start;
        const urlR = Math.min(e.end,   urlEnd)   - e.start;
        const dxL = measure(e.text.slice(0, urlL), e.span);
        const dxR = measure(e.text.slice(0, urlR), e.span);
        if (dxR <= dxL) continue;
        if (Math.abs(e.angle) < 0.5) {
          // No rotation — simple horizontal rect.
          rects.push({ left: e.pivotX + dxL, top: e.pivotY - e.fontSize,
                       right: e.pivotX + dxR, bottom: e.pivotY });
        } else {
          // Rotate the 4 corners of the URL sub-rect around the pivot and
          // return the axis-aligned bounding box.
          const θ = e.angle * Math.PI / 180;
          const cos = Math.cos(θ), sin = Math.sin(θ);
          // corners relative to pivot (pivotX, pivotY):
          //   x axis = text advance direction, y axis = up (−fontSize)
          const corners: [number, number][] = [
            [dxL, -e.fontSize], [dxR, -e.fontSize],
            [dxR, 0],           [dxL, 0],
          ];
          const xs = corners.map(([x, y]) => e.pivotX + cos * x - sin * y);
          const ys = corners.map(([x, y]) => e.pivotY + sin * x + cos * y);
          rects.push({ left: Math.min(...xs), right: Math.max(...xs),
                       top:  Math.min(...ys), bottom: Math.max(...ys) });
        }
      }
      return rects;
    };

    interface DomEntry { startPos: number; rects: Rect[] }
    const urlRe = /https?:\/\/[^\s)\]>"]+/g;
    let m: RegExpExecArray | null;
    const domLinks = new Map<string, DomEntry>();

    while ((m = urlRe.exec(combined)) !== null) {
      const urlEnd = m.index + m[0].length;
      const rects  = domRectsForRange(m.index, urlEnd);
      if (rects.length > 0 && !domLinks.has(m[0])) {
        domLinks.set(m[0], { startPos: m.index, rects });
      }
      if (!lineBreakPos.has(urlEnd)) continue;
      for (const e of entries) {
        if (e.start < urlEnd + 1) continue;
        if (e.start > urlEnd + 2) break;
        const fragMatch = /^[^\s)\]>"]+/.exec(e.text);
        if (!fragMatch) break;
        const frag = fragMatch[0];
        if (frag.length >= 2 && frag.length <= 40 && /[./\-_?#=&%]/.test(frag)) {
          const fullUrl = m[0] + frag;
          if (!domLinks.has(fullUrl)) {
            const contRects = domRectsForRange(e.start, e.start + frag.length);
            domLinks.set(fullUrl, { startPos: m.index, rects: [...rects, ...contRects] });
          }
        }
        break;
      }
    }

    // Formal PDF link annotations
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const annotations: any[] = await (page as any).getAnnotations();
    const addedUrls = new Set<string>();

    const addLink = (url: string, rects: Rect[]) => {
      addedUrls.add(url);
      for (const r of rects) {
        const a = document.createElement("a");
        a.style.cssText = `position:absolute;left:${r.left}px;top:${r.top}px;width:${r.right - r.left}px;height:${r.bottom - r.top}px;`;
        a.addEventListener("click", (e) => { e.preventDefault(); void openUrl(url); });
        this.linkLayer.appendChild(a);
      }
    };

    for (const ann of annotations) {
      if (ann.subtype !== "Link") continue;
      const url: string | undefined = ann.url ?? ann.unsafeUrl;
      if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) continue;
      if (addedUrls.has(url)) continue;

      let bestDomUrl = "";
      let bestEntry: DomEntry | undefined;
      for (const [du, entry] of domLinks) {
        if (du === url) { bestDomUrl = du; bestEntry = entry; break; }
        const n = Math.min(du.length, url.length);
        if (n >= 10 && du.slice(0, n) === url.slice(0, n) && du.length > bestDomUrl.length) {
          bestDomUrl = du; bestEntry = entry;
        }
      }

      if (bestEntry) {
        addLink(url, [...bestEntry.rects]);
      } else {
        const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(
          ann.rect as [number, number, number, number]
        );
        addLink(url, [{ left: Math.min(x1,x2), top: Math.min(y1,y2), right: Math.max(x1,x2), bottom: Math.max(y1,y2) }]);
      }
    }

    // DOM-discovered URLs not covered by a formal annotation
    for (const [url, { rects }] of domLinks) {
      if (!addedUrls.has(url)) addLink(url, rects);
    }
  }

  // ── Form layer ──────────────────────────────────────────────────────────────

  private async buildFormLayer(
    page: PDFPageProxy,
    viewport: PageViewport,
    storedValues: Map<string, string>,
    onChange: (name: string, val: string) => void
  ): Promise<void> {
    this.formLayer.innerHTML = "";
    this.formLayer.style.width  = `${viewport.width}px`;
    this.formLayer.style.height = `${viewport.height}px`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const annotations: any[] = await (page as any).getAnnotations({ intent: "display" });
    const fieldEls: { el: HTMLElement; top: number }[] = [];

    for (const a of annotations) {
      if (a.subtype !== "Widget") continue;
      if (a.hidden || a.readOnly) continue;
      const fieldName: string = a.fieldName ?? "";
      if (!fieldName) continue;

      const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(a.rect as [number, number, number, number]);
      const left   = Math.min(x1, x2);
      const top    = Math.min(y1, y2);
      const width  = Math.abs(x2 - x1);
      const height = Math.abs(y2 - y1);
      const fontSize  = Math.max(height * 0.65, 8);
      const storedVal = storedValues.get(fieldName);
      const initialVal: string = storedVal ?? (a.fieldValue ?? "");

      let el: HTMLElement;

      if (a.fieldType === "Tx") {
        if (a.multiLine) {
          const ta = document.createElement("textarea");
          ta.value = initialVal;
          ta.style.resize = "none";
          ta.style.overflow = "hidden";
          ta.addEventListener("input", () => onChange(fieldName, ta.value));
          el = ta;
        } else {
          const inp = document.createElement("input");
          inp.type = "text";
          inp.value = initialVal;
          inp.addEventListener("input", () => onChange(fieldName, inp.value));
          el = inp;
        }
      } else if (a.fieldType === "Btn") {
        if (a.checkBox) {
          const inp = document.createElement("input");
          inp.type = "checkbox";
          inp.checked = !!initialVal && initialVal !== "Off" && initialVal !== "false";
          inp.addEventListener("change", () => onChange(fieldName, inp.checked ? "true" : "false"));
          inp.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;`;
          this.formLayer.appendChild(inp);
          fieldEls.push({ el: inp, top });
          continue;
        } else if (a.radioButton) {
          const inp = document.createElement("input");
          inp.type  = "radio";
          inp.name  = fieldName;
          inp.value = a.exportValue ?? "true";
          inp.checked = storedVal === inp.value || (!storedVal && a.fieldValue === a.exportValue);
          inp.addEventListener("change", () => { if (inp.checked) onChange(fieldName, inp.value); });
          inp.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;`;
          this.formLayer.appendChild(inp);
          fieldEls.push({ el: inp, top });
          continue;
        } else {
          continue;
        }
      } else if (a.fieldType === "Ch") {
        const sel = document.createElement("select");
        const opts: Array<{ exportValue: string; displayValue: string }> = a.options ?? [];
        for (const opt of opts) {
          const option = document.createElement("option");
          option.value = opt.exportValue;
          option.textContent = opt.displayValue;
          if (opt.exportValue === initialVal) option.selected = true;
          sel.appendChild(option);
        }
        sel.addEventListener("change", () => onChange(fieldName, sel.value));
        el = sel;
      } else {
        continue;
      }

      el.style.position = "absolute";
      el.style.left      = `${left}px`;
      el.style.top       = `${top}px`;
      el.style.width     = `${width}px`;
      el.style.height    = `${height}px`;
      el.style.fontSize  = `${fontSize}px`;
      this.formLayer.appendChild(el);
      fieldEls.push({ el, top });
    }

    fieldEls.sort((a, b) => a.top - b.top);
    const els = fieldEls.map(f => f.el);
    for (let i = 0; i < els.length; i++) {
      els[i].addEventListener("keydown", (e: Event) => {
        const ke = e as KeyboardEvent;
        if (ke.key !== "ArrowDown" && ke.key !== "ArrowUp") return;
        ke.preventDefault();
        const next = ke.key === "ArrowDown" ? els[i + 1] : els[i - 1];
        if (next) next.focus();
      });
    }
  }
}

// ── PdfViewer ─────────────────────────────────────────────────────────────────

export class PdfViewer {
  private pdfDoc: PDFDocumentProxy | null = null;
  private _currentPage = 1;
  private _focusedPage = 1;
  private _pageCount  = 0;
  private _scale      = CSS_UNITS; // 100% actual size
  private _rotation   = 0;
  private _toolState: ActiveToolState = defaultToolState();
  private _store: AnnotationStore = new AnnotationStore();
  private _formValues: Map<string, string> = new Map();
  private _onFormChange: (name: string, val: string) => void = () => {};

  pageDimensions: Array<{ width: number; height: number }> = [];
  pageViews: PdfPageView[] = [];
  columnCount = 1;
  /** Pages per row chosen by the user, or null to fit as many as the width allows. */
  private _forcedColumns: number | null = null;
  /** "horizontal" lays every page out in a single row that scrolls sideways. */
  private _scrollMode: "vertical" | "horizontal" = "vertical";

  private onLayoutChangedCb?: (views: PdfPageView[]) => void;
  onResizeCb?: () => void;
  private observer: IntersectionObserver | null = null;
  /** Pages currently inside the observer's area (viewport + margin). */
  private _visiblePages = new Set<number>();
  private resizeObserver: ResizeObserver | null = null;
  /** Search term to highlight, and the match to show (page 0 = none). */
  private _search = { query: "", page: 0, index: -1, scroll: false };
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private scrollEl: HTMLElement;

  constructor() {
    this.scrollEl = document.getElementById("viewer-scroll") as HTMLElement;
    this._watchPixelRatio();
  }

  /**
   * Re-render when the screen pixel density changes (window moved to another
   * monitor, Windows display scaling changed).  Otherwise pages keep the
   * resolution of the previous screen and look blurry.
   */
  private _watchPixelRatio(): void {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    mq.addEventListener("change", () => {
      if (this.pdfDoc) this.reflow();
      this._watchPixelRatio();
    }, { once: true });
  }

  // ── Accessors ───────────────────────────────────────────────────────────────

  get currentPage(): number   { return this._currentPage; }
  get pageCount():   number   { return this._pageCount; }
  get scale():       number   { return this._scale; }
  get rotation():    number   { return this._rotation; }
  get forcedColumns(): number | null { return this._forcedColumns; }
  get scrollMode(): "vertical" | "horizontal" { return this._scrollMode; }

  /** Number of pages per row for the current settings. */
  private _columnsFor(containerWidth: number, refPageWidthPx: number): number {
    if (this._scrollMode === "horizontal") return Math.max(1, this._pageCount);
    if (this._forcedColumns) return this._forcedColumns;
    return calculateColumnCount(containerWidth, refPageWidthPx, PAGE_GAP);
  }

  /** Shows `n` pages per row (null: as many as fit), then keeps the current page in view. */
  setColumns(n: number | null): void {
    this._forcedColumns = n;
    if (this.pdfDoc) { this.buildLayout(); this.goToPage(this._focusedPage, "instant"); }
  }

  setScrollMode(mode: "vertical" | "horizontal"): void {
    this._scrollMode = mode;
    this.scrollEl.classList.toggle("horizontal", mode === "horizontal");
    if (this.pdfDoc) { this.buildLayout(); this.goToPage(this._focusedPage, "instant"); }
  }

  get pageWidthPt():  number {
    const dim = this.pageDimensions[0];
    return dim ? dim.width : 595;
  }
  get pageHeightPt(): number {
    const dim = this.pageDimensions[0];
    return dim ? dim.height : 841;
  }

  get document(): PDFDocumentProxy | null { return this.pdfDoc; }

  get currentViewport(): PageViewport | null {
    return this.pageViews[this._currentPage - 1]?.viewport ?? null;
  }

  // ── Setup ────────────────────────────────────────────────────────────────────

  /** Register a callback invoked after every buildLayout() with the fresh pageViews array. */
  onLayoutChanged(cb: (views: PdfPageView[]) => void): void {
    this.onLayoutChangedCb = cb;
  }

  /** Call from main.ts before the first load() to provide shared context. */
  setup(
    toolState: ActiveToolState,
    store: AnnotationStore,
    formValues: Map<string, string>,
    onFormChange: (name: string, val: string) => void
  ): void {
    this._toolState    = toolState;
    this._store        = store;
    this._formValues   = formValues;
    this._onFormChange = onFormChange;
  }

  // ── Load ────────────────────────────────────────────────────────────────────

  async load(filePath: string): Promise<void> {
    await this._openDoc(convertFileSrc(filePath) + `?t=${Date.now()}`);
  }

  async loadWithPassword(filePath: string, password: string): Promise<void> {
    await this._openDoc(convertFileSrc(filePath) + `?t=${Date.now()}`, password);
  }

  private async _openDoc(url: string, password?: string): Promise<void> {
    if (this.pdfDoc) {
      await this.pdfDoc.destroy();
      this.pdfDoc = null;
    }
    this.observer?.disconnect();
    this._visiblePages.clear();
    if (this._scrollHandler) { this.scrollEl.removeEventListener("scroll", this._scrollHandler); this._scrollHandler = null; }

    const loadingTask = pdfjs.getDocument(password ? { url, password } : { url });
    this.pdfDoc = await loadingTask.promise;
    this._pageCount   = this.pdfDoc.numPages;
    this._currentPage = 1;
    this._focusedPage = 1;
    this._rotation    = 0;

    // Pre-fetch page dimensions (T010)
    this.pageDimensions = [];
    for (let i = 1; i <= this._pageCount; i++) {
      const p  = await this.pdfDoc.getPage(i);
      const vp = p.getViewport({ scale: 1.0 });
      this.pageDimensions.push({ width: vp.width, height: vp.height });
    }

    this.buildLayout();
    this.setupResizeObserver();
  }

  // ── Layout (T011 + T018-T019) ────────────────────────────────────────────────

  buildLayout(): void {
    this.observer?.disconnect();
    this._visiblePages.clear();
    if (this._scrollHandler) { this.scrollEl.removeEventListener("scroll", this._scrollHandler); this._scrollHandler = null; }
    this.scrollEl.innerHTML = "";
    this.pageViews = [];

    if (!this.pdfDoc || this.pageDimensions.length === 0) return;

    // Column count (US2: T018)
    // Swap width/height when user rotation is 90° or 270° so placeholder sizes
    // match the rendered viewport and don't trigger a ResizeObserver loop.
    const swapped = this._rotation % 180 !== 0;
    const containerWidth  = Math.max(1, this.scrollEl.clientWidth - 40);
    const refPageWidthPx  = Math.max(...this.pageDimensions.map(d => swapped ? d.height : d.width)) * this._scale;
    this.columnCount = this._columnsFor(containerWidth, refPageWidthPx);

    // Build rows (US2: T019)
    const rows = buildRows(this._pageCount, this.columnCount);
    for (const row of rows) {
      const rowEl = document.createElement("div");
      rowEl.className = "page-row";
      for (const pageNum of row) {
        const view = new PdfPageView(pageNum, this._toolState);
        const dim  = this.pageDimensions[pageNum - 1];
        if (dim) view.setPlaceholderSize(
          (swapped ? dim.height : dim.width) * this._scale,
          (swapped ? dim.width : dim.height) * this._scale
        );
        rowEl.appendChild(view.wrapper);
        this.pageViews.push(view);
      }
      this.scrollEl.appendChild(rowEl);
    }

    this.setupObserver();
    this.onLayoutChangedCb?.(this.pageViews);
  }

  // ── IntersectionObserver (T012) ──────────────────────────────────────────────

  private setupObserver(): void {
    // IntersectionObserver for lazy rendering / clearing
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageNum = parseInt((entry.target as HTMLElement).dataset.page ?? "0");
          if (!pageNum) continue;
          if (entry.isIntersecting) this._visiblePages.add(pageNum);
          else this._visiblePages.delete(pageNum);
        }
        // Use every page still in view, not only the ones in this batch:
        // during a fast scroll a batch can hold only pages that just left.
        const visiblePages = [...this._visiblePages];

        for (const entry of entries) {
          const pageNum  = parseInt((entry.target as HTMLElement).dataset.page ?? "0");
          const pageView = this.pageViews[pageNum - 1];
          if (!pageView) continue;

          if (entry.isIntersecting) {
            if (!pageView.rendered && !pageView.rendering) {
              void this._renderPage(pageView);
            }
          } else if (visiblePages.length > 0) {
            const minV = Math.min(...visiblePages);
            const maxV = Math.max(...visiblePages);
            if (pageNum < minV - 2 || pageNum > maxV + 2) {
              pageView.clear();
            }
          }
        }
      },
      { root: this.scrollEl, rootMargin: "200px 200px" }
    );

    for (const pv of this.pageViews) this.observer.observe(pv.wrapper);

    // Scroll listener for accurate current-page tracking
    this._scrollHandler = () => this._updateFocusedPage();
    this.scrollEl.addEventListener("scroll", this._scrollHandler, { passive: true });
    // Run once to set initial focused page
    this._updateFocusedPage();
  }

  private _scrollHandler: (() => void) | null = null;

  private _updateFocusedPage(): void {
    const horizontal = this._scrollMode === "horizontal";
    const viewportMid = horizontal
      ? this.scrollEl.scrollLeft + this.scrollEl.clientWidth / 3
      : this.scrollEl.scrollTop + this.scrollEl.clientHeight / 3;
    let best = 1;
    let bestDist = Infinity;
    for (const pv of this.pageViews) {
      const start = horizontal ? pv.wrapper.offsetLeft : pv.wrapper.offsetTop;
      const size = horizontal ? pv.wrapper.offsetWidth : pv.wrapper.offsetHeight;
      const mid = start + size / 2;
      const dist = Math.abs(mid - viewportMid);
      if (dist < bestDist) {
        bestDist = dist;
        best = pv.pageNum;
      }
    }
    if (best !== this._focusedPage) {
      this._focusedPage = best;
      this._currentPage = best;
      this.scrollEl.dispatchEvent(
        new CustomEvent("focused-page-changed", {
          detail: { page: best },
          bubbles: true,
        })
      );
    }
  }

  private async _renderPage(pageView: PdfPageView): Promise<void> {
    // A render already running re-checks the state below when it finishes.
    if (!this.pdfDoc || pageView.rendering) return;
    const expectedScale    = this._scale;
    const expectedRotation = this._rotation;
    await pageView.render(
      this.pdfDoc,
      expectedScale,
      expectedRotation,
      this._store,
      this._formValues,
      this._onFormChange
    );
    // If scale/rotation changed while this render was running (e.g. the user
    // zoomed again before the previous render finished), the render that just
    // completed used a stale scale and its setPlaceholderSize() call left the
    // wrapper at the wrong size.  Re-render immediately at the current values.
    if (this._scale !== expectedScale || this._rotation !== expectedRotation) {
      void this._renderPage(pageView);
      return;
    }
    if (pageView.rendered) this._applySearch(pageView);
    // The render was abandoned (page cleared while scrolling) or a reflow
    // invalidated it, but the page is back in view: draw it now.
    if (!pageView.rendered && this._visiblePages.has(pageView.pageNum)) {
      void this._renderPage(pageView);
    }
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  /**
   * Highlights `query` on every page and marks match `index` of `page` as the
   * current one. With `scroll`, brings that match into view (rendering its
   * page first when needed).
   */
  setSearch(query: string, page = 0, index = -1, scroll = false): void {
    this._search = { query, page, index, scroll };
    for (const pv of this.pageViews) if (pv.rendered) this._applySearch(pv);
    if (scroll && page > 0 && this._search.scroll) this.goToPage(page, "instant");
  }

  private _applySearch(pv: PdfPageView): void {
    const s = this._search;
    const mark = pv.highlight(s.query, pv.pageNum === s.page ? s.index : -1);
    if (mark && s.scroll) {
      s.scroll = false;
      mark.scrollIntoView({ block: "center", inline: "nearest" });
    }
  }

  // ── Navigation (T015) ────────────────────────────────────────────────────────

  goToPage(n: number, behavior: ScrollBehavior = "smooth"): void {
    const clamped = Math.max(1, Math.min(n, this._pageCount));
    this._currentPage = clamped;
    this.pageViews[clamped - 1]?.wrapper.scrollIntoView({ behavior, block: "start", inline: this._scrollMode === "horizontal" ? "start" : "nearest" });
  }

  async nextPage(): Promise<void> { this.goToPage(this._currentPage + this.columnCount); }
  async prevPage(): Promise<void> { this.goToPage(this._currentPage - this.columnCount); }

  // ── Zoom / Rotate / Reflow (T022-T026) ──────────────────────────────────────

  async setScale(scale: number): Promise<void> {
    this._scale = Math.max(0.25 * CSS_UNITS, Math.min(5.0 * CSS_UNITS, scale));
    this.reflow();
  }

  async rotate(): Promise<void> {
    this._rotation = (this._rotation + 90) % 360;
    this.reflow();
  }

  reflow(): void {
    const savedPage = this._focusedPage;

    // When the column count won't change, avoid tearing down the DOM entirely
    // (which causes a full black-screen flash).  Instead update placeholder
    // sizes and re-render visible pages in place — old canvas content stays
    // visible until the new render overwrites it.
    if (this.pdfDoc && this.pageViews.length === this._pageCount) {
      const swapped        = this._rotation % 180 !== 0;
      const containerWidth = Math.max(1, this.scrollEl.clientWidth - 40);
      const refW           = Math.max(...this.pageDimensions.map(d => swapped ? d.height : d.width)) * this._scale;
      const newCols        = this._columnsFor(containerWidth, refW);

      if (newCols === this.columnCount) {
        const savedScroll = this.scrollEl.scrollTop;
        const savedScrollX = this.scrollEl.scrollLeft;
        let anySizeChanged = false;
        for (const view of this.pageViews) {
          const dim = this.pageDimensions[view.pageNum - 1];
          if (dim) {
            const newW = Math.round((swapped ? dim.height : dim.width) * this._scale);
            const newH = Math.round((swapped ? dim.width  : dim.height) * this._scale);
            if (newW !== (parseInt(view.wrapper.style.width) || 0) ||
                newH !== (parseInt(view.wrapper.style.height) || 0)) anySizeChanged = true;
            view.setPlaceholderSize(newW, newH);
          }
          view.rendered = false;
        }
        this.onLayoutChangedCb?.(this.pageViews);
        // Only scroll to the page when sizes actually changed (zoom/rotate).
        // When only the container height changed (e.g. toolbar toggle), preserve
        // the exact scroll position to avoid a jarring jump.
        if (anySizeChanged) {
          this.goToPage(savedPage, "instant");
        } else {
          this.scrollEl.scrollTop = savedScroll;
          this.scrollEl.scrollLeft = savedScrollX;
        }
        const scrollRect = this.scrollEl.getBoundingClientRect();
        for (const view of this.pageViews) {
          const r = view.wrapper.getBoundingClientRect();
          if (r.bottom > scrollRect.top - 200 && r.top < scrollRect.bottom + 200) {
            void this._renderPage(view);
          }
        }
        return;
      }
    }

    this.buildLayout();
    this.goToPage(savedPage, "instant");
  }

  restoreRotation(degrees: number): void {
    this._rotation = degrees;
  }

  // ── ResizeObserver (T021) ────────────────────────────────────────────────────

  private setupResizeObserver(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        // onResizeCb may call setScale (which includes reflow), so only
        // fall back to a plain reflow when no callback handled it.
        if (this.onResizeCb) this.onResizeCb();
        else this.reflow();
      }, 100);
    });
    this.resizeObserver.observe(this.scrollEl);
  }

  // ── Print (T027 — unchanged logic) ──────────────────────────────────────────

  /** Rasterises pages of the document currently shown, applying the view rotation. */
  async renderPagesForPrint(pageNumbers: number[], dpi = 200): Promise<string[]> {
    if (!this.pdfDoc) return [];
    return renderDocPages(this.pdfDoc, pageNumbers, dpi, this._rotation);
  }

  /**
   * Rasterises pages of another PDF file (typically a temp copy with the
   * user's pending annotations burned in) without touching the open view.
   */
  async renderFileForPrint(filePath: string, pageNumbers: number[], dpi = 200): Promise<string[]> {
    const doc = await pdfjs.getDocument({ url: convertFileSrc(filePath) + `?t=${Date.now()}` }).promise;
    try {
      return await renderDocPages(doc, pageNumbers, dpi, 0);
    } finally {
      await doc.destroy();
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  isLoaded(): boolean { return this.pdfDoc !== null; }

  async close(): Promise<void> {
    this.observer?.disconnect();
    this._visiblePages.clear();
    if (this._scrollHandler) { this.scrollEl.removeEventListener("scroll", this._scrollHandler); this._scrollHandler = null; }
    this.resizeObserver?.disconnect();
    this.scrollEl.innerHTML = "";
    this.pageViews = [];
    if (this.pdfDoc) {
      await this.pdfDoc.destroy();
      this.pdfDoc = null;
    }
    this._pageCount   = 0;
    this._currentPage = 1;
    this.pageDimensions = [];
  }

  // ── Backward-compat shims (removed in T016) ──────────────────────────────────

  /** @deprecated Use buildLayout() + IntersectionObserver instead. */
  async render(): Promise<void> {
    if (!this.pdfDoc) return;
    this.buildLayout();
  }

  /** @deprecated Kept for transition; per-page form layers are built in PdfPageView.render(). */
  async buildFormLayer(
    _container: HTMLElement,
    _storedValues: Map<string, string>,
    _onChange: (name: string, val: string) => void
  ): Promise<void> { /* no-op during transition */ }

  /** @deprecated Kept for transition; link annotations are now per-page. */
  async getPageLinkAnnotations(): Promise<Array<{ url: string; rect: [number, number, number, number] }>> {
    return [];
  }
}

/** Renders the given 1-based pages to base64 JPEG strings (no data: prefix). */
async function renderDocPages(
  doc: PDFDocumentProxy,
  pageNumbers: number[],
  dpi: number,
  extraRotation: number,
): Promise<string[]> {
  const scale   = dpi / 72;
  const results: string[] = [];
  for (const i of pageNumbers) {
    if (i < 1 || i > doc.numPages) continue;
    const page     = await doc.getPage(i);
    const viewport = page.getViewport({ scale, rotation: (page.rotate + extraRotation) % 360 });
    const canvas   = document.createElement("canvas");
    canvas.width   = viewport.width;
    canvas.height  = viewport.height;
    const ctx = canvas.getContext("2d")!;
    await page.render({ canvasContext: ctx, viewport }).promise;
    results.push(canvas.toDataURL("image/jpeg", 0.92).split(",")[1]);
    // Free the bitmap right away; long documents otherwise pile up canvases.
    canvas.width = canvas.height = 0;
    page.cleanup();
  }
  return results;
}

/**
 * Renders the pages of `filePath` that carry redactions, unrotated and over
 * their visible area (`page.view`), with the redacted areas filled black.
 * Redaction coordinates are PDF user space, like every annotation.
 */
export async function renderRedactedPages(
  filePath: string,
  redactions: RedactAnnotation[],
  dpi = 300,
): Promise<RedactedPage[]> {
  const byPage = new Map<number, RedactAnnotation[]>();
  for (const r of redactions) byPage.set(r.page, [...(byPage.get(r.page) ?? []), r]);

  const doc = await pdfjs.getDocument({ url: convertFileSrc(filePath) + `?t=${Date.now()}` }).promise;
  try {
    const out: RedactedPage[] = [];
    for (const [pageNum, areas] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
      if (pageNum < 1 || pageNum > doc.numPages) continue;
      const page = await doc.getPage(pageNum);
      // Cap the bitmap (~40 MP) so very large pages do not exhaust memory.
      const unit  = page.getViewport({ scale: 1, rotation: 0 });
      const scale = Math.min(dpi / 72, Math.sqrt(40e6 / (unit.width * unit.height)));
      const viewport = page.getViewport({ scale, rotation: 0 });
      const canvas   = document.createElement("canvas");
      canvas.width   = Math.ceil(viewport.width);
      canvas.height  = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;

      ctx.fillStyle = "#000";
      for (const a of areas) {
        const [x1, y1] = viewport.convertToViewportPoint(a.x, a.y);
        const [x2, y2] = viewport.convertToViewportPoint(a.x + a.width, a.y + a.height);
        // Round outwards so no anti-aliased sliver of the content survives.
        const left = Math.floor(Math.min(x1, x2)) - 1, top = Math.floor(Math.min(y1, y2)) - 1;
        const right = Math.ceil(Math.max(x1, x2)) + 1, bottom = Math.ceil(Math.max(y1, y2)) + 1;
        ctx.fillRect(left, top, right - left, bottom - top);
      }

      const [v0, v1, v2, v3] = page.view;
      out.push({
        page: pageNum,
        jpegBase64: canvas.toDataURL("image/jpeg", 0.9).split(",")[1],
        widthPx: canvas.width,
        heightPx: canvas.height,
        view: [v0, v1, v2, v3],
      });
      canvas.width = canvas.height = 0;
      page.cleanup();
    }
    return out;
  } finally {
    await doc.destroy();
  }
}

