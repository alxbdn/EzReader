import { Modal } from "./modal";
import { ICON_COPY, ICON_LOCK, ICON_WATERMARK } from "./icons";
import { parsePageRange } from "./page-range";
import { drawWatermark, newCopyCode, WATERMARK_MAX_CHARS, type WatermarkOptions } from "./watermark";

export type WatermarkRequest = WatermarkOptions & { pages: number[] };
type ConfirmHandler = (o: WatermarkRequest) => void;
export type PagePreview = (widthPx: number, page: number) => Promise<HTMLCanvasElement>;
type PageChoice = "all" | "this" | "pick";

export function watermarkPages(choice: PageChoice, typed: string, current: number, total: number): number[] | null {
  if (choice === "all") return Array.from({ length: total }, (_, i) => i + 1);
  if (choice === "this") return [current];
  return typed.trim() ? parsePageRange(typed, total) : null;
}

const PREVIEW_CSS_WIDTH = 250;
const LOUPE_ZOOM = 4;
const LOUPE_RADIUS = 95;
const LOUPE_SHARPNESS = 2;
const LOUPE_MAX_WIDTH = 4000;

export class WatermarkModal extends Modal {
  private handlers: ConfirmHandler[] = [];
  private textArea: HTMLTextAreaElement;
  private counter: HTMLElement;
  private opacity: HTMLInputElement;
  private opacityVal: HTMLElement;
  private dateBox: HTMLInputElement;
  private dateLabel: HTMLElement;
  private codeBox: HTMLInputElement;
  private codeChip: HTMLElement;
  private copyBtn: HTMLButtonElement;
  private pane: HTMLElement;
  private view: HTMLCanvasElement;
  private loupe: HTMLElement;
  private loupeCanvas: HTMLCanvasElement;
  private caption: HTMLElement;
  private progress: HTMLElement;
  private pageField: HTMLElement;
  private pageBtns = new Map<PageChoice, HTMLButtonElement>();
  private pageInput: HTMLInputElement;
  private choice: PageChoice = "all";
  private current = 1;
  private total = 1;
  private shownPage = 0;

  private date = "";
  private code = "";
  private base: HTMLCanvasElement | null = null;
  private big: HTMLCanvasElement | null = null;
  private bigPending: Promise<void> | null = null;
  private preview: PagePreview | null = null;
  private frame = 0;
  private running = false;

