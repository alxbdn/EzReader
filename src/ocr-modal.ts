import { Modal } from "./modal";
import { ICON_OCR, ICON_PAGE_DOWN, ICON_PAGE_UP } from "./icons";

export interface OcrWord { text: string; x: number; y: number; w: number; h: number }
export interface OcrLine { text: string; words: OcrWord[] }
export interface OcrResult { text: string; lines: OcrLine[]; language: string }
export interface OcrLanguage { tag: string; name: string }

/** What the OCR dialog needs from the app. */
export interface OcrDeps {
  /** Pages of the open document (0 when none is open). */
  pageCount(): number;
  currentPage(): number;
  /** The document as it is now; called once each time the dialog opens. */
  materialize(): Promise<string>;
  /** Page `n` of `path` as a PNG data URL, sharp enough to read. */
  renderPage(path: string, n: number): Promise<string>;
  languages(): Promise<OcrLanguage[]>;
  recognize(data: string, language: string): Promise<OcrResult>;
  /** Lets the user pick a picture; its data URL and file name, or null. */
  pickPicture(): Promise<{ dataUrl: string; name: string } | null>;
  copy(text: string): Promise<void>;
  errText(err: unknown): string;
}

const LANG_KEY = "ezreader.ocrLanguage";

function savedLanguage(): string {
  try { return localStorage.getItem(LANG_KEY) ?? ""; } catch { return ""; }
}

/** Joins per-page texts, with a heading per page when there are several. */
export function joinPages(pages: [number, string][]): string {
  if (pages.length === 1) return pages[0][1];
  return pages.map(([n, t]) => `— ${n} —\n${t}`).join("\n\n");
}

/**
 * "Recognize text": the page (or a picture) on the left with the words
 * found outlined, the text on the right, ready to copy. Reading is done by
 * the OCR engine built into Windows.
 */
export class OcrModal extends Modal {
  private source: { kind: "pdf"; path: Promise<string> } | { kind: "picture"; dataUrl: string; name: string } | null = null;
  private page = 1;
  private pageCount = 0;
  private language = savedLanguage();
  private results = new Map<string, OcrResult>();
  private images = new Map<number, string>();
  private run = 0;
  private busy = false;

  private nav: HTMLElement;
  private prevBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
  private pageLabel: HTMLElement;
  private langSelect: HTMLSelectElement;
  private allBtn: HTMLButtonElement;
  private preview: HTMLElement;
  private img: HTMLImageElement;
  private boxes: HTMLElement;
  private textArea: HTMLTextAreaElement;
  private status: HTMLElement;

  constructor(private d: OcrDeps) {
    super("ocr-box", "ocrTitle", "Recognize text (OCR)", "ocrCopy", "Copy text", ICON_OCR);
    this.text(this.cancelBtn, "dlgClose", "Close");

    const bar = this.el("div", "ocr-bar");
    this.nav = this.el("div", "ocr-nav");
    this.prevBtn = this.el("button", "icon-btn");
    this.prevBtn.type = "button";
    this.prevBtn.innerHTML = ICON_PAGE_UP;
    this.title(this.prevBtn, "ttPagePrev", "Previous page");
    this.prevBtn.addEventListener("click", () => this.go(this.page - 1));
    this.nextBtn = this.el("button", "icon-btn");
    this.nextBtn.type = "button";
    this.nextBtn.innerHTML = ICON_PAGE_DOWN;
    this.title(this.nextBtn, "ttPageNext", "Next page");
    this.nextBtn.addEventListener("click", () => this.go(this.page + 1));
    this.pageLabel = this.el("span", "ocr-page");
    this.nav.append(this.prevBtn, this.pageLabel, this.nextBtn);

    this.langSelect = this.el("select", "ez-input ocr-lang");
    this.title(this.langSelect, "ocrLanguage", "Language of the text");
    this.langSelect.addEventListener("change", () => {
      this.language = this.langSelect.value;
      try { localStorage.setItem(LANG_KEY, this.language); } catch { /* not kept */ }
      this.results.clear();
      void this.showPage();
    });

    const picture = this.el("button", "btn", "ocrPicture", "Open a picture…");
    picture.type = "button";
    picture.addEventListener("click", () => void this.openPicture());
    this.allBtn = this.el("button", "btn", "ocrAllPages", "All pages");
    this.allBtn.type = "button";
    this.allBtn.addEventListener("click", () => void this.readAll());
    bar.append(this.nav, this.langSelect, this.el("span", "ocr-spacer"), picture, this.allBtn);

    const panes = this.el("div", "ocr-panes");
    this.preview = this.el("div", "ocr-preview");
    const frame = this.el("div", "ocr-frame");
    this.img = this.el("img", "ocr-img");
    this.img.alt = "";
    this.boxes = this.el("div", "ocr-boxes");
    frame.append(this.img, this.boxes);
    this.preview.append(frame);
    this.textArea = this.el("textarea", "ez-input ocr-text");
    this.textArea.spellcheck = false;
    this.textArea.addEventListener("input", () => this.refresh());
    panes.append(this.preview, this.textArea);

    this.status = this.el("div", "ocr-status");
    this.body.append(bar, panes, this.status);
    this.okBtn.addEventListener("click", () => void this.copyText());
  }

  /** Opens on the current page of the open document, or empty for a picture. */
  open(): void {
    this.run++;
    this.results.clear();
    this.images.clear();
    this.pageCount = this.d.pageCount();
    this.page = Math.min(Math.max(1, this.d.currentPage()), Math.max(1, this.pageCount));
    this.source = this.pageCount > 0 ? { kind: "pdf", path: this.d.materialize() } : null;
    if (this.source) this.source.path.catch(() => { /* reported when the page is shown */ });
    this.textArea.value = "";
    this.img.removeAttribute("src");
    this.boxes.replaceChildren();
    this.setStatus(this.source ? "" : this.tr("ocrPickHint", "Open a picture (a photo or a scan) to read its text."));
    this.show();
    void this.loadLanguages();
    if (this.source) void this.showPage();
    this.refresh();
  }

