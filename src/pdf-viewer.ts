import { pdfjsLib } from "./pdfjs";
import { SAFE_PDF } from "./pdf-options";
import type { PDFDocumentProxy, PDFPageProxy, PageViewport, RenderTask } from "pdfjs-dist";
import { convertFileSrc } from "@tauri-apps/api/core";
import { CanvasOverlay } from "./canvas-overlay";
import { OverlayEvents } from "./overlay-events";
import { createFieldControl, type WidgetData } from "./form-fields";
import { ToolSelection } from "./tool-selection";
import { AnnotationSession } from "./annotation-session";
import { type RedactAnnotation, CSS_UNITS, MIN_SCALE, MAX_SCALE } from "./models";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { openUrl, type RedactedPage, type StraightenedPage } from "./tauri-bridge";
import { moveTextRuns, pageMap, reproject, warpToRect, type Point } from "./page-adjustment";
import { LiveText, hasRealText, layoutOcr, renderOcrLayer } from "./live-text";

const ENABLE_FORMS = 2;

const VIEWER_FONTS = { fontExtraProperties: true } as const;

export function toViewportRect(
  viewport: Pick<PageViewport, "convertToViewportPoint">,
  [x1, y1, x2, y2]: readonly number[] | Float32Array,
): [number, number, number, number] {
  const [a, b] = viewport.convertToViewportPoint(x1, y1);
  const [c, d] = viewport.convertToViewportPoint(x2, y2);
  return [a, b, c, d];
}

const MAX_COLUMNS = 3;
const PAGE_GAP = 12;

export function calculateColumnCount(
  containerWidth: number,
  refPageWidthPx: number,
  gap: number
): number {
  return Math.min(MAX_COLUMNS, Math.max(1, Math.floor((containerWidth + gap) / (refPageWidthPx + gap))));
}

export function buildRows(pageCount: number, columnCount: number, evenSpread = false): number[][] {
  const rows: number[][] = [];
  if (pageCount <= 0) return rows;
  let i = 0;
  if (columnCount === 2 && evenSpread) {
    rows.push([1]);
    i = 1;
  }
  for (; i < pageCount; i += columnCount) {
    const row: number[] = [];
    for (let j = i; j < Math.min(i + columnCount, pageCount); j++) {
      row.push(j + 1);
    }
    rows.push(row);
  }
  return rows;
}

export function focusedPageAt(
  pos: number,
  viewSize: number,
  maxPos: number,
  pages: readonly { start: number; size: number }[],
): number {
  if (pages.length === 0) return 1;
  if (maxPos > 1 && pos >= maxPos - 1) return pages.length;
  const line = pos + viewSize / 3;
  let best = 1;
  let bestDist = Infinity;
  pages.forEach((p, i) => {
    const dist = Math.abs(p.start + p.size / 2 - line);
    if (dist < bestDist) { bestDist = dist; best = i + 1; }
  });
  return best;
}

export function matchOffsets(text: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  const hay = text.toLocaleLowerCase();
  if (hay.length !== text.length) return out;
  let at = hay.indexOf(needle);
  while (at !== -1) {
    out.push(at);
    at = hay.indexOf(needle, at + needle.length);
  }
  return out;
}

export interface ResolvedDestination {
  page: number;
  point: [number, number] | null;
}

export interface DestinationDoc {
  numPages: number;
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
}

export interface LinkNavigationHandler {
  goToDestination?: (dest: unknown) => void | Promise<void>;
  executeNamedAction?: (action: string) => void;
  goToPage?: (page: number) => void;
}

export async function resolveDestination(
  pdfDoc: DestinationDoc,
  dest: unknown,
): Promise<ResolvedDestination | null> {
  let explicit: unknown[] | null = null;
  if (typeof dest === "string") {
    explicit = await pdfDoc.getDestination(dest);
  } else if (Array.isArray(dest)) {
    explicit = dest;
  }
  if (!Array.isArray(explicit) || explicit.length === 0) return null;

  const destRef = explicit[0];
  let pageNumber = 0;
  if (destRef && typeof destRef === "object") {
    try {
      pageNumber = (await pdfDoc.getPageIndex(destRef)) + 1;
    } catch {
      return null;
    }
  } else if (typeof destRef === "number" && Number.isInteger(destRef)) {
    pageNumber = destRef + 1;
  } else {
    return null;
  }

  if (pageNumber < 1 || pageNumber > pdfDoc.numPages) return null;

  const rawFit = explicit[1];
  const fitName =
    rawFit && typeof rawFit === "object" && "name" in rawFit
      ? String((rawFit as { name: unknown }).name)
      : typeof rawFit === "string"
        ? rawFit
        : "";

  let point: [number, number] | null = null;
  if (fitName === "XYZ") {
    const left = explicit[2];
    const top = explicit[3];
    if (typeof top === "number" && Number.isFinite(top)) {
      point = [typeof left === "number" && Number.isFinite(left) ? left : 0, top];
    }
  } else if (fitName === "FitH" || fitName === "FitBH") {
    const top = explicit[2];
    if (typeof top === "number" && Number.isFinite(top)) {
      point = [0, top];
    }
  } else if (fitName === "FitR") {
    const left = explicit[2];
    const top = explicit[5];
    if (typeof top === "number" && Number.isFinite(top)) {
      point = [typeof left === "number" && Number.isFinite(left) ? left : 0, top];
    }
  }

  return { page: pageNumber, point };
}

export class PdfPageView {
  readonly pageNum: number;
  readonly wrapper: HTMLElement;
  rendered = false;
  rendering = false;

  private _built = false;
  private _overlay: CanvasOverlay | null = null;
  private canvas!: HTMLCanvasElement;
  private textLayer!: HTMLElement;
  private linkLayer!: HTMLElement;
  private formLayer!: HTMLElement;
  private annotationCanvas!: HTMLCanvasElement;
  private highlightCanvas!: HTMLCanvasElement;
  private _viewport: PageViewport | null = null;
  private _generation = 0;
  private _renderTask: RenderTask | null = null;
  private _page: PDFPageProxy | null = null;
  private _renderedScale = 0;
  private _renderedRotation = -1;
  private _renderedDpr = 0;

  constructor(
    pageNum: number,
    private readonly tools: ToolSelection,
    private readonly annotations: AnnotationSession,
    private liveText: LiveText | null = null,
    private readonly events: OverlayEvents = new OverlayEvents(),
  ) {
    this.pageNum = pageNum;

    this.wrapper = document.createElement("div");
    this.wrapper.className = "page-wrapper";
    this.wrapper.dataset.page = String(pageNum);
  }

  get overlay(): CanvasOverlay {
    this.build();
    return this._overlay!;
  }

  get builtOverlay(): CanvasOverlay | null { return this._overlay; }

  private build(): void {
    if (this._built) return;
    this._built = true;

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

    this.highlightCanvas = document.createElement("canvas");
    this.highlightCanvas.className = "page-highlight-canvas";

    this.wrapper.append(
      this.canvas,
      this.highlightCanvas,
      this.textLayer,
      this.linkLayer,
      this.formLayer,
      this.annotationCanvas
    );
    for (const c of [this.canvas, this.highlightCanvas, this.annotationCanvas]) { c.width = 0; c.height = 0; }
    this._overlay = new CanvasOverlay(this.annotationCanvas, this.wrapper, this.tools, this.annotations, this.highlightCanvas, this.events);
    this._overlay.setTool(this.tools.tool);
    this._overlay.refreshStyle();
  }

  destroy(): void {
    this.clear();
    this._overlay?.destroy();
  }

  get viewport(): PageViewport | null { return this._viewport; }

  get hasPixels(): boolean { return this._built && this.canvas.width > 0; }

