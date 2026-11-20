import { Modal } from "./modal";
import { parsePageRange } from "./page-range";
import { ICON_EXPORT } from "./icons";
import type { Key } from "./modal";

export type DocFormat = "docx" | "xlsx" | "rtf" | "html" | "txt" | "xml";
export type ExportFormat = "png" | "jpeg" | "pdf" | DocFormat;

export const DOC_FORMATS: readonly DocFormat[] = ["docx", "xlsx", "rtf", "html", "txt", "xml"];

export function isDocFormat(f: ExportFormat): f is DocFormat {
  return (DOC_FORMATS as readonly string[]).includes(f);
}

export function docFileName(stem: string, format: DocFormat): string {
  return `${stem}.${format}`;
}

const DOC_KIND: Record<DocFormat, string> = { docx: "Word", xlsx: "Excel", rtf: "RTF", html: "HTML", txt: "Text", xml: "XML" };

export type ExportRequest = { kind: "pages"; format: ExportFormat; pages: number[]; dpi: number; annotations: boolean };

const DPIS: [number, "expDpiLight" | "expDpiScreen" | "expDpiPrint", string][] = [
  [96, "expDpiLight", "96 dpi · light"],
  [150, "expDpiScreen", "150 dpi · screen"],
  [300, "expDpiPrint", "300 dpi · print"],
];

export function pageFileName(stem: string, n: number, count: number, format: "png" | "jpeg"): string {
  const width = Math.max(2, String(count).length);
  return `${stem}-p${String(n).padStart(width, "0")}.${format === "jpeg" ? "jpg" : "png"}`;
}

export class ExportModal extends Modal {
  private format: ExportFormat = "png";
  private dpi = 300;
  private pageCount = 0;
  private stem = "document";
  private handlers: ((r: ExportRequest) => void)[] = [];

  private pdfPane: HTMLElement;
  private formatBtns = new Map<ExportFormat, HTMLButtonElement>();
  private pagesInput: HTMLInputElement;
  private dpiField: HTMLElement;
  private dpiSelect: HTMLSelectElement;
  private keep: HTMLInputElement;
  private keepRow: HTMLElement;
  private summary: HTMLElement;

  constructor() {
    super("export-box", "expTitle", "Export & convert", "expOk", "Export", ICON_EXPORT);

    this.pdfPane = this.el("div", "ez-pane");
    const fmtLabel = this.el("span", "ez-label", "expPictures", "Pictures & PDF");
    const grid = this.el("div", "ez-grid3");
    const card = (f: ExportFormat, label: string, sub: string, subKey: Key, labelKey?: Key): HTMLButtonElement => {
      const b = this.el("button", "ez-card ez-card-center");
      b.type = "button";
      const name = this.el("b", "ez-card-label");
      if (labelKey) this.text(name, labelKey, label); else name.textContent = label;
      b.append(name, this.el("span", "ez-card-sub", subKey, sub));
      b.addEventListener("click", () => { this.format = f; this.refresh(); });
      this.formatBtns.set(f, b);
      return b;
    };
    grid.append(
      card("png", "PNG", "Lossless", "expPngSub"),
      card("jpeg", "JPEG", "Lighter", "expJpegSub"),
      card("pdf", "PDF", "Flattened copy", "expPdfSub"),
    );
    const docLabel = this.el("span", "ez-label", "expDocuments", "Editable text");
    const docGrid = this.el("div", "ez-grid3");
    docGrid.append(
      card("docx", "Word", "Document .docx", "expDocxSub"),
      card("xlsx", "Excel", "Tables .xlsx", "expXlsxSub"),
      card("rtf", "RTF", "Rich text", "expRtfSub"),
      card("html", "HTML", "Web page", "expHtmlSub"),
      card("txt", "Text", "Plain text", "expTxtSub", "expTextLabel"),
      card("xml", "XML", "Structured data", "expXmlSub"),
    );
    const row = this.el("div", "ez-row2");
    const pagesField = this.el("label", "ez-field");
    pagesField.append(this.el("span", "ez-label", "expPages", "Pages"));
    this.pagesInput = this.el("input", "ez-input");
    this.pagesInput.type = "text";
    this.pagesInput.addEventListener("input", () => this.refresh());
    this.pagesInput.addEventListener("keydown", (e) => { if (e.key === "Enter") this.confirm(); });
    pagesField.append(this.pagesInput);
    this.dpiField = this.el("label", "ez-field");
    this.dpiField.append(this.el("span", "ez-label", "expResolution", "Resolution"));
    this.dpiSelect = this.el("select", "ez-input");
    for (const [dpi, key, fb] of DPIS) {
      const o = this.el("option", "", key, fb);
      o.value = String(dpi);
      this.dpiSelect.append(o);
    }
    this.dpiSelect.addEventListener("change", () => { this.dpi = Number(this.dpiSelect.value); this.refresh(); });
    this.dpiField.append(this.dpiSelect);
    row.append(pagesField, this.dpiField);
    const keep = this.check("expKeepAnn", "Keep annotations", "expKeepAnnSub", "Highlights, sticky notes, drawings, signatures and stamps");
    this.keep = keep.input;
    this.keep.checked = true;
    this.keep.addEventListener("change", () => this.refresh());
    this.keepRow = keep.row;
    this.pdfPane.append(fmtLabel, grid, docLabel, docGrid, row, keep.row);

    this.summary = this.el("div", "ez-summary");
    this.body.append(this.pdfPane, this.summary);
    this.okBtn.addEventListener("click", () => this.confirm());
  }