  private async loadLanguages(): Promise<void> {
    let langs: OcrLanguage[] = [];
    try { langs = await this.d.languages(); } catch { /* the select keeps "Automatic" */ }
    const auto = this.el("option", "", "ocrAuto", "Automatic");
    auto.value = "";
    this.langSelect.replaceChildren(auto, ...langs.map((l) => {
      const o = this.el("option");
      o.value = l.tag;
      o.textContent = l.name || l.tag;
      return o;
    }));
    if (!langs.some((l) => l.tag === this.language)) this.language = "";
    this.langSelect.value = this.language;
  }

  private key(page: number): string { return `${this.source?.kind === "picture" ? "pic" : page}|${this.language}`; }

  private go(page: number): void {
    if (this.busy || page < 1 || page > this.pageCount) return;
    this.page = page;
    void this.showPage();
  }

  private async openPicture(): Promise<void> {
    if (this.busy) return;
    let picked: { dataUrl: string; name: string } | null = null;
    try { picked = await this.d.pickPicture(); } catch (err) { this.setStatus(this.d.errText(err), true); return; }
    if (!picked) return;
    this.run++;
    this.source = { kind: "picture", ...picked };
    this.results.clear();
    this.pageCount = 0;
    await this.showPage();
  }

  /** Image of what is shown: the picture, or the page rendered once. */
  private async imageOf(page: number): Promise<string> {
    const src = this.source!;
    if (src.kind === "picture") return src.dataUrl;
    const cached = this.images.get(page);
    if (cached) return cached;
    const data = await this.d.renderPage(await src.path, page);
    this.images.set(page, data);
    return data;
  }

  private async recognize(page: number): Promise<OcrResult> {
    const key = this.key(page);
    const hit = this.results.get(key);
    if (hit) return hit;
    const r = await this.d.recognize(await this.imageOf(page), this.language);
    this.results.set(key, r);
    return r;
  }

  private async showPage(): Promise<void> {
    if (!this.source) return;
    const run = ++this.run;
    this.busy = true;
    this.refresh();
    this.setStatus(this.tr("ocrReading", "Reading the text…"));
    try {
      const image = await this.imageOf(this.page);
      if (run !== this.run) return;
      this.img.src = image;
      this.boxes.replaceChildren();
      const r = await this.recognize(this.page);
      if (run !== this.run) return;
      this.showResult(r);
    } catch (err) {
      if (run === this.run) this.setStatus(this.d.errText(err), true);
    } finally {
      if (run === this.run) { this.busy = false; this.refresh(); }
    }
  }

  private showResult(r: OcrResult): void {
    this.textArea.value = r.text;
    this.boxes.replaceChildren(...r.lines.flatMap((l) => l.words).map((w) => {
      const b = document.createElement("div");
      b.className = "ocr-word";
      b.style.left = `${w.x * 100}%`;
      b.style.top = `${w.y * 100}%`;
      b.style.width = `${w.w * 100}%`;
      b.style.height = `${w.h * 100}%`;
      return b;
    }));
    const words = r.lines.reduce((n, l) => n + l.words.length, 0);
    this.setStatus(words === 0
      ? this.tr("ocrNothing", "No text found on this page.")
      : this.tr("ocrFound", "{n} words found.").replace("{n}", String(words)));
  }

  private async readAll(): Promise<void> {
    if (this.busy || this.source?.kind !== "pdf") return;
    const run = ++this.run;
    this.busy = true;
    this.refresh();
    const texts: [number, string][] = [];
    try {
      for (let n = 1; n <= this.pageCount; n++) {
        this.setStatus(this.tr("ocrReadingPage", "Reading page {n} of {total}…").replace("{n}", String(n)).replace("{total}", String(this.pageCount)));
        const r = await this.recognize(n);
        if (run !== this.run) return;
        texts.push([n, r.text]);
      }
      this.textArea.value = joinPages(texts);
      this.setStatus(this.tr("ocrAllDone", "Text of the {n} pages, ready to copy.").replace("{n}", String(this.pageCount)));
    } catch (err) {
      if (run === this.run) this.setStatus(this.d.errText(err), true);
    } finally {
      if (run === this.run) { this.busy = false; this.refresh(); }
    }
  }

  private async copyText(): Promise<void> {
    const text = this.textArea.value;
    if (!text.trim()) return;
    try {
      await this.d.copy(text);
      this.setStatus(this.tr("ocrCopied", "Text copied to the clipboard."));
    } catch (err) {
      this.setStatus(this.d.errText(err), true);
    }
  }

  private setStatus(text: string, error = false): void {
    this.status.textContent = text;
    this.status.classList.toggle("error", error);
  }

  protected override refresh(): void {
    if (!this.textArea) return;
    const pdf = this.source?.kind === "pdf";
    this.nav.hidden = !pdf;
    this.allBtn.hidden = !pdf || this.pageCount < 2;
    this.pageLabel.textContent = this.tr("ocrPageOf", "Page {n} / {total}").replace("{n}", String(this.page)).replace("{total}", String(this.pageCount));
    this.prevBtn.disabled = this.busy || this.page <= 1;
    this.nextBtn.disabled = this.busy || this.page >= this.pageCount;
    this.allBtn.disabled = this.busy;
    this.langSelect.disabled = this.busy;
    this.preview.classList.toggle("busy", this.busy);
    this.preview.hidden = !this.source;
    this.okBtn.disabled = this.textArea.value.trim() === "";
  }
}