  get renderedRotation(): number { return this._renderedRotation; }

  isRenderedAt(scale: number, rotation: number, dpr = window.devicePixelRatio || 1): boolean {
    return (
      this.rendered &&
      this.hasPixels &&
      Math.abs(this._renderedScale - scale) < 1e-6 &&
      this._renderedRotation === rotation &&
      Math.abs(this._renderedDpr - dpr) < 1e-4
    );
  }

  cancelRender(): void {
    if (!this.rendering && !this._renderTask) return;
    this._generation++;
    this._renderTask?.cancel();
    this._renderTask = null;
    this.rendering = false;
  }

  setPlaceholderSize(width: number, height: number, keepStretchedCanvas = false): void {
    const w = `${Math.round(width)}px`;
    const h = `${Math.round(height)}px`;
    this.wrapper.style.width  = w;
    this.wrapper.style.height = h;
    if (keepStretchedCanvas && this.hasPixels) {
      this.canvas.style.width  = w;
      this.canvas.style.height = h;
    }
  }

  async render(
    pdfDoc: PDFDocumentProxy,
    scale: number,
    rotation: number,
    formValues: Map<string, string>,
    onFormChange: (name: string, val: string) => void,
    linkHandler?: LinkNavigationHandler,
    onPainted?: () => void
  ): Promise<void> {
    if (this.rendering) return;
    this.build();
    this.rendering = true;
    const generation = this._generation;
    const stale = () => generation !== this._generation;
    try {
      const page = await pdfDoc.getPage(this.pageNum);
      this._page = page;
      if (stale()) return;
      const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });
      this._viewport = viewport;

      const dpr = window.devicePixelRatio || 1;
      const pxW = Math.max(1, Math.round(viewport.width  * dpr));
      const pxH = Math.max(1, Math.round(viewport.height * dpr));
      const cssW = pxW / dpr;
      const cssH = pxH / dpr;
      const buf = document.createElement("canvas");
      buf.className = "page-canvas";
      buf.width  = pxW;
      buf.height = pxH;
      buf.style.width  = `${cssW}px`;
      buf.style.height = `${cssH}px`;
      const bufCtx = buf.getContext("2d")!;
      const sx = pxW / viewport.width;
      const sy = pxH / viewport.height;
      const transform = sx !== 1 || sy !== 1 ? [sx, 0, 0, sy, 0, 0] : undefined;
      this._renderTask = page.render({ canvas: bufCtx.canvas, viewport, transform, annotationMode: ENABLE_FORMS });
      try {
        await this._renderTask.promise;
      } catch (err) {
        buf.width = buf.height = 0;
        if (stale()) return;
        throw err;
      } finally {
        this._renderTask = null;
      }
      if (stale()) {
        buf.width = buf.height = 0;
        return;
      }

      const prevCanvas = this.canvas;
      this.canvas = buf;
      prevCanvas.replaceWith(buf);
      prevCanvas.width = prevCanvas.height = 0;

      for (const c of [this.annotationCanvas, this.highlightCanvas]) {
        c.width  = pxW;
        c.height = pxH;
        c.style.width  = `${cssW}px`;
        c.style.height = `${cssH}px`;
      }

      this.setPlaceholderSize(viewport.width, viewport.height);

      this.overlay.syncToPage(
        this.pageNum,
        scale,
        viewport.height / scale,
        viewport
      );
      onPainted?.();

      const hasText = await this.buildTextLayer(page, viewport, stale);
      if (stale()) return;
      if (!hasText && this.liveText) void this.addLiveText(page, viewport, stale);
      await this.buildLinkLayer(page, viewport, stale, linkHandler);
      if (stale()) return;
      await this.buildFormLayer(page, viewport, stale, formValues, onFormChange);
      if (stale()) return;

