import { pdfjsLib } from "./pdfjs";
import { SAFE_PDF } from "./pdf-options";
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { RedactAnnotation } from "./models";
import type { RedactedPage, StraightenedPage } from "./tauri-bridge";
import { moveTextRuns, pageMap, reproject, warpToRect, type Point } from "./page-adjustment";

const MAX_CANVAS_PIXELS = 40e6;

export async function withPdfFile<T>(filePath: string, use: (doc: PDFDocumentProxy) => Promise<T>): Promise<T> {
  const doc = await (await pdfjsLib()).getDocument({ ...SAFE_PDF, url: convertFileSrc(filePath) + `?t=${Date.now()}` }).promise;
  try {
    return await use(doc);
  } finally {
    await doc.loadingTask.destroy();
  }
}

export function cappedScale(page: PDFPageProxy, dpi: number): number {
  const unit = page.getViewport({ scale: 1, rotation: 0 });
  return Math.min(dpi / 72, Math.sqrt(MAX_CANVAS_PIXELS / (unit.width * unit.height)));
}

async function paintOnWhite(page: PDFPageProxy, viewport: PageViewport, settings?: CanvasRenderingContext2DSettings): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d", settings)!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas: ctx.canvas, viewport }).promise;
  return canvas;
}

function bakedPage(pageNum: number, page: PDFPageProxy, canvas: HTMLCanvasElement): RedactedPage {
  const [v0, v1, v2, v3] = page.view;
  return {
    page: pageNum,
    jpegBase64: canvas.toDataURL("image/jpeg", 0.9).split(",")[1],
    widthPx: canvas.width,
    heightPx: canvas.height,
    view: [v0, v1, v2, v3],
  };
}

function inRange(doc: PDFDocumentProxy, pageNum: number): boolean {
  return pageNum >= 1 && pageNum <= doc.numPages;
}

export async function bakePages(
  filePath: string,
  pages: number[] | undefined,
  dpi: number,
  draw: (ctx: CanvasRenderingContext2D, viewport: PageViewport, pageNum: number) => void,
  onProgress?: (done: number, total: number) => void,
): Promise<RedactedPage[]> {
  return withPdfFile(filePath, async (doc) => {
    const out: RedactedPage[] = [];
    const list = (pages ?? Array.from({ length: doc.numPages }, (_, i) => i + 1)).filter((n) => inRange(doc, n));
    for (const [i, pageNum] of list.entries()) {
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale: cappedScale(page, dpi), rotation: 0 });
      const canvas = await paintOnWhite(page, viewport);
      draw(canvas.getContext("2d")!, viewport, pageNum);
      out.push(bakedPage(pageNum, page, canvas));
      canvas.width = canvas.height = 0;
      page.cleanup();
      onProgress?.(i + 1, list.length);
    }
    return out;
  });
}

