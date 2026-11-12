import { PDFDateString } from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { Translations } from "./i18n";

/** Named paper sizes, in points (portrait). */
const PAPER_SIZES: { name: string; w: number; h: number }[] = [
  { name: "A3", w: 841.89, h: 1190.55 },
  { name: "A4", w: 595.28, h: 841.89 },
  { name: "A5", w: 419.53, h: 595.28 },
  { name: "Letter", w: 612, h: 792 },
  { name: "Legal", w: 612, h: 1008 },
  { name: "Tabloid", w: 792, h: 1224 },
];

const ptToCm = (pt: number) => (pt * 2.54) / 72;

/** "21,0 × 29,7 cm (A4)" in the UI language. Exported for tests. */
export function formatPageSize(wPt: number, hPt: number, lang: string): string {
  const nf = new Intl.NumberFormat(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const [a, b] = [Math.min(wPt, hPt), Math.max(wPt, hPt)];
  const named = PAPER_SIZES.find(p => Math.abs(p.w - a) < 2 && Math.abs(p.h - b) < 2);
  const size = `${nf.format(ptToCm(wPt))} × ${nf.format(ptToCm(hPt))} cm`;
  return named ? `${size} (${named.name})` : size;
}

/** Formats a PDF date string ("D:20240131120000+01'00'") in the UI language. */
export function formatPdfDate(raw: unknown, lang: string): string | null {
  if (typeof raw !== "string" || !raw) return null;
  const d = PDFDateString.toDateObject(raw);
  if (!d || Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(lang, { dateStyle: "long", timeStyle: "short" }).format(d);
}

interface PdfInfo {
  PDFFormatVersion?: string;
  Title?: string;
  Author?: string;
  Subject?: string;
  Keywords?: string;
  Producer?: string;
  Creator?: string;
  CreationDate?: string;
  ModDate?: string;
}

const ICON_CLOSE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`;

/** Right-hand drawer with the document metadata, like the Preview inspector. */
export class InfoPanel {
  private el: HTMLElement;
  private body: HTMLElement;
  private titleEl: HTMLElement;
  private _open = false;
  private renderToken = 0;
  onClose: (() => void) | null = null;

  constructor(host: HTMLElement) {
    this.el = document.createElement("aside");
    this.el.className = "info-panel hidden";
    this.el.setAttribute("aria-hidden", "true");

    const head = document.createElement("div");
    head.className = "info-head";
    this.titleEl = document.createElement("h2");
    this.titleEl.className = "info-title";
    const close = document.createElement("button");
    close.className = "icon-btn info-close";
    close.innerHTML = ICON_CLOSE;
    close.addEventListener("click", () => { this.close(); this.onClose?.(); });
    head.append(this.titleEl, close);

    this.body = document.createElement("dl");
    this.body.className = "info-list";
    this.el.append(head, this.body);
    host.append(this.el);
  }

  get isOpen(): boolean { return this._open; }

  close(): void {
    this._open = false;
    this.el.classList.add("hidden");
    this.el.setAttribute("aria-hidden", "true");
  }

  /** Opens the panel (or refreshes it if already open) for `doc`. */
  async show(doc: PDFDocumentProxy, fileName: string, t: Translations, lang: string): Promise<void> {
    this._open = true;
    const bar = document.getElementById("toolbar-container");
    if (bar) this.el.style.setProperty("--info-top", `${Math.round(bar.getBoundingClientRect().bottom) + 12}px`);
    this.el.classList.remove("hidden");
    this.el.setAttribute("aria-hidden", "false");
    this.titleEl.textContent = t.infoTitle ?? "Document info";

    const token = ++this.renderToken;
    const [meta, page] = await Promise.all([
      doc.getMetadata().catch(() => null),
      doc.getPage(1).catch(() => null),
    ]);
    if (token !== this.renderToken) return;

    const info = (meta?.info ?? {}) as PdfInfo;
    let size: string | null = null;
    if (page) {
      const [x0, y0, x1, y1] = page.view;
      const rotated = page.rotate % 180 !== 0;
      const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
      size = formatPageSize(rotated ? h : w, rotated ? w : h, lang);
    }
    const clean = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

    const rows: [string, string | null][] = [
      [t.infoFileName ?? "File name", fileName],
      [t.infoKind ?? "Kind", t.infoKindPdf ?? "PDF document"],
      [t.infoVersion ?? "PDF version", clean(info.PDFFormatVersion)],
      [t.infoPages ?? "Pages", String(doc.numPages)],
      [t.infoPageSize ?? "Page size", size],
      [t.infoDocTitle ?? "Title", clean(info.Title)],
      [t.infoAuthor ?? "Author", clean(info.Author)],
      [t.infoSubject ?? "Subject", clean(info.Subject)],
      [t.infoKeywords ?? "Keywords", clean(info.Keywords)],
      [t.infoProducer ?? "PDF producer", clean(info.Producer)],
      [t.infoCreator ?? "Content creator", clean(info.Creator)],
      [t.infoCreated ?? "Created", formatPdfDate(info.CreationDate, lang)],
      [t.infoModified ?? "Modified", formatPdfDate(info.ModDate, lang)],
    ];

    this.body.replaceChildren();
    for (const [label, value] of rows) {
      if (value == null) continue;
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      dd.title = value;
      this.body.append(dt, dd);
    }
  }
}