      this._renderedScale = scale;
      this._renderedRotation = rotation;
      this._renderedDpr = dpr;
      this.rendered = true;
    } finally {
      if (!stale()) this.rendering = false;
    }
  }

  clear(): void {
    this._generation++;
    this._renderTask?.cancel();
    this._renderTask = null;
    this._page?.cleanup();
    this._page = null;
    if (this._built) {
      for (const c of [this.canvas, this.highlightCanvas, this.annotationCanvas]) { c.width = 0; c.height = 0; }
      this.textLayer.innerHTML  = "";
      this.linkLayer.innerHTML  = "";
      this.formLayer.innerHTML  = "";
      this._overlay!.hide();
    }
    this._renderedScale = 0;
    this._renderedRotation = -1;
    this._renderedDpr = 0;
    this.rendered = false;
    this.rendering = false;
  }

  fontFacts(id: string): { name: string | null; bold: boolean; italic: boolean } | null {
    const objs = this._page?.commonObjs;
    if (!objs?.has(id)) return null;
    try {
      const f = objs.get(id) as { name?: string; bold?: boolean; italic?: boolean } | null;
      if (!f || typeof f !== "object") return null;
      return { name: typeof f.name === "string" ? f.name : null, bold: !!f.bold, italic: !!f.italic };
    } catch {
      return null;
    }
  }

  private async buildTextLayer(page: PDFPageProxy, viewport: PageViewport, stale: () => boolean): Promise<boolean> {
    this.textLayer.innerHTML = "";
    this.textLayer.classList.remove("has-ocr");
    this.textLayer.style.width  = `${viewport.width}px`;
    this.textLayer.style.height = `${viewport.height}px`;

    const textContent = await page.getTextContent();
    if (stale()) return true;
    const fragment = document.createDocumentFragment();
    const measureCtx = document.createElement("canvas").getContext("2d")!;
    let lastFont = "";

    for (const rawItem of textContent.items) {
      if (!("str" in rawItem)) continue;
      const item = rawItem as { str: string; transform: number[]; width: number; height: number; fontName?: string };
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
      span.dataset.pdf = [tx, ty, Math.hypot(a, b), item.width].map((n) => n.toFixed(2)).join(",");
      const family = item.fontName ? textContent.styles[item.fontName]?.fontFamily : undefined;
      if (family) span.dataset.family = family;
      if (item.fontName) span.dataset.font = item.fontName;
      span.style.setProperty("user-select",        "text");
      span.style.setProperty("-webkit-user-select", "text");

      const font = `${fontSizePx}px sans-serif`;
      if (font !== lastFont) {
        measureCtx.font = font;
        lastFont = font;
      }
      const measured = measureCtx.measureText(item.str).width;
      const scaleX   = measured > 0.5 ? widthPx / measured : 1;

      const transforms: string[] = [];
      if (Math.abs(angleDeg) > 0.5) transforms.push(`rotate(${angleDeg}deg)`);
      if (Math.abs(scaleX - 1) > 0.02) transforms.push(`scaleX(${scaleX})`);
      if (transforms.length) span.style.transform = transforms.join(" ");

      fragment.appendChild(span);
    }
    this.textLayer.appendChild(fragment);
    return hasRealText(textContent.items);
  }

  private async addLiveText(page: PDFPageProxy, viewport: PageViewport, stale: () => boolean): Promise<void> {
    const result = await this.liveText!.read(page, viewport.rotation, () => !stale() && this.wrapper.isConnected);
    if (!result || stale() || this._viewport !== viewport) return;
    const ctx = document.createElement("canvas").getContext("2d")!;
    const measure = (text: string, size: number) => {
      ctx.font = `${size}px sans-serif`;
      return ctx.measureText(text).width;
    };
    renderOcrLayer(this.textLayer, layoutOcr(result, viewport.width, viewport.height, measure));
  }

  highlight(query: string, active: number): HTMLElement | null {
    if (!this._built) return null;
    const needle = query.toLocaleLowerCase();
    let n = 0;
    let activeMark: HTMLElement | null = null;
    for (const span of this.textLayer.querySelectorAll<HTMLSpanElement>(":scope > span:not(.ocr-line)")) {
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

  private async buildLinkLayer(
    page: PDFPageProxy,
    viewport: PageViewport,
    stale: () => boolean,
    linkHandler?: LinkNavigationHandler
  ): Promise<void> {
    this.linkLayer.innerHTML = "";
    this.linkLayer.style.width  = `${viewport.width}px`;
    this.linkLayer.style.height = `${viewport.height}px`;

    type Rect = { left: number; top: number; right: number; bottom: number };
    interface DomEntry { startPos: number; rects: Rect[] }
    const domLinks = new Map<string, DomEntry>();

    if (this.textLayer.textContent?.includes("http")) {
      const mc = document.createElement("canvas").getContext("2d")!;
      let lastFont = "";
      const measure = (text: string, span: HTMLSpanElement): number => {
        const font = `${span.style.fontSize} ${span.style.fontFamily || "sans-serif"}`;
        if (font !== lastFont) {
          mc.font = font;
          lastFont = font;
        }
        return mc.measureText(text).width;
      };

      interface SpanEntry {
        span: HTMLSpanElement;
        start: number;
        end: number;
        text: string;
        pivotX: number;
        pivotY: number;
        top: number;
        fontSize: number;
        angle: number;
      }

      let combined = "";
      const entries: SpanEntry[] = [];
      const lineBreakPos = new Set<number>();
      let prevTop = NaN;

      for (const span of this.textLayer.querySelectorAll(":scope > span:not(.ocr-line)") as NodeListOf<HTMLSpanElement>) {
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
          pivotY:   spanTop + fontSize,
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
            rects.push({ left: e.pivotX + dxL, top: e.pivotY - e.fontSize,
                         right: e.pivotX + dxR, bottom: e.pivotY });
          } else {
            const θ = e.angle * Math.PI / 180;
            const cos = Math.cos(θ), sin = Math.sin(θ);
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

      const urlRe = /https?:\/\/[^\s)\]>"]+/g;
      let m: RegExpExecArray | null;

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
    }

    const annotations: any[] = await (page as any).getAnnotations();
    if (stale()) return;
    const addedUrls = new Set<string>();

    const normalizeViewportRect = ([x1, y1, x2, y2]: number[]): Rect | null => {
      const r: Rect = {
        left: Math.min(x1, x2),
        top: Math.min(y1, y2),
        right: Math.max(x1, x2),
        bottom: Math.max(y1, y2),
      };
      return r.right > r.left && r.bottom > r.top ? r : null;
    };

    const annRects = (ann: { quadPoints?: Float32Array | number[]; rect?: [number, number, number, number] }): Rect[] => {
      const rects: Rect[] = [];
      const qp = ann.quadPoints;
      if (qp && qp.length >= 8 && qp.length % 8 === 0) {
        for (let i = 0; i < qp.length; i += 8) {
          const xs = [qp[i], qp[i + 2], qp[i + 4], qp[i + 6]];
          const ys = [qp[i + 1], qp[i + 3], qp[i + 5], qp[i + 7]];
          const r = normalizeViewportRect(toViewportRect(viewport, [
            Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys),
          ]));
          if (r) rects.push(r);
        }
      }
      if (rects.length === 0 && ann.rect) {
        const r = normalizeViewportRect(toViewportRect(viewport, ann.rect));
        if (r) rects.push(r);
      }
      return rects;
    };

    const appendAnchors = (rects: Rect[], onClick: () => void, internal = false) => {
      for (const r of rects) {
        const a = document.createElement("a");
        a.style.cssText = `position:absolute;left:${r.left}px;top:${r.top}px;width:${r.right - r.left}px;height:${r.bottom - r.top}px;`;
        if (internal) a.dataset.internalLink = "true";
        a.addEventListener("click", (e) => { e.preventDefault(); onClick(); });
        this.linkLayer.appendChild(a);
      }
    };

    for (const ann of annotations) {
      if (ann.subtype !== "Link") continue;
      const url: string | undefined = ann.url ?? ann.unsafeUrl;

      if (url && (url.startsWith("http://") || url.startsWith("https://"))) {
        let bestEntry: DomEntry | undefined;
        if (!addedUrls.has(url)) {
          let bestDomUrl = "";
          for (const [du, entry] of domLinks) {
            if (du === url) { bestDomUrl = du; bestEntry = entry; break; }
            const n = Math.min(du.length, url.length);
            if (n >= 10 && du.slice(0, n) === url.slice(0, n) && du.length > bestDomUrl.length) {
              bestDomUrl = du; bestEntry = entry;
            }
          }
        }
        addedUrls.add(url);

        const rects = bestEntry ? [...bestEntry.rects] : annRects(ann);
        appendAnchors(rects, () => { void openUrl(url); });
      } else if (ann.dest && linkHandler?.goToDestination) {
        appendAnchors(annRects(ann), () => { void linkHandler.goToDestination!(ann.dest); }, true);
      } else if (typeof ann.action === "string" && linkHandler?.executeNamedAction) {
        appendAnchors(annRects(ann), () => { linkHandler.executeNamedAction!(ann.action); }, true);
      } else if (typeof ann.unsafeUrl === "string" && ann.unsafeUrl.startsWith("#") && linkHandler) {
        const rawHash = ann.unsafeUrl.slice(1);
        let hash = rawHash;
        try { hash = decodeURIComponent(rawHash); } catch {}
        const pageMatch = /^page=(\d+)$/i.exec(hash);
        if (pageMatch && linkHandler.goToPage) {
          const targetPage = Number(pageMatch[1]);
          appendAnchors(annRects(ann), () => { linkHandler.goToPage!(targetPage); }, true);
        } else if (hash && linkHandler.goToDestination) {
          appendAnchors(annRects(ann), () => { void linkHandler.goToDestination!(hash); }, true);
        }
      }
    }

    for (const [url, { rects }] of domLinks) {
      if (!addedUrls.has(url)) appendAnchors(rects, () => { void openUrl(url); });
    }
  }

  private async buildFormLayer(
    page: PDFPageProxy,
    viewport: PageViewport,
    stale: () => boolean,
    storedValues: Map<string, string>,
    onChange: (name: string, val: string) => void
  ): Promise<void> {
    this.formLayer.innerHTML = "";
    this.formLayer.style.width  = `${viewport.width}px`;
    this.formLayer.style.height = `${viewport.height}px`;

    const annotations = (await page.getAnnotations({ intent: "display" })) as WidgetData[];
    if (stale()) return;
    const fieldEls: { el: HTMLElement; top: number }[] = [];

    for (const a of annotations) {
      if (a.subtype !== "Widget" || !a.fieldName) continue;
      const [x1, y1, x2, y2] = toViewportRect(viewport, a.rect);
      const box = {
        left: Math.min(x1, x2), top: Math.min(y1, y2),
        width: Math.abs(x2 - x1), height: Math.abs(y2 - y1),
      };
      const el = createFieldControl(a, box, viewport.scale, storedValues.get(a.fieldName), onChange);
      if (!el) continue;
      this.formLayer.appendChild(el);
      fieldEls.push({ el, top: box.top });
    }

    fieldEls.sort((a, b) => a.top - b.top);
    const els = fieldEls.map(f => f.el);
    for (let i = 0; i < els.length; i++) {
      els[i].addEventListener("keydown", (e: Event) => {
        const ke = e as KeyboardEvent;
        if (ke.key !== "ArrowDown" && ke.key !== "ArrowUp") return;
        if (els[i] instanceof HTMLTextAreaElement || els[i] instanceof HTMLSelectElement) return;
        ke.preventDefault();
        const next = ke.key === "ArrowDown" ? els[i + 1] : els[i - 1];
        if (next) next.focus();
      });
    }
  }
}

