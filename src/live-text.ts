import type { PDFPageProxy } from "pdfjs-dist";
import type { OcrResult } from "./ocr-modal";

const MIN_TEXT_CHARS = 8;
const OCR_LONG_SIDE = 2400;

export function hasRealText(items: readonly unknown[]): boolean {
  let n = 0;
  for (const it of items) {
    const s = (it as { str?: unknown }).str;
    if (typeof s !== "string") continue;
    n += s.replace(/\s+/g, "").length;
    if (n >= MIN_TEXT_CHARS) return true;
  }
  return false;
}

export interface PlacedWord {
  text: string;
  margin: number;
  scaleX: number;
  dy: number;
}

export interface PlacedLine {
  left: number;
  top: number;
  fontSize: number;
  words: PlacedWord[];
}

export function layoutOcr(
  result: OcrResult,
  width: number,
  height: number,
  measure: (text: string, fontSize: number) => number,
): PlacedLine[] {
  const out: PlacedLine[] = [];
  for (const line of result.lines) {
    const words = line.words.filter((w) => w.text.trim() && w.w > 0 && w.h > 0);
    if (words.length === 0) continue;
    words.sort((a, b) => a.x - b.x);
    const left = words[0].x * width;
    const top = Math.min(...words.map((w) => w.y)) * height;
    const fontSize = Math.max(...words.map((w) => w.h)) * height;
    if (fontSize < 2) continue;
    const placed: PlacedWord[] = [];
    let cursor = left;
    words.forEach((w, i) => {
      const last = i === words.length - 1;
      const text = last ? w.text : `${w.text} `;
      const natural = measure(text, fontSize);
      const bare = last ? natural : measure(w.text, fontSize);
      const target = w.w * width;
      const scaleX = bare > 0.5 ? target / bare : 1;
      const x = w.x * width;
      placed.push({ text, margin: x - cursor, scaleX, dy: w.y * height - top });
      cursor = x + natural;
    });
    out.push({ left, top, fontSize, words: placed });
  }
  return out;
}

export function renderOcrLayer(layer: HTMLElement, lines: PlacedLine[]): void {
  const frag = document.createDocumentFragment();
  for (const line of lines) {
    const el = document.createElement("span");
    el.className = "ocr-line";
    el.style.left = `${line.left}px`;
    el.style.top = `${line.top}px`;
    el.style.fontSize = `${line.fontSize}px`;
    for (const w of line.words) {
      const word = document.createElement("span");
      word.textContent = w.text;
      if (Math.abs(w.margin) > 0.05) word.style.marginLeft = `${w.margin}px`;
      const t: string[] = [];
      if (Math.abs(w.dy) > 0.5) t.push(`translateY(${w.dy}px)`);
      if (Math.abs(w.scaleX - 1) > 0.01) t.push(`scaleX(${w.scaleX})`);
      if (t.length) word.style.transform = t.join(" ");
      el.appendChild(word);
    }
    if (frag.childNodes.length) frag.appendChild(Object.assign(document.createElement("br"), { className: "ocr-br" }));
    frag.appendChild(el);
  }
  layer.querySelectorAll(":scope > .ocr-line, :scope > br.ocr-br").forEach((e) => e.remove());
  layer.appendChild(frag);
  layer.classList.toggle("has-ocr", lines.length > 0);
}

export type Recognizer = (data: string, language: string) => Promise<OcrResult>;

export class LiveText {
  private cache = new Map<string, Promise<OcrResult | null>>();
  private queue: { key: string; run: () => Promise<OcrResult | null>; resolve: (r: OcrResult | null) => void; wanted: () => boolean }[] = [];
  private busy = false;
  private unavailable = false;
  private doc = 0;

  constructor(private recognize: Recognizer | null, private language: () => string = () => "") {}

  setRecognizer(fn: Recognizer | null): void { this.recognize = fn; }

  reset(): void {
    this.doc++;
    this.cache.clear();
    for (const q of this.queue) q.resolve(null);
    this.queue = [];
  }

  read(page: PDFPageProxy, rotation: number, wanted: () => boolean): Promise<OcrResult | null> {
    if (!this.recognize || this.unavailable) return Promise.resolve(null);
    const key = `${this.doc}:${page.pageNumber}:${rotation}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const p = new Promise<OcrResult | null>((resolve) => {
      this.queue.unshift({ key, run: () => this.run(page, rotation), resolve, wanted });
    });
    this.cache.set(key, p);
    void this.pump();
    return p;
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      let job;
      while ((job = this.queue.shift())) {
        if (!job.wanted()) {
          this.cache.delete(job.key);
          job.resolve(null);
          continue;
        }
        const doc = this.doc;
        let result: OcrResult | null = null;
        try {
          result = await job.run();
        } catch (err) {
          if (String((err as { code?: unknown })?.code ?? err).includes("ocr-language")) this.unavailable = true;
          else this.cache.delete(job.key);
        }
        job.resolve(doc === this.doc ? result : null);
      }
    } finally {
      this.busy = false;
    }
  }

  private async run(page: PDFPageProxy, rotation: number): Promise<OcrResult | null> {
    const unit = page.getViewport({ scale: 1, rotation });
    const scale = Math.min(4, OCR_LONG_SIDE / Math.max(unit.width, unit.height));
    const viewport = page.getViewport({ scale, rotation });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas: ctx.canvas, viewport }).promise;
    const data = canvas.toDataURL("image/jpeg", 0.92);
    canvas.width = canvas.height = 0;
    return this.recognize ? this.recognize(data, this.language()) : null;
  }
}
