import { Modal } from "./modal";
import { parsePageRange } from "./page-range";
import { ICON_EXPORT } from "./icons";

export type ExportFormat = "png" | "jpeg" | "pdf";

export type ExportRequest =
  | { kind: "pages"; format: ExportFormat; pages: number[]; dpi: number; annotations: boolean }
  | { kind: "images"; paths: string[] };

const DPIS: [number, "expDpiLight" | "expDpiScreen" | "expDpiPrint", string][] = [
  [96, "expDpiLight", "96 dpi · light"],
  [150, "expDpiScreen", "150 dpi · screen"],
  [300, "expDpiPrint", "300 dpi · print"],
];

/** File name of page `n` of `count` exported from `stem`: report-p01.png. */
export function pageFileName(stem: string, n: number, count: number, format: "png" | "jpeg"): string {
  const width = Math.max(2, String(count).length);
  return `${stem}-p${String(n).padStart(width, "0")}.${format === "jpeg" ? "jpg" : "png"}`;
}

/**
 * Export: this PDF to pictures (PNG / JPEG, one per page) or to a PDF copy,
 * with or without annotations; or pictures to a new PDF.
 */
export class ExportModal extends Modal {
  private tab: "pdf" | "images" = "pdf";
  private format: ExportFormat = "png";
  private dpi = 150;
  private pageCount = 0;
  private stem = "document";
  private images: string[] = [];
  private handlers: ((r: ExportRequest) => void)[] = [];
  private pickHandlers: (() => Promise<string[]>)[] = [];

  private tabBtns = new Map<"pdf" | "images", HTMLButtonElement>();
  private pdfPane: HTMLElement;
  private imagesPane: HTMLElement;
  private formatBtns = new Map<ExportFormat, HTMLButtonElement>();
  private pagesInput: HTMLInputElement;
  private dpiField: HTMLElement;
  private dpiSelect: HTMLSelectElement;
  private keep: HTMLInputElement;
  private summary: HTMLElement;
  private imageList: HTMLElement;

  constructor() {
    super("export-box", "expTitle", "Export", "expOk", "Export", ICON_EXPORT);

    const tabs = this.el("div", "toolbar-segment ez-tabs");
    for (const [tab, key, fb] of [["pdf", "expTabPdf", "This PDF to…"], ["images", "expTabImages", "Images to PDF"]] as const) {
      const b = this.el("button", "mode-btn", key, fb);
      b.type = "button";
      b.addEventListener("click", () => { this.tab = tab; this.refresh(); });
      this.tabBtns.set(tab, b);
      tabs.append(b);
    }

    // This PDF to…
    this.pdfPane = this.el("div", "ez-pane");
    const fmtLabel = this.el("span", "ez-label", "expFormat", "Format");
    const grid = this.el("div", "ez-grid3");
    for (const [f, label, sub, subKey] of [
      ["png", "PNG", "Lossless", "expPngSub"], ["jpeg", "JPEG", "Lighter", "expJpegSub"], ["pdf", "PDF", "Flattened copy", "expPdfSub"],
    ] as const) {
      const b = this.el("button", "ez-card ez-card-center");
      b.type = "button";
      b.append(this.el("b", "ez-card-label"), this.el("span", "ez-card-sub", subKey, sub));
      (b.firstChild as HTMLElement).textContent = label;
      b.addEventListener("click", () => { this.format = f; this.refresh(); });
      this.formatBtns.set(f, b);
      grid.append(b);
    }
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
    this.pdfPane.append(fmtLabel, grid, row, keep.row);

    // Images to PDF
    this.imagesPane = this.el("div", "ez-pane");
    const pick = this.el("button", "btn", "expPickImages", "Choose pictures…");
    pick.type = "button";
    pick.addEventListener("click", async () => {
      for (const h of this.pickHandlers) this.images.push(...await h());
      this.refresh();
    });
    this.imageList = this.el("div", "ez-filelist");
    this.imagesPane.append(this.el("span", "ez-card-sub", "expImagesHint", "Each picture becomes a page, in this order, fitted to A4."), pick, this.imageList);

    this.summary = this.el("div", "ez-summary");
    this.body.append(tabs, this.pdfPane, this.imagesPane, this.summary);
    this.okBtn.addEventListener("click", () => this.confirm());
  }

  onExport(cb: (r: ExportRequest) => void): void { this.handlers.push(cb); }
  /** How pictures are picked (the native dialog). */
  onPickImages(cb: () => Promise<string[]>): void { this.pickHandlers.push(cb); }

  /** Opens on `tab` ("This PDF to…" needs an open document of `pageCount` pages). */
  open(pageCount: number, stem: string, tab: "pdf" | "images"): void {
    this.pageCount = pageCount;
    this.stem = stem;
    this.pagesInput.value = "";
    this.images = [];
    this.tab = pageCount > 0 ? tab : "images";
    this.refresh();
    this.show();
  }

  private pages(): number[] | null {
    return parsePageRange(this.pagesInput.value, this.pageCount);
  }

  private confirm(): void {
    if (this.okBtn.disabled) return;
    let req: ExportRequest;
    if (this.tab === "images") {
      req = { kind: "images", paths: [...this.images] };
    } else {
      const pages = this.pages();
      if (!pages) return;
      req = { kind: "pages", format: this.format, pages, dpi: this.dpi, annotations: this.keep.checked };
    }
    this.close();
    for (const h of this.handlers) h(req);
  }

  protected override refresh(): void {
    if (!this.pagesInput) return;
    const hasDoc = this.pageCount > 0;
    this.tabBtns.get("pdf")!.disabled = !hasDoc;
    for (const [t, b] of this.tabBtns) {
      b.classList.toggle("active", t === this.tab);
      b.setAttribute("aria-pressed", String(t === this.tab));
    }
    this.pdfPane.hidden = this.tab !== "pdf";
    this.imagesPane.hidden = this.tab !== "images";
    for (const [f, b] of this.formatBtns) b.classList.toggle("active", f === this.format);
    this.dpiField.hidden = this.format === "pdf";
    this.dpiSelect.value = String(this.dpi);
    this.pagesInput.placeholder = this.tr("expAllPages", "All ({n})").replace("{n}", String(this.pageCount));

    this.summary.classList.remove("error");
    if (this.tab === "images") {
      this.imageList.replaceChildren(...this.images.map((p, i) => {
        const item = this.el("div", "ez-file");
        const name = this.el("span", "ez-file-name");
        name.textContent = p.split(/[\\/]/).pop() ?? p;
        name.title = p;
        const del = this.el("button", "icon-btn");
        del.type = "button";
        del.textContent = "×";
        del.title = this.tr("expRemoveImage", "Remove");
        del.setAttribute("aria-label", del.title);
        del.addEventListener("click", () => { this.images.splice(i, 1); this.refresh(); });
        item.append(name, del);
        return item;
      }));
      const n = this.images.length;
      this.summary.textContent = n === 0
        ? this.tr("expImagesNone", "No pictures yet.")
        : (n === 1 ? this.tr("expImagesOne", "1 picture → a PDF of 1 page.") : this.tr("expImagesMany", "{n} pictures → a PDF of {n} pages.").replaceAll("{n}", String(n)));
      this.okBtn.disabled = n === 0;
      return;
    }

    const pages = this.pages();
    if (!pages) {
      this.summary.textContent = this.tr("expBadPages", "Pages: type for example 1-3, 5 (the document has {n}).").replace("{n}", String(this.pageCount));
      this.summary.classList.add("error");
      this.okBtn.disabled = true;
      return;
    }
    this.okBtn.disabled = false;
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