export class PdfViewer {
  private pdfDoc: PDFDocumentProxy | null = null;
  private _currentPage = 1;
  private _focusedPage = 1;
  private _pageCount  = 0;
  private _scale      = CSS_UNITS;
  private _rotation   = 0;
  private _tools: ToolSelection = new ToolSelection();
  private _annotations: AnnotationSession = new AnnotationSession();
  private _formValues: Map<string, string> = new Map();
  private _onFormChange: (name: string, val: string) => void = () => {};
  private readonly _linkHandler: LinkNavigationHandler = {
    goToDestination: (dest) => this.goToDestination(dest),
    executeNamedAction: (action) => this.executeNamedAction(action),
    goToPage: (page) => this.goToPage(page),
  };

  readonly overlayEvents = new OverlayEvents();

  pageDimensions: Array<{ width: number; height: number }> = [];
  pageViews: PdfPageView[] = [];
  columnCount = 1;
  private _forcedColumns: number | null = null;
  private _evenSpread = false;
  private _shownEvenSpread = false;
  private _scrollMode: "vertical" | "horizontal" = "vertical";

  private onLayoutChangedCb?: (views: PdfPageView[]) => void;
  private onRenderActivityCb?: (busy: boolean) => void;
  onResizeCb?: () => void;
  private observer: IntersectionObserver | null = null;
  private _visiblePages = new Set<number>();
  private _renderQueue = new Set<PdfPageView>();
  private _activeRenders = 0;
  private _renderEpoch = 0;
  private _renderBusy = false;
  private _pageOffsets: { start: number; size: number }[] | null = null;
  private _scrollRaf = 0;
  private resizeObserver: ResizeObserver | null = null;
  private _search = { query: "", page: 0, index: -1, scroll: false };
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private scrollEl: HTMLElement;
  readonly liveText = new LiveText(null);

  constructor() {
    this.scrollEl = document.getElementById("viewer-scroll") as HTMLElement;
    this._watchPixelRatio();
  }

  private _watchPixelRatio(): void {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    mq.addEventListener("change", () => {
      if (this.pdfDoc) this.reflow();
      this._watchPixelRatio();
    }, { once: true });
  }

  get currentPage(): number   { return this._currentPage; }
  get pageCount():   number   { return this._pageCount; }
  get scale():       number   { return this._scale; }
  get rotation():    number   { return this._rotation; }
  get forcedColumns(): number | null { return this._forcedColumns; }
  get evenSpread(): boolean { return this._evenSpread; }
  get scrollMode(): "vertical" | "horizontal" { return this._scrollMode; }

  private _columnsFor(containerWidth: number, refPageWidthPx: number): number {
    if (this._scrollMode === "horizontal") return Math.max(1, this._pageCount);
    if (this._forcedColumns) return this._forcedColumns;
    return calculateColumnCount(containerWidth, refPageWidthPx, PAGE_GAP);
  }

  setColumns(n: number | null, evenSpread = false): void {
    this._forcedColumns = n;
    this._evenSpread = n === 2 && evenSpread;
    if (this.pdfDoc) this.reflow();
  }

