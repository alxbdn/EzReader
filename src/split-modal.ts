import type { Translations } from "./i18n";
import type { SplitRange } from "./tauri-bridge";
import { parsePageSpans } from "./page-range";

export type SplitMode = "each" | "every" | "custom";

export interface SplitRequest {
  mode: SplitMode;
  ranges: SplitRange[];
}

type ConfirmHandler = (req: SplitRequest) => void;

export class SplitModal {
  private backdrop: HTMLElement;
  private modeRadios: HTMLInputElement[];
  private everyInput: HTMLInputElement;
  private customInput: HTMLInputElement;
  private summaryEl: HTMLElement;
  private applyBtn: HTMLButtonElement;
  private cancelBtn: HTMLButtonElement;
  private closeBtn: HTMLButtonElement;
  private titleEl: HTMLElement;
  private confirmHandlers: ConfirmHandler[] = [];
  private pageCount = 0;
  private _t: Translations | null = null;
  private _i18nText = new Map<HTMLElement, keyof Translations>();
  private _i18nTitle = new Map<HTMLElement, keyof Translations>();

  constructor() {
    this.backdrop = document.getElementById("split-modal")!;
    this.modeRadios = Array.from(
      this.backdrop.querySelectorAll<HTMLInputElement>("input[name='split-mode']"),
    );
    this.everyInput = document.getElementById("split-every-n") as HTMLInputElement;
    this.customInput = document.getElementById("split-custom-input") as HTMLInputElement;
    this.summaryEl = document.getElementById("split-summary")!;
    this.applyBtn = document.getElementById("split-apply-btn") as HTMLButtonElement;
    this.cancelBtn = document.getElementById("split-cancel-btn") as HTMLButtonElement;
    this.closeBtn = document.getElementById("split-close-btn") as HTMLButtonElement;
    this.titleEl = document.getElementById("split-title-span")!;
    this.bind();
  }

  onConfirm(cb: ConfirmHandler): void {
    this.confirmHandlers.push(cb);
  }

  applyTranslations(t: Translations): void {
    this._t = t;
    this._i18nText.forEach((key, el) => {
      const v = t[key];
      if (v !== undefined) el.textContent = v;
    });
    this._i18nTitle.forEach((key, el) => {
      const v = t[key];
      if (v !== undefined) el.title = v;
    });
    this.refreshSummary();
  }

  open(pageCount: number): void {
    this.pageCount = pageCount;
    this.everyInput.max = String(Math.max(1, pageCount));
    // Default "every" value: 1 page per file
    if (Number(this.everyInput.value) < 1) this.everyInput.value = "1";
    this.refreshEnabledInputs();
    this.refreshSummary();
    this.backdrop.classList.remove("hidden");
  }

  close(): void {
    this.backdrop.classList.add("hidden");
  }

  private bind(): void {
    this._i18nText.set(this.titleEl, "splitTitle");
    this._i18nTitle.set(this.closeBtn, "splitClose");

    this.closeBtn.addEventListener("click", () => this.close());
    this.cancelBtn.addEventListener("click", () => this.close());
    this.backdrop.addEventListener("click", (e) => {
      if (e.target === this.backdrop) this.close();
    });

    for (const r of this.modeRadios) {
      r.addEventListener("change", () => {
        this.refreshEnabledInputs();
        this.refreshSummary();
      });
    }
    this.everyInput.addEventListener("input", () => this.refreshSummary());
    this.customInput.addEventListener("input", () => this.refreshSummary());

    this.applyBtn.addEventListener("click", () => this.handleApply());
  }

  private refreshEnabledInputs(): void {
    const mode = this.selectedMode();
    this.everyInput.disabled = mode !== "every";
    this.customInput.disabled = mode !== "custom";
  }

  private selectedMode(): SplitMode {
    const checked = this.modeRadios.find((r) => r.checked);
    return (checked?.value as SplitMode) ?? "every";
  }

  private computeRanges(): { ranges: SplitRange[]; error: string | null } {
    if (this.pageCount === 0) {
      return { ranges: [], error: "no-pages" };
    }
    const mode = this.selectedMode();
    if (mode === "each") {
      const ranges: SplitRange[] = [];
      for (let p = 1; p <= this.pageCount; p++) ranges.push({ start: p, end: p });
      return { ranges, error: null };
    }
    if (mode === "every") {
      const n = parseInt(this.everyInput.value, 10);
      if (!Number.isFinite(n) || n < 1) return { ranges: [], error: "invalid-n" };
      const ranges: SplitRange[] = [];
      for (let start = 1; start <= this.pageCount; start += n) {
        const end = Math.min(start + n - 1, this.pageCount);
        ranges.push({ start, end });
      }
      return { ranges, error: null };
    }
    // custom
    const parsed = parsePageSpans(this.customInput.value, this.pageCount);
    if (parsed === null) return { ranges: [], error: "invalid-custom" };
    if (parsed.length === 0) return { ranges: [], error: "empty-custom" };
    return { ranges: parsed, error: null };
  }

  private refreshSummary(): void {
    const { ranges, error } = this.computeRanges();
    const t = this._t;
    if (error) {
      const msg =
        error === "invalid-n"
          ? t?.splitInvalidN ?? "Enter a positive number of pages."
          : error === "invalid-custom"
            ? t?.splitInvalidCustom ?? "Invalid ranges. Use e.g. \"1-3, 5, 7-9\"."
            : error === "empty-custom"
              ? t?.splitEnterRanges ?? "Enter at least one page range."
              : t?.splitNoPages ?? "No pages to split.";
      this.summaryEl.textContent = msg;
      this.summaryEl.classList.add("error");
      this.applyBtn.disabled = true;
      return;
    }
    const tmpl = t?.splitSummary ?? "Will produce {n} file(s).";
    this.summaryEl.textContent = tmpl.replace("{n}", String(ranges.length));
    this.summaryEl.classList.remove("error");
    this.applyBtn.disabled = ranges.length === 0;
  }

  private handleApply(): void {
    const { ranges } = this.computeRanges();
    if (ranges.length === 0) return;
    const req: SplitRequest = { mode: this.selectedMode(), ranges };
    this.close();
    for (const cb of this.confirmHandlers) cb(req);
  }
}