  onExport(cb: (r: ExportRequest) => void): void { this.handlers.push(cb); }

  open(pageCount: number, stem: string): void {
    this.pageCount = pageCount;
    this.stem = stem;
    this.pagesInput.value = "";
    this.refresh();
    this.show();
  }

  private pages(): number[] | null {
    return parsePageRange(this.pagesInput.value, this.pageCount);
  }

  private confirm(): void {
    if (this.okBtn.disabled) return;
    const pages = this.pages();
    if (!pages) return;
    const req: ExportRequest = { kind: "pages", format: this.format, pages, dpi: this.dpi, annotations: this.keep.checked && !isDocFormat(this.format) };
    this.close();
    for (const h of this.handlers) h(req);
  }

  protected override refresh(): void {
    if (!this.pagesInput) return;
    for (const [f, b] of this.formatBtns) b.classList.toggle("active", f === this.format);
    const doc = isDocFormat(this.format);
    this.dpiField.hidden = this.format === "pdf" || doc;
    this.keepRow.hidden = doc;
    this.dpiSelect.value = String(this.dpi);
    this.pagesInput.placeholder = this.tr("expAllPages", "All ({n})").replace("{n}", String(this.pageCount));

    this.summary.classList.remove("error");
    const pages = this.pages();
    if (!pages) {
      this.summary.textContent = this.tr("expBadPages", "Pages: type for example 1-3, 5 (the document has {n}).").replace("{n}", String(this.pageCount));
      this.summary.classList.add("error");
      this.okBtn.disabled = true;
      return;
    }
    this.okBtn.disabled = false;
    if (isDocFormat(this.format)) {
      const line = this.tr("expDocSummary", "1 {kind} file ({name}) with the text of {n} page(s).")
        .replace("{kind}", this.format === "txt" ? this.tr("expTextLabel", "Text") : DOC_KIND[this.format])
        .replace("{name}", docFileName(this.stem, this.format)).replace("{n}", String(pages.length));
      this.summary.textContent = `${line} ${this.tr("expDocNote", "Text, titles and tables only: pictures and the exact layout are not kept.")}`;
      return;
    }
    const ann = this.keep.checked ? this.tr("expWithAnn", "Annotations are included.") : this.tr("expWithoutAnn", "Without annotations.");
    if (this.format === "pdf") {
      this.summary.textContent = `${this.tr("expPdfSummary", "1 PDF file with {n} page(s).").replace("{n}", String(pages.length))} ${ann}`;
      return;
    }
    const first = pageFileName(this.stem, pages[0], this.pageCount, this.format);
    const last = pageFileName(this.stem, pages[pages.length - 1], this.pageCount, this.format);
    const names = pages.length === 1 ? first : `${first} … ${last}`;
    const kind = this.format === "png" ? "PNG" : "JPEG";
    const line = (pages.length === 1 ? this.tr("expImgSummaryOne", "1 {kind} file ({names}) at {dpi} dpi.") : this.tr("expImgSummaryMany", "{n} {kind} files ({names}) at {dpi} dpi."))
      .replace("{n}", String(pages.length)).replace("{kind}", kind).replace("{names}", names).replace("{dpi}", String(this.dpi));
    this.summary.textContent = `${line} ${ann}`;
  }
}