  setScrollMode(mode: "vertical" | "horizontal"): void {
    this._scrollMode = mode;
    this.scrollEl.classList.toggle("horizontal", mode === "horizontal");
    if (this.pdfDoc) this.reflow();
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

  onLayoutChanged(cb: (views: PdfPageView[]) => void): void {
    this.onLayoutChangedCb = cb;
  }

  onRenderActivity(cb: (busy: boolean) => void): void {
    this.onRenderActivityCb = cb;
  }

  private _forgetActiveRenders(): void {
    this._renderEpoch++;
    this._activeRenders = 0;
    this._updateRenderActivity();
  }

  private _updateRenderActivity(): void {
    const busy = this._activeRenders > 0 || this._renderQueue.size > 0;
    if (busy !== this._renderBusy) {
      this._renderBusy = busy;
      this.onRenderActivityCb?.(busy);
    }
  }

  setup(
    tools: ToolSelection,
    annotations: AnnotationSession,
    formValues: Map<string, string>,
    onFormChange: (name: string, val: string) => void
  ): void {
    this._tools        = tools;
    this._annotations  = annotations;
    this._formValues   = formValues;
    this._onFormChange = onFormChange;
  }

  async load(filePath: string, rotation = 0): Promise<void> {
    await this._openDoc(convertFileSrc(filePath) + `?t=${Date.now()}`, undefined, rotation);
  }

  async loadWithPassword(filePath: string, password: string): Promise<void> {
    await this._openDoc(convertFileSrc(filePath) + `?t=${Date.now()}`, password);
  }

  async reload(filePath: string): Promise<void> {
    const top = this.scrollEl.scrollTop;
    const left = this.scrollEl.scrollLeft;
    await this._openDoc(convertFileSrc(filePath) + `?t=${Date.now()}`, undefined, 0);
    this.scrollEl.scrollTop = top;
    this.scrollEl.scrollLeft = left;
    this._updateFocusedPage();
    this._currentPage = this._focusedPage;
    this._renderVisible();
  }

  private async _openDoc(url: string, password?: string, rotation = 0): Promise<void> {
    this._renderQueue.clear();
    this._updateRenderActivity();
    for (const view of this.pageViews) view.clear();
    this._forgetActiveRenders();
    if (this.pdfDoc) {
      await this.pdfDoc.loadingTask.destroy();
      this.pdfDoc = null;
    }
    this.observer?.disconnect();
    this._visiblePages.clear();
    this._pageOffsets = null;
    if (this._scrollRaf) { cancelAnimationFrame(this._scrollRaf); this._scrollRaf = 0; }
    if (this._scrollHandler) { this.scrollEl.removeEventListener("scroll", this._scrollHandler); this._scrollHandler = null; }

    this.liveText.reset();
    const loadingTask = (await pdfjsLib()).getDocument(password ? { ...SAFE_PDF, ...VIEWER_FONTS, url, password } : { ...SAFE_PDF, ...VIEWER_FONTS, url });
    this.pdfDoc = await loadingTask.promise;
    this._pageCount   = this.pdfDoc.numPages;
    this._currentPage = 1;
    this._focusedPage = 1;
    this._rotation    = rotation;

    const initialCount = Math.min(this._pageCount, 16);
    const initialPages = await Promise.all(
      Array.from({ length: initialCount }, (_, i) => this.pdfDoc!.getPage(i + 1))
    );
    const initialDims = initialPages.map((p) => {
      const vp = p.getViewport({ scale: 1.0 });
      return { width: vp.width, height: vp.height };
    });
    const fallbackDim = initialDims[0] ?? { width: 595, height: 842 };
    this.pageDimensions = Array.from(
      { length: this._pageCount },
      (_, i) => initialDims[i] ? { ...initialDims[i] } : { width: fallbackDim.width, height: fallbackDim.height }
    );

    this.buildLayout();
    this.setupResizeObserver();
  }

  buildLayout(): void {
    this._clearPreview();
    this._pageOffsets = null;
    this._renderQueue.clear();
    this._updateRenderActivity();
    this.observer?.disconnect();
    this._visiblePages.clear();
    if (this._scrollRaf) { cancelAnimationFrame(this._scrollRaf); this._scrollRaf = 0; }
    if (this._scrollHandler) { this.scrollEl.removeEventListener("scroll", this._scrollHandler); this._scrollHandler = null; }
    for (const view of this.pageViews) view.destroy();
    this.scrollEl.innerHTML = "";
    this.pageViews = [];

    if (!this.pdfDoc || this.pageDimensions.length === 0) return;

    const swapped = this._rotation % 180 !== 0;
    const containerWidth  = Math.max(1, this.scrollEl.clientWidth - 40);
    const refPageWidthPx  = Math.max(...this.pageDimensions.map(d => swapped ? d.height : d.width)) * this._scale;
    this.columnCount = this._columnsFor(containerWidth, refPageWidthPx);

    this._shownEvenSpread = this.columnCount === 2 && this._evenSpread;
    const rows = buildRows(this._pageCount, this.columnCount, this._shownEvenSpread);
    const frag = document.createDocumentFragment();
    for (const row of rows) {
      const rowEl = document.createElement("div");
      rowEl.className = "page-row";
      for (const pageNum of row) {
        const view = new PdfPageView(pageNum, this._tools, this._annotations, this.liveText, this.overlayEvents);
        const dim  = this.pageDimensions[pageNum - 1];
        if (dim) view.setPlaceholderSize(
          (swapped ? dim.height : dim.width) * this._scale,
          (swapped ? dim.width : dim.height) * this._scale
        );
        rowEl.appendChild(view.wrapper);
        this.pageViews.push(view);
      }
      frag.appendChild(rowEl);
    }
    this.scrollEl.appendChild(frag);

    this.setupObserver();
    this.onLayoutChangedCb?.(this.pageViews);
  }

  private _regroupRows(columnCount: number): void {
    this._shownEvenSpread = columnCount === 2 && this._evenSpread;
    const rows = buildRows(this._pageCount, columnCount, this._shownEvenSpread);
    const frag = document.createDocumentFragment();
    for (const row of rows) {
      const rowEl = document.createElement("div");
      rowEl.className = "page-row";
      for (const pageNum of row) {
        const view = this.pageViews[pageNum - 1];
        if (view) rowEl.appendChild(view.wrapper);
      }
      frag.appendChild(rowEl);
    }
    this.scrollEl.replaceChildren(frag);
    this._pageOffsets = null;
  }

  private setupObserver(): void {
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageNum = parseInt((entry.target as HTMLElement).dataset.page ?? "0");
          if (!pageNum) continue;
          if (entry.isIntersecting) this._visiblePages.add(pageNum);
          else this._visiblePages.delete(pageNum);
        }

        for (const entry of entries) {
          const pageNum  = parseInt((entry.target as HTMLElement).dataset.page ?? "0");
          const pageView = this.pageViews[pageNum - 1];
          if (!pageView) continue;

          if (entry.isIntersecting) {
            if (!pageView.rendered && !pageView.rendering) {
              this._queueRender(pageView);
            }
          } else {
            this._renderQueue.delete(pageView);
          }
        }

        this._evictDistantPages();
        this._pumpRenderQueue();
      },
      { root: this.scrollEl, rootMargin: "300px 200px" }
    );

    for (const pv of this.pageViews) this.observer.observe(pv.wrapper);

    this._scrollHandler = () => {
      if (this._scrollRaf) return;
      this._scrollRaf = requestAnimationFrame(() => {
        this._scrollRaf = 0;
        this._updateFocusedPage();
      });
    };
    this.scrollEl.addEventListener("scroll", this._scrollHandler, { passive: true });
    this._updateFocusedPage();
  }

  private _scrollHandler: (() => void) | null = null;

  private _evictDistantPages(): void {
    const visiblePages = [...this._visiblePages];
    if (visiblePages.length === 0) return;
    const minV = Math.min(...visiblePages);
    const maxV = Math.max(...visiblePages);
    const keepMargin = 3;
    const maxCached = 10;

    const keptWithPixels: PdfPageView[] = [];
    for (const view of this.pageViews) {
      if (view.pageNum < minV - keepMargin || view.pageNum > maxV + keepMargin) {
        this._renderQueue.delete(view);
        if (view.rendered || view.rendering || view.hasPixels) view.clear();
      } else if (view.hasPixels) {
        keptWithPixels.push(view);
      }
    }

    if (keptWithPixels.length > maxCached) {
      const center = (minV + maxV) / 2;
      keptWithPixels.sort((a, b) => Math.abs(b.pageNum - center) - Math.abs(a.pageNum - center));
      for (let i = 0; i < keptWithPixels.length - maxCached; i++) {
        const view = keptWithPixels[i];
        if (!this._visiblePages.has(view.pageNum)) {
          this._renderQueue.delete(view);
          view.clear();
        }
      }
    }
  }

  private _getPageOffsets(): { start: number; size: number }[] {
    if (!this._pageOffsets) {
      const horizontal = this._scrollMode === "horizontal";
      this._pageOffsets = this.pageViews.map((pv) => horizontal
        ? { start: pv.wrapper.offsetLeft, size: pv.wrapper.offsetWidth }
        : { start: pv.wrapper.offsetTop, size: pv.wrapper.offsetHeight });
    }
    return this._pageOffsets;
  }

  private _updateFocusedPage(): void {
    const horizontal = this._scrollMode === "horizontal";
    const el = this.scrollEl;
    const best = focusedPageAt(
      horizontal ? el.scrollLeft : el.scrollTop,
      horizontal ? el.clientWidth : el.clientHeight,
      horizontal ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight,
      this._getPageOffsets(),
    );
    this._setCurrentAndFocusedPage(best);
  }

  private _queueRender(pageView: PdfPageView): void {
    if (!this.pdfDoc || pageView.rendered || pageView.rendering) return;
    this._renderQueue.add(pageView);
    this._pumpRenderQueue();
  }

  private _pumpRenderQueue(): void {
    const maxConcurrent = 2;
    if (this._previewScale !== null) { this._updateRenderActivity(); return; }
    let screen: DOMRect | null = null;
    while (this._activeRenders < maxConcurrent && this._renderQueue.size > 0) {
      screen ??= this.scrollEl.getBoundingClientRect();
      let best: PdfPageView | null = null;
      let bestDist = Infinity;
      const focus = this._focusedPage;
      for (const pv of this._renderQueue) {
        if (pv.rendered || pv.rendering) {
          this._renderQueue.delete(pv);
          continue;
        }
        const r = pv.wrapper.getBoundingClientRect();
        const onScreen = r.bottom > screen.top && r.top < screen.bottom && r.right > screen.left && r.left < screen.right;
        const dist = Math.abs(pv.pageNum - focus) + (onScreen ? 0 : 10_000);
        if (dist < bestDist) {
          bestDist = dist;
          best = pv;
        }
      }
      if (!best) break;
      this._renderQueue.delete(best);
      void this._renderPage(best);
    }
    this._updateRenderActivity();
  }

  private async _renderPage(pageView: PdfPageView): Promise<void> {
    if (!this.pdfDoc || pageView.rendering) return;
    this._renderQueue.delete(pageView);
    this._activeRenders++;
    this._updateRenderActivity();
    const epoch = this._renderEpoch;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (epoch === this._renderEpoch) this._activeRenders = Math.max(0, this._activeRenders - 1);
      this._pumpRenderQueue();
    };
    const expectedScale    = this._scale;
    const expectedRotation = this._rotation;
    try {
      await pageView.render(
        this.pdfDoc,
        expectedScale,
        expectedRotation,
        this._formValues,
        this._onFormChange,
        this._linkHandler,
        release
      );
      if (epoch !== this._renderEpoch) return;
      if (pageView.viewport) {
        const unitW = pageView.viewport.width / expectedScale;
        const unitH = pageView.viewport.height / expectedScale;
        const swapped = expectedRotation % 180 !== 0;
        const baseW = swapped ? unitH : unitW;
        const baseH = swapped ? unitW : unitH;
        const prev = this.pageDimensions[pageView.pageNum - 1];
        if (!prev || Math.abs(prev.width - baseW) > 0.5 || Math.abs(prev.height - baseH) > 0.5) {
          this.pageDimensions[pageView.pageNum - 1] = { width: baseW, height: baseH };
          this._pageOffsets = null;
        }
      }
      if (this._scale !== expectedScale || this._rotation !== expectedRotation) {
        this._queueRender(pageView);
        return;
      }
      if (pageView.rendered) this._applySearch(pageView);
      if (!pageView.rendered && this._visiblePages.has(pageView.pageNum)) {
        this._queueRender(pageView);
      }
    } finally {
      release();
      this._updateRenderActivity();
    }
  }

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

  private _setCurrentAndFocusedPage(page: number): void {
    this._currentPage = page;
    if (this._focusedPage !== page) {
      this._focusedPage = page;
      this.scrollEl.dispatchEvent(
        new CustomEvent("focused-page-changed", {
          detail: { page },
          bubbles: true,
        })
      );
    }
  }

  goToPage(n: number, behavior: ScrollBehavior = "smooth"): void {
    const clamped = Math.max(1, Math.min(n, this._pageCount));
    this._setCurrentAndFocusedPage(clamped);
    this.pageViews[clamped - 1]?.wrapper.scrollIntoView({ behavior, block: "start", inline: this._scrollMode === "horizontal" ? "start" : "nearest" });
  }

  async goToDestination(dest: unknown): Promise<void> {
    const doc = this.pdfDoc;
    if (!doc) return;
    const resolved = await resolveDestination(doc, dest);
    if (!resolved || this.pdfDoc !== doc) return;

    const targetView = this.pageViews[resolved.page - 1];
    if (resolved.point && this._scrollMode === "vertical" && targetView && targetView.wrapper.offsetHeight > 0) {
      let vp = targetView.viewport;
      if (!vp) {
        const page = await doc.getPage(resolved.page);
        if (this.pdfDoc !== doc) return;
        vp = page.getViewport({ scale: this._scale, rotation: (page.rotate + this._rotation) % 360 });
      }
      const [, vy] = vp.convertToViewportPoint(resolved.point[0], resolved.point[1]);
      if (vy > vp.height * 0.15 && vy < vp.height) {
        this._setCurrentAndFocusedPage(resolved.page);
        this.scrollEl.scrollTo({
          top: Math.max(0, targetView.wrapper.offsetTop + vy - 16),
          behavior: "smooth",
        });
        return;
      }
    }

    this.goToPage(resolved.page);
  }

  executeNamedAction(action: string): void {
    if (!this.pdfDoc) return;
    switch (action) {
      case "FirstPage":
        this.goToPage(1);
        break;
      case "LastPage":
        this.goToPage(this._pageCount);
        break;
      case "NextPage":
        this.nextPage();
        break;
      case "PrevPage":
      case "PreviousPage":
        this.prevPage();
        break;
    }
  }

  nextPage(): void {
    const step = this.columnCount === 2 && this._shownEvenSpread && this._currentPage === 1 ? 1 : this.columnCount;
    const target = this._currentPage + step;
    if (target <= this._pageCount) { this.goToPage(target); return; }
    const el = this.scrollEl;
    if (this._scrollMode === "horizontal") el.scrollTo({ left: el.scrollWidth, behavior: "smooth" });
    else el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  prevPage(): void {
    const horizontal = this._scrollMode === "horizontal";
    const pos = horizontal ? this.scrollEl.scrollLeft : this.scrollEl.scrollTop;
    const startOf = (n: number): number => {
      const w = this.pageViews[n - 1]?.wrapper;
      return w ? (horizontal ? w.offsetLeft : w.offsetTop) : 0;
    };
    let target = this._currentPage - this.columnCount;
    while (target > 1 && startOf(target) >= pos - 1) target -= this.columnCount;
    this.goToPage(target);
  }

  async setScale(scale: number, anchor?: { x: number; y: number }): Promise<void> {
    const next = this.clampScale(scale);
    const spot = anchor ? this._spotAt(anchor) : null;
    const hadPreview = this._previewScale !== null;
    this._clearPreview();
    if (Math.abs(next - this._scale) < 1e-6 && !hadPreview) return;
    this._scale = next;
    this.reflow({ preserveScroll: Boolean(spot && anchor) });
    if (spot && anchor) {
      const r = this.pageViews[spot.page - 1]?.wrapper.getBoundingClientRect();
      if (r) {
        this.scrollEl.scrollLeft += r.left + spot.fx * r.width - anchor.x;
        this.scrollEl.scrollTop  += r.top  + spot.fy * r.height - anchor.y;
      }
      this._updateFocusedPage();
      this._renderVisible();
    }
  }

  clampScale(scale: number): number {
    return Math.max(MIN_SCALE * CSS_UNITS, Math.min(MAX_SCALE * CSS_UNITS, scale));
  }

  private _previewScale: number | null = null;

  get shownScale(): number { return this._previewScale ?? this._scale; }

  previewScale(scale: number, anchor: { x: number; y: number }): void {
    if (!this.pdfDoc) return;
    const next = this.clampScale(scale);
    const el = this.scrollEl;
    let p = this._preview;
    if (this._previewScale === null || !p) {
      this._renderQueue.clear();
      for (const view of this.pageViews) view.cancelRender();
      const rows = (Array.from(el.children) as HTMLElement[]).filter((r) => r.classList.contains("page-row"));
      const marker = document.createElement("div");
      marker.className = "zoom-preview-marker";
      marker.style.cssText = `position:absolute;width:1px;height:1px;left:${el.scrollWidth - 1}px;top:${el.scrollHeight - 1}px;pointer-events:none;visibility:hidden`;
      el.appendChild(marker);
      let widest = 0;
      for (const r of rows) {
        const pages = Array.from(r.children) as HTMLElement[];
        if (pages.length === 0) continue;
        widest = Math.max(widest, pages[pages.length - 1].offsetLeft + pages[pages.length - 1].offsetWidth - pages[0].offsetLeft);
      }
      p = this._preview = { rows: rows.map((r) => ({ el: r, x: r.offsetLeft, y: r.offsetTop })), marker, widest, tx: 0, ty: 0, z: 1 };
      for (const r of rows) r.style.transformOrigin = "0 0";
    }
    this._previewScale = next;
    const er = el.getBoundingClientRect();
    const z = next / this._scale;
    const ax = this._scrollMode !== "horizontal" && p.widest * z + 40 <= el.clientWidth ? er.left + el.clientLeft + el.clientWidth / 2 : anchor.x;
    const sx = el.scrollLeft + ax - er.left - el.clientLeft;
    const sy = el.scrollTop  + anchor.y - er.top  - el.clientTop;
    const cx = (sx - p.tx) / p.z;
    const cy = (sy - p.ty) / p.z;
    p.tx = sx - z * cx;
    p.ty = sy - z * cy;
    p.z = z;
    for (const r of p.rows) {
      r.el.style.transform = `translate(${p.tx + (z - 1) * r.x}px, ${p.ty + (z - 1) * r.y}px) scale(${z})`;
    }
  }

  private _preview: {
    rows: { el: HTMLElement; x: number; y: number }[];
    marker: HTMLElement;
    widest: number;
    tx: number; ty: number; z: number;
  } | null = null;

  private _clearPreview(): void {
    this._previewScale = null;
    const p = this._preview;
    if (!p) return;
    this._preview = null;
    for (const r of p.rows) { r.el.style.transform = ""; r.el.style.transformOrigin = ""; }
    p.marker.remove();
  }

  private _spotAt(at: { x: number; y: number }): { page: number; fx: number; fy: number } | null {
    let best: { page: number; fx: number; fy: number; d: number } | null = null;
    for (const view of this.pageViews) {
      const r = view.wrapper.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const dx = at.x < r.left ? r.left - at.x : at.x > r.right ? at.x - r.right : 0;
      const dy = at.y < r.top ? r.top - at.y : at.y > r.bottom ? at.y - r.bottom : 0;
      const d = dx + dy;
      if (!best || d < best.d) {
        best = { page: view.pageNum, fx: (at.x - r.left) / r.width, fy: (at.y - r.top) / r.height, d };
        if (d === 0) break;
      }
    }
    return best;
  }

  async rotate(): Promise<void> {
    this._rotation = (this._rotation + 90) % 360;
    this.reflow();
  }

  reflow(options?: { preserveScroll?: boolean }): void {
    const savedPage = this._focusedPage;
    this._pageOffsets = null;

    if (this.pdfDoc && this.pageViews.length === this._pageCount) {
      const swapped        = this._rotation % 180 !== 0;
      const containerWidth = Math.max(1, this.scrollEl.clientWidth - 40);
      const refW           = Math.max(...this.pageDimensions.map(d => swapped ? d.height : d.width)) * this._scale;
      const newCols        = this._columnsFor(containerWidth, refW);
      const nextEven       = newCols === 2 && this._evenSpread;
      const colsChanged    = newCols !== this.columnCount || nextEven !== this._shownEvenSpread;

      if (colsChanged) {
        this.columnCount = newCols;
        this._regroupRows(newCols);
      }

      const savedScroll = this.scrollEl.scrollTop;
      const savedScrollX = this.scrollEl.scrollLeft;
      let anySizeChanged = colsChanged;
      const dpr = window.devicePixelRatio || 1;
      for (const view of this.pageViews) {
        const dim = this.pageDimensions[view.pageNum - 1];
        if (dim) {
          const newW = Math.round((swapped ? dim.height : dim.width) * this._scale);
          const newH = Math.round((swapped ? dim.width  : dim.height) * this._scale);
          if (newW !== (parseInt(view.wrapper.style.width) || 0) ||
              newH !== (parseInt(view.wrapper.style.height) || 0)) anySizeChanged = true;
          const keepStretched = view.renderedRotation === this._rotation;
          view.setPlaceholderSize(newW, newH, keepStretched);
        }
        if (!view.isRenderedAt(this._scale, this._rotation, dpr)) {
          view.cancelRender();
          view.rendered = false;
        }
      }
      this._pageOffsets = null;
      this.onLayoutChangedCb?.(this.pageViews);
      if (!options?.preserveScroll) {
        if (anySizeChanged) {
          this.goToPage(savedPage, "instant");
        } else {
          this.scrollEl.scrollTop = savedScroll;
          this.scrollEl.scrollLeft = savedScrollX;
        }
        this._renderVisible();
      }
      return;
    }

    this.buildLayout();
    if (!options?.preserveScroll) {
      this.goToPage(savedPage, "instant");
    }
  }

  private _renderVisible(): void {
    this._renderQueue.clear();
    const scrollRect = this.scrollEl.getBoundingClientRect();
    const startIdx = Math.max(0, this._focusedPage - 7);
    const endIdx = Math.min(this.pageViews.length - 1, this._focusedPage + 6);
    for (let i = startIdx; i <= endIdx; i++) {
      const view = this.pageViews[i];
      if (view.rendered) continue;
      const r = view.wrapper.getBoundingClientRect();
      if (r.bottom > scrollRect.top - 300 && r.top < scrollRect.bottom + 300 &&
          r.right > scrollRect.left - 200 && r.left < scrollRect.right + 200) {
        this._queueRender(view);
      }
    }
    this._evictDistantPages();
    this._pumpRenderQueue();
  }

  restoreRotation(degrees: number): void {
    this._rotation = degrees;
  }

  private setupResizeObserver(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        if (this.onResizeCb) this.onResizeCb();
        else this.reflow();
      }, 100);
    });
    this.resizeObserver.observe(this.scrollEl);
  }

  async renderPageToFit(n: number, maxW: number, maxH: number): Promise<HTMLCanvasElement | null> {
    if (!this.pdfDoc || n < 1 || n > this.pdfDoc.numPages) return null;
    const page = await this.pdfDoc.getPage(n);
    const rotation = (page.rotate + this._rotation) % 360;
    const unit = page.getViewport({ scale: 1, rotation });
    const dpr = window.devicePixelRatio || 1;
    const fit = Math.min(maxW / unit.width, maxH / unit.height);
    const scale = Math.min(fit * dpr, Math.sqrt(40e6 / (unit.width * unit.height)));
    const viewport = page.getViewport({ scale, rotation });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    canvas.style.width = `${canvas.width / dpr}px`;
    canvas.style.height = `${canvas.height / dpr}px`;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas: ctx.canvas, viewport }).promise;
    return canvas;
  }

  async renderPagesForPrint(pageNumbers: number[], dpi = 200): Promise<string[]> {
    if (!this.pdfDoc) return [];
    return renderDocPages(this.pdfDoc, pageNumbers, dpi, this._rotation);
  }

  async renderFileForPrint(filePath: string, pageNumbers: number[], dpi = 200): Promise<string[]> {
    const doc = await (await pdfjsLib()).getDocument({ ...SAFE_PDF, url: convertFileSrc(filePath) + `?t=${Date.now()}` }).promise;
    try {
      return await renderDocPages(doc, pageNumbers, dpi, 0);
    } finally {
      await doc.loadingTask.destroy();
    }
  }

  async renderFilePages(
    filePath: string,
    pageNumbers: number[],
    dpi: number,
    type: "image/png" | "image/jpeg",
    onPage: (dataUrl: string, page: number) => Promise<void>,
  ): Promise<void> {
    const doc = await (await pdfjsLib()).getDocument({ ...SAFE_PDF, url: convertFileSrc(filePath) + `?t=${Date.now()}` }).promise;
    try {
      for (const n of pageNumbers) {
        if (n < 1 || n > doc.numPages) continue;
        const page = await doc.getPage(n);
        const unit = page.getViewport({ scale: 1, rotation: page.rotate });
        const scale = Math.min(dpi / 72, Math.sqrt(40e6 / (unit.width * unit.height)));
        const viewport = page.getViewport({ scale, rotation: page.rotate });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas: ctx.canvas, viewport }).promise;
        const data = canvas.toDataURL(type, 0.9);
        canvas.width = canvas.height = 0;
        page.cleanup();
        await onPage(data, n);
      }
    } finally {
      await doc.loadingTask.destroy();
    }
  }

  isLoaded(): boolean { return this.pdfDoc !== null; }

  async close(): Promise<void> {
    this._renderQueue.clear();
    this._updateRenderActivity();
    this.observer?.disconnect();
    this._visiblePages.clear();
    this._pageOffsets = null;
    if (this._scrollRaf) { cancelAnimationFrame(this._scrollRaf); this._scrollRaf = 0; }
    if (this._scrollHandler) { this.scrollEl.removeEventListener("scroll", this._scrollHandler); this._scrollHandler = null; }
    this.resizeObserver?.disconnect();
    for (const view of this.pageViews) view.destroy();
    this.scrollEl.innerHTML = "";
    this.pageViews = [];
    this._forgetActiveRenders();
    if (this.pdfDoc) {
      await this.pdfDoc.loadingTask.destroy();
      this.pdfDoc = null;
    }
    this._pageCount   = 0;
    this._currentPage = 1;
    this.pageDimensions = [];
  }

  async render(): Promise<void> {
    if (!this.pdfDoc) return;
    this.buildLayout();
  }

  async buildFormLayer(
    _container: HTMLElement,
    _storedValues: Map<string, string>,
    _onChange: (name: string, val: string) => void
  ): Promise<void> {}

  async getPageLinkAnnotations(): Promise<Array<{ url: string; rect: [number, number, number, number] }>> {
    return [];
  }
}

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
    await page.render({ canvas: ctx.canvas, viewport }).promise;
    results.push(canvas.toDataURL("image/jpeg", 0.92).split(",")[1]);
    canvas.width = canvas.height = 0;
    page.cleanup();
  }
  return results;
}