  constructor() {
    super("watermark-box", "wmTitle", "Add a watermark", "wmOk", "Add the watermark", ICON_WATERMARK);

    const layout = this.el("div", "wm-layout");
    const form = this.el("div", "wm-form");

    const textField = this.el("label", "ez-field");
    this.textArea = this.el("textarea", "ez-input wm-text");
    this.textArea.maxLength = WATERMARK_MAX_CHARS;
    this.textArea.rows = 3;
    this.textArea.spellcheck = false;
    this.textArea.addEventListener("input", () => this.changed());
    const under = this.el("div", "wm-under");
    this.counter = this.el("span", "wm-count");
    under.append(this.el("span", "", "wmTextHint", "Complete or change the suggested text."), this.counter);
    textField.append(this.el("span", "ez-label", "wmText", "Watermark text"), this.textArea, under);

    const opField = this.el("label", "ez-field");
    const opHead = this.el("div", "wm-under");
    this.opacityVal = this.el("b", "wm-value");
    opHead.append(this.el("span", "ez-label", "wmOpacity", "Opacity"), this.opacityVal);
    this.opacity = this.el("input", "wm-range");
    this.opacity.type = "range";
    this.opacity.min = "10";
    this.opacity.max = "100";
    this.opacity.step = "5";
    this.opacity.value = "20";
    this.opacity.addEventListener("input", () => this.changed());
    opField.append(opHead, this.opacity);

    this.pageField = this.el("div", "ez-field");
    const pageSeg = this.el("div", "toolbar-segment opt-seg wm-pages");
    for (const c of ["all", "this", "pick"] as PageChoice[]) {
      const b = this.el("button", "opt-btn");
      b.type = "button";
      b.dataset["pages"] = c;
      b.addEventListener("click", () => {
        this.choice = c;
        this.changed();
        if (c === "pick") this.pageInput.focus();
      });
      this.pageBtns.set(c, b);
      pageSeg.append(b);
    }
    this.pageInput = this.el("input", "ez-input wm-page-input");
    this.pageInput.placeholder = "1-3, 5";
    this.pageInput.addEventListener("input", () => this.changed());
    this.pageField.append(this.el("span", "ez-label", "wmPages", "Pages"), pageSeg, this.pageInput);

    const dateRow = this.el("label", "ez-check");
    this.dateBox = this.el("input");
    this.dateBox.type = "checkbox";
    this.dateBox.checked = true;
    this.dateBox.addEventListener("change", () => this.changed());
    this.dateLabel = this.el("span");
    dateRow.append(this.dateBox, this.dateLabel);

    const codeWrap = this.el("div", "wm-code-wrap");
    const codeRow = this.el("label", "ez-check");
    this.codeBox = this.el("input");
    this.codeBox.type = "checkbox";
    this.codeBox.checked = true;
    this.codeBox.addEventListener("change", () => this.changed());
    codeRow.append(this.codeBox, this.el("span", "", "wmCode", "Add a unique code to this copy"));
    const codeLine = this.el("div", "wm-code-line");
    this.codeChip = this.el("span", "wm-code");
    this.copyBtn = this.el("button", "icon-btn");
    this.copyBtn.type = "button";
    this.copyBtn.innerHTML = ICON_COPY;
    this.title(this.copyBtn, "wmCopyCode", "Copy the code");
    this.copyBtn.addEventListener("click", () => { void navigator.clipboard?.writeText(this.code); });
    codeLine.append(this.codeChip, this.copyBtn);
    codeWrap.append(codeRow, codeLine, this.el("span", "wm-hint", "wmCodeHint", "A different code for each copy you send: you will know who passed the document on."));

    const note = this.el("div", "wm-note");
    const lock = this.el("span");
    lock.innerHTML = ICON_LOCK;
    note.append(lock, this.el("span", "", "wmNote", "The watermark is burned into the pages, like a redaction: it can't be removed. The pages become pictures, so their text can no longer be selected."));

    this.progress = this.el("div", "wm-hint wm-progress");
    this.progress.hidden = true;

    form.append(textField, opField, this.pageField, dateRow, codeWrap, this.el("div", "wm-spacer"), note, this.progress);

    this.pane = this.el("div", "wm-preview");
    const stage = this.el("div", "wm-stage");
    this.view = this.el("canvas", "wm-page");
    this.loupe = this.el("div", "wm-loupe");
    this.loupeCanvas = this.el("canvas");
    this.loupe.append(this.loupeCanvas);
    stage.append(this.view, this.loupe);
    this.caption = this.el("span", "wm-hint", "wmHover", "Hover over the preview to zoom in");
    this.pane.append(stage, this.caption);
    stage.addEventListener("mousemove", (e) => this.moveLoupe(e));
    stage.addEventListener("mouseleave", () => this.loupe.classList.remove("on"));

    layout.append(form, this.pane);
    this.body.append(layout);

    this.okBtn.addEventListener("click", () => {
      if (this.running || !this.textArea.value.trim() || !this.pages()) return;
      const o = this.options();
      this.handlers.forEach((h) => h(o));
    });
  }

  onConfirm(h: ConfirmHandler): void { this.handlers.push(h); }

  open(preview: PagePreview, today: string, pages: { current: number; total: number } = { current: 1, total: 1 }): void {
    this.preview = preview;
    this.current = pages.current;
    this.total = pages.total;
    this.choice = "all";
    this.pageInput.value = "";
    this.shownPage = 0;
    this.date = today;
    this.code = newCopyCode();
    this.base = this.big = null;
    delete this.view.dataset["ready"];
    this.bigPending = null;
    this.running = false;
    this.progress.hidden = true;
    if (!this.textArea.value) this.textArea.value = this.tr("wmDefaultText", "For the sole purpose of ");
    this.show();
    this.changed();
    this.textArea.focus();
    this.textArea.setSelectionRange(this.textArea.value.length, this.textArea.value.length);
    this.loadPreview();
  }

  pages(): number[] | null {
    return watermarkPages(this.choice, this.pageInput.value, this.current, this.total);
  }

  options(): WatermarkRequest {
    return {
      pages: this.pages() ?? [],
      text: this.textArea.value,
      date: this.dateBox.checked ? this.date : null,
      code: this.codeBox.checked ? this.code : null,
      opacity: Number(this.opacity.value) / 100,
    };
  }

  get copyLabel(): string { return this.tr("wmCopyLabel", "Unique copy"); }

  startRunning(): void {
    this.running = true;
    this.box.classList.add("running");
    this.okBtn.disabled = true;
    this.progress.hidden = false;
    this.setProgress(0, 0);
  }

  setProgress(done: number, total: number): void {
    this.progress.textContent = total
      ? this.tr("wmProgress", "Adding the watermark… {done}/{total}").replace("{done}", String(done)).replace("{total}", String(total))
      : this.tr("wmPreparing", "Preparing the pages…");
  }