function drawRedaction(ctx: CanvasRenderingContext2D, viewport: PageViewport, a: RedactAnnotation): void {
  const [x1, y1] = viewport.convertToViewportPoint(a.x, a.y);
  const [x2, y2] = viewport.convertToViewportPoint(a.x + a.width, a.y + a.height);
  const shape = a.shape ?? "rect";
  if (shape === "rect" || ((shape === "lasso" || shape === "poly") && (a.points?.length ?? 0) < 3)) {
    const left = Math.floor(Math.min(x1, x2)) - 1, top = Math.floor(Math.min(y1, y2)) - 1;
    const right = Math.ceil(Math.max(x1, x2)) + 1, bottom = Math.ceil(Math.max(y1, y2)) + 1;
    ctx.fillRect(left, top, right - left, bottom - top);
    return;
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

export function renderRedactedPages(filePath: string, redactions: RedactAnnotation[], dpi = 300): Promise<RedactedPage[]> {
  const byPage = new Map<number, RedactAnnotation[]>();
  for (const r of redactions) byPage.set(r.page, [...(byPage.get(r.page) ?? []), r]);
  const pages = [...byPage.keys()].sort((a, b) => a - b);
  return bakePages(filePath, pages, dpi, (ctx, viewport, pageNum) => {
    ctx.fillStyle = "#000";
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 2;
    for (const area of byPage.get(pageNum)!) drawRedaction(ctx, viewport, area);
  });
}

export function renderWatermarkedPages(
  filePath: string,
  draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void,
  dpi = 300,
  onProgress?: (done: number, total: number) => void,
  pages?: number[],
): Promise<RedactedPage[]> {
  return bakePages(filePath, pages, dpi, (ctx) => draw(ctx, ctx.canvas.width, ctx.canvas.height), onProgress);
}

export function renderPagePreview(filePath: string, widthPx: number, pageNum = 1): Promise<HTMLCanvasElement> {
  return withPdfFile(filePath, async (doc) => {
    const page = await doc.getPage(Math.min(Math.max(1, pageNum), doc.numPages));
    const unit = page.getViewport({ scale: 1, rotation: 0 });
    const dpi = (widthPx / unit.width) * 72;
    const canvas = await paintOnWhite(page, page.getViewport({ scale: cappedScale(page, dpi), rotation: 0 }));
    page.cleanup();
    return canvas;
  });
}

export function renderStraightenedPages(
  filePath: string,
  items: { page: number; quad: [Point, Point, Point, Point] }[],
  dpi = 300,
): Promise<StraightenedPage[]> {
  return withPdfFile(filePath, async (doc) => {
    const out: StraightenedPage[] = [];
    for (const { page: pageNum, quad } of items) {
      if (!inRange(doc, pageNum)) continue;
      const page = await doc.getPage(pageNum);
      const scale = cappedScale(page, dpi);
      const shown = page.getViewport({ scale, rotation: page.rotate });
      const flat = page.getViewport({ scale, rotation: 0 });

      const src = await paintOnWhite(page, shown, { willReadFrequently: true });
      const sctx = src.getContext("2d", { willReadFrequently: true })!;
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

      out.push({ ...bakedPage(pageNum, page, dst), map, text });
      src.width = src.height = dst.width = dst.height = 0;
      page.cleanup();
    }
    return out;
  });
}

export function renderPagesForPrint(doc: PDFDocumentProxy, pageNumbers: number[], dpi: number, extraRotation: number): Promise<string[]> {
  return collectPages(doc, pageNumbers, async (page) => {
    const viewport = page.getViewport({ scale: dpi / 72, rotation: (page.rotate + extraRotation) % 360 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d")!;
    await page.render({ canvas: ctx.canvas, viewport }).promise;
    const data = canvas.toDataURL("image/jpeg", 0.92).split(",")[1];
    canvas.width = canvas.height = 0;
    return data;
  });
}

export function renderFileForPrint(filePath: string, pageNumbers: number[], dpi: number): Promise<string[]> {
  return withPdfFile(filePath, (doc) => renderPagesForPrint(doc, pageNumbers, dpi, 0));
}

export function renderFilePages(
  filePath: string,
  pageNumbers: number[],
  dpi: number,
  type: "image/png" | "image/jpeg",
  onPage: (dataUrl: string, page: number) => Promise<void>,
): Promise<void> {
  return withPdfFile(filePath, async (doc) => {
    await collectPages(doc, pageNumbers, async (page, n) => {
      const canvas = await paintOnWhite(page, page.getViewport({ scale: cappedScale(page, dpi), rotation: page.rotate }));
      const data = canvas.toDataURL(type, 0.9);
      canvas.width = canvas.height = 0;
      await onPage(data, n);
    });
  });
}

async function collectPages<T>(doc: PDFDocumentProxy, pageNumbers: number[], each: (page: PDFPageProxy, pageNum: number) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (const n of pageNumbers) {
    if (!inRange(doc, n)) continue;
    const page = await doc.getPage(n);
    out.push(await each(page, n));
    page.cleanup();
  }
  return out;
}