export async function renderRedactedPages(
  filePath: string,
  redactions: RedactAnnotation[],
  dpi = 300,
): Promise<RedactedPage[]> {
  const byPage = new Map<number, RedactAnnotation[]>();
  for (const r of redactions) byPage.set(r.page, [...(byPage.get(r.page) ?? []), r]);

  const doc = await (await pdfjsLib()).getDocument({ ...SAFE_PDF, url: convertFileSrc(filePath) + `?t=${Date.now()}` }).promise;
  try {
    const out: RedactedPage[] = [];
    for (const [pageNum, areas] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
      if (pageNum < 1 || pageNum > doc.numPages) continue;
      const page = await doc.getPage(pageNum);
      const unit  = page.getViewport({ scale: 1, rotation: 0 });
      const scale = Math.min(dpi / 72, Math.sqrt(40e6 / (unit.width * unit.height)));
      const viewport = page.getViewport({ scale, rotation: 0 });
      const canvas   = document.createElement("canvas");
      canvas.width   = Math.ceil(viewport.width);
      canvas.height  = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas: ctx.canvas, viewport }).promise;

      ctx.fillStyle = "#000";
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 2;
      for (const a of areas) {
        const [x1, y1] = viewport.convertToViewportPoint(a.x, a.y);
        const [x2, y2] = viewport.convertToViewportPoint(a.x + a.width, a.y + a.height);
        const shape = a.shape ?? "rect";
        if (shape === "rect" || ((shape === "lasso" || shape === "poly") && (a.points?.length ?? 0) < 3)) {
          const left = Math.floor(Math.min(x1, x2)) - 1, top = Math.floor(Math.min(y1, y2)) - 1;
          const right = Math.ceil(Math.max(x1, x2)) + 1, bottom = Math.ceil(Math.max(y1, y2)) + 1;
          ctx.fillRect(left, top, right - left, bottom - top);
          continue;
        }
        ctx.beginPath();
        if (shape === "ellipse") {
          ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
        } else {
          a.points!.forEach(([u, v], i) => {
            const [x, y] = viewport.convertToViewportPoint(a.x + u * a.width, a.y + v * a.height);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          });
          ctx.closePath();
        }
        ctx.fill();
        ctx.stroke();
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
    await doc.loadingTask.destroy();
  }
}