  finishRunning(): void {
    this.running = false;
    this.box.classList.remove("running");
    this.okBtn.disabled = false;
    this.progress.hidden = true;
  }

  override close(): void {
    if (this.running) return;
    this.preview = null;
    super.close();
  }

  private loadPreview(): void {
    const preview = this.preview;
    const page = this.pages()?.[0] ?? this.current;
    if (!preview || page === this.shownPage) return;
    this.shownPage = page;
    this.big = null;
    this.bigPending = null;
    const dpr = window.devicePixelRatio || 1;
    void preview(Math.round(PREVIEW_CSS_WIDTH * dpr), page).then((c) => {
      if (this.preview !== preview || this.shownPage !== page) return;
      this.base = c;
      this.redraw();
    }).catch((e) => console.error("watermark preview", e));
  }

  protected override refresh(): void {
    const pick = this.tr("wmPagesPick", "Choose");
    this.pageBtns.get("all")!.textContent = this.tr("wmPagesAll", "All ({n})").replace("{n}", String(this.total));
    this.pageBtns.get("this")!.textContent = this.tr("wmPagesThis", "This one ({n})").replace("{n}", String(this.current));
    this.pageBtns.get("pick")!.textContent = pick;
    this.dateLabel.textContent = this.tr("wmDate", "Add today's date · {date}").replace("{date}", this.date);
    this.redraw();
  }

  private changed(): void {
    this.counter.textContent = `${this.textArea.value.length}/${WATERMARK_MAX_CHARS}`;
    this.opacityVal.textContent = `${this.opacity.value} %`;
    this.codeChip.textContent = this.code;
    this.codeChip.parentElement!.classList.toggle("off", !this.codeBox.checked);
    const pages = this.pages();
    for (const [c, b] of this.pageBtns) b.classList.toggle("active", c === this.choice);
    this.pageInput.hidden = this.choice !== "pick";
    this.pageInput.classList.toggle("invalid", this.choice === "pick" && this.pageInput.value.trim() !== "" && !pages);
    this.pageField.hidden = this.total < 2;
    this.okBtn.disabled = this.running || !this.textArea.value.trim() || !pages;
    if (pages && pages[0] !== this.shownPage && this.preview) this.loadPreview();
    this.refresh();
  }

  private redraw(): void {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      if (!this.base) return;
      paint(this.view, this.base, this.options(), this.copyLabel);
      this.view.dataset["ready"] = "true";
      this.view.style.width = `${PREVIEW_CSS_WIDTH}px`;
      if (this.big) paint(this.loupeCanvas, this.big, this.options(), this.copyLabel);
      else paint(this.loupeCanvas, this.view, null, this.copyLabel);
    });
  }

  private moveLoupe(e: MouseEvent): void {
    if (!this.base || !this.preview) return;
    if (!this.big) {
      const preview = this.preview;
      const page = this.shownPage;
      this.bigPending ??= preview(loupeWidth(this.base.width), page).then((c) => {
        if (this.preview !== preview || this.shownPage !== page) return;
        this.big = c;
        this.redraw();
      }).catch(() => {});
    }
    const r = this.view.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const inside = x >= 0 && y >= 0 && x <= r.width && y <= r.height;
    this.loupe.classList.toggle("on", inside);
    this.caption.textContent = inside
      ? this.tr("wmLoupe", "Magnifier × 4 · move the mouse")
      : this.tr("wmHover", "Hover over the preview to zoom in");
    if (!inside) return;
    const d = LOUPE_RADIUS * 2;
    this.loupe.style.left = `${this.view.offsetLeft + x - LOUPE_RADIUS}px`;
    this.loupe.style.top = `${this.view.offsetTop + y - LOUPE_RADIUS}px`;
    const k = (r.width * LOUPE_ZOOM) / r.width;
    this.loupeCanvas.style.width = `${r.width * k}px`;
    this.loupeCanvas.style.height = `${r.height * k}px`;
    this.loupeCanvas.style.transform = `translate(${-(x * k - d / 2)}px, ${-(y * k - d / 2)}px)`;
  }
}

export function loupeWidth(baseWidth: number): number {
  return Math.round(Math.min(LOUPE_MAX_WIDTH, Math.max(baseWidth * LOUPE_ZOOM, 1000) * LOUPE_SHARPNESS));
}

function paint(target: HTMLCanvasElement, base: HTMLCanvasElement, o: WatermarkOptions | null, copyLabel: string): void {
  target.width = base.width;
  target.height = base.height;
  const ctx = target.getContext("2d")!;
  ctx.drawImage(base, 0, 0);
  if (o) drawWatermark(ctx, base.width, base.height, o, copyLabel);
}