export async function renderWatermarkedPages(
  filePath: string,
  draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void,
  dpi = 300,
  onProgress?: (done: number, total: number) => void,
  pages?: number[],
): Promise<RedactedPage[]> {
  const doc = await (await pdfjsLib()).getDocument({ ...SAFE_PDF, url: convertFileSrc(filePath) + `?t=${Date.now()}` }).promise;
  try {
    const out: RedactedPage[] = [];
    const list = (pages ?? Array.from({ length: doc.numPages }, (_, i) => i + 1)).filter((n) => n >= 1 && n <= doc.numPages);
    for (const [i, pageNum] of list.entries()) {
      const page = await doc.getPage(pageNum);
      const canvas = await paintPage(page, dpi);
      draw(canvas.getContext("2d")!, canvas.width, canvas.height);
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
      onProgress?.(i + 1, list.length);
    }
    return out;
  } finally {
    await doc.loadingTask.destroy();
  }
}

export async function renderPagePreview(filePath: string, widthPx: number, pageNum = 1): Promise<HTMLCanvasElement> {
  const doc = await (await pdfjsLib()).getDocument({ ...SAFE_PDF, url: convertFileSrc(filePath) + `?t=${Date.now()}` }).promise;
  try {
    const page = await doc.getPage(Math.min(Math.max(1, pageNum), doc.numPages));
    const unit = page.getViewport({ scale: 1, rotation: 0 });
    const canvas = await paintPage(page, (widthPx / unit.width) * 72);
    page.cleanup();
    return canvas;
  } finally {
    await doc.loadingTask.destroy();
  }
}

async function paintPage(page: PDFPageProxy, dpi: number): Promise<HTMLCanvasElement> {
  const unit = page.getViewport({ scale: 1, rotation: 0 });
  const scale = Math.min(dpi / 72, Math.sqrt(40e6 / (unit.width * unit.height)));
  const viewport = page.getViewport({ scale, rotation: 0 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas: ctx.canvas, viewport }).promise;
  return canvas;
}

export async function renderStraightenedPages(
  filePath: string,
  items: { page: number; quad: [Point, Point, Point, Point] }[],
  dpi = 300,
): Promise<StraightenedPage[]> {
  const doc = await (await pdfjsLib()).getDocument({ ...SAFE_PDF, url: convertFileSrc(filePath) + `?t=${Date.now()}` }).promise;
  try {
    const out: StraightenedPage[] = [];
    for (const { page: pageNum, quad } of items) {
      if (pageNum < 1 || pageNum > doc.numPages) continue;
      const page = await doc.getPage(pageNum);
      const unit = page.getViewport({ scale: 1, rotation: 0 });
      const scale = Math.min(dpi / 72, Math.sqrt(40e6 / (unit.width * unit.height)));
      const shown = page.getViewport({ scale, rotation: page.rotate });
      const flat = page.getViewport({ scale, rotation: 0 });

      const src = document.createElement("canvas");
      src.width = Math.ceil(shown.width);
      src.height = Math.ceil(shown.height);
      const sctx = src.getContext("2d", { willReadFrequently: true })!;
      sctx.fillStyle = "#fff";
      sctx.fillRect(0, 0, src.width, src.height);
      await page.render({ canvas: sctx.canvas, viewport: shown }).promise;
      const pixels = sctx.getImageData(0, 0, src.width, src.height);
      const px = quad.map(([x, y]) => [x * src.width, y * src.height] as Point) as [Point, Point, Point, Point];
      const warped = warpToRect(pixels, px, src.width, src.height);
      sctx.putImageData(new ImageData(warped.data as Uint8ClampedArray<ArrayBuffer>, warped.width, warped.height), 0, 0);

      const dst = document.createElement("canvas");
      dst.width = Math.ceil(flat.width);
      dst.height = Math.ceil(flat.height);
      const dctx = dst.getContext("2d")!;
      dctx.fillStyle = "#fff";
      dctx.fillRect(0, 0, dst.width, dst.height);
      dctx.setTransform(...reproject(shown.transform, flat.transform));
      dctx.drawImage(src, 0, 0);

      const map = pageMap(shown.transform, quad, src.width, src.height);
      const content = await page.getTextContent();
      const text = moveTextRuns(content.items.filter((i): i is TextItem => "str" in i), map);

      const [v0, v1, v2, v3] = page.view;
      out.push({
        page: pageNum,
        jpegBase64: dst.toDataURL("image/jpeg", 0.9).split(",")[1],
        widthPx: dst.width,
        heightPx: dst.height,
        view: [v0, v1, v2, v3],
        map,
        text,
      });
      src.width = src.height = dst.width = dst.height = 0;
      page.cleanup();
    }
    return out;
  } finally {
    await doc.loadingTask.destroy();
  }
}
