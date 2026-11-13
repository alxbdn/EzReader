import { Modal, type Key } from "./modal";
import { ICON_COMPRESS_LAYERS } from "./icons";
import type { CompressEstimate, CompressLevel } from "./tauri-bridge";

type ConfirmHandler = (level: CompressLevel, targetBytes?: number) => void;

const MB = 1024 * 1024;

/**
 * Compress: three levels with the size each gives (computed when the
 * dialog opens), or a target size that EzReader meets with the best quality.
 */
export class CompressModal extends Modal {
  private level: CompressLevel = "balanced";
  private estimate: CompressEstimate | null = null;
  private failed = false;
  private currentBytes = 0;
  private handlers: ConfirmHandler[] = [];

  private current: HTMLElement;
  private rows = new Map<CompressLevel, { btn: HTMLButtonElement; size: HTMLElement; gain: HTMLElement }>();
  private targetInput: HTMLInputElement;
  private beforeVal: HTMLElement;
  private afterVal: HTMLElement;
  private bar: HTMLElement;

  constructor() {
    super("compress-box", "compressTitle", "Compress", "cmpOk", "Compress", ICON_COMPRESS_LAYERS);
    this.current = this.el("span", "ez-card-sub");

    const list = this.el("div", "ez-list");
    const defs: [CompressLevel, Key, string, Key, string][] = [
      ["lossless", "cmpLossless", "Lossless", "cmpLosslessSub", "Streams cleaned up and recompressed, same quality"],
      ["balanced", "cmpBalanced", "Balanced", "cmpBalancedSub", "Images at 150 dpi, JPEG quality 75"],
      ["maximum", "cmpMaximum", "Maximum", "cmpMaximumSub", "Images at 96 dpi, JPEG quality 55"],
      ["target", "cmpTarget", "Target size", "cmpTargetSub", "EzReader looks for the best quality under this size"],
    ];
    this.targetInput = this.el("input", "ez-input ez-target");
    for (const [level, key, fb, subKey, subFb] of defs) {
      const btn = this.card(key, fb, subKey, subFb, () => {
        this.level = level;
        this.refresh();
        if (level === "target") this.targetInput.focus();
      });
      btn.classList.add("ez-radio-card");
      btn.prepend(this.el("span", "ez-radio"));
      if (level === "balanced") {
        const tag = this.el("span", "ez-tag", "cmpRecommended", "Recommended");
        btn.querySelector(".ez-card-label")!.append(" ", tag);
      }
      const right = this.el("span", "ez-card-right");
      const size = this.el("b");
      const gain = this.el("span", "ez-gain");
      if (level === "target") {
        this.targetInput.type = "number";
        this.targetInput.min = "0.1";
        this.targetInput.step = "0.1";
        this.targetInput.value = "3";
        this.title(this.targetInput, "cmpTarget", "Target size");
        this.targetInput.addEventListener("click", (e) => e.stopPropagation());
        this.targetInput.addEventListener("focus", () => { if (this.level !== "target") { this.level = "target"; this.refresh(); } });
        this.targetInput.addEventListener("input", () => this.refresh());
        this.targetInput.addEventListener("keydown", (e) => { if (e.key === "Enter") this.confirm(); });
        const unit = this.el("span", "", "unitMB", "MB");
        right.classList.add("ez-target-wrap");
        right.append(this.targetInput, unit);
      } else {
        right.append(size, gain);
      }
      btn.append(right);
      this.rows.set(level, { btn, size, gain });
      list.append(btn);
    }

    const compare = this.el("div", "ez-compare");
    const before = this.el("div", "ez-compare-row");
    this.beforeVal = this.el("span");
    before.append(this.el("span", "", "cmpBefore", "Before"), this.beforeVal);
    const full = this.el("div", "ez-bar");
    full.append(this.el("div", "ez-bar-fill ez-bar-before"));
    const after = this.el("div", "ez-compare-row");
    this.afterVal = this.el("span");
    after.append(this.el("span", "", "cmpAfter", "After (estimated)"), this.afterVal);
    const track = this.el("div", "ez-bar");
    this.bar = this.el("div", "ez-bar-fill");
    track.append(this.bar);
    compare.append(before, full, after, track);

    this.body.append(this.current, list, compare);
    this.okBtn.addEventListener("click", () => this.confirm());
  }

  onConfirm(cb: ConfirmHandler): void { this.handlers.push(cb); }

  /** Opens with the file's size; the estimates follow with `setEstimate`. */
  open(currentBytes: number): void {
    this.currentBytes = currentBytes;
    this.estimate = null;
    this.failed = false;
    this.refresh();
    this.show();
  }

  setEstimate(e: CompressEstimate | null): void {
    this.estimate = e;
    this.failed = e === null;
    if (e) this.currentBytes = e.originalBytes;
    this.refresh();
  }

  private targetBytes(): number | null {
    const v = Number(this.targetInput.value.replace(",", "."));
    return Number.isFinite(v) && v > 0 ? Math.round(v * MB) : null;
  }

  private confirm(): void {
    if (this.okBtn.disabled) return;
    const target = this.level === "target" ? this.targetBytes() ?? undefined : undefined;
    this.close();
    for (const h of this.handlers) h(this.level, target);
  }

  /** "12.4 MB", "830 KB" in the interface language. */
  size(bytes: number): string {
    const lang = document.documentElement.lang || "en";
    const nf = (n: number, d: number) => n.toLocaleString(lang, { maximumFractionDigits: d, minimumFractionDigits: d });
    return bytes >= MB / 10
      ? `${nf(bytes / MB, 1)} ${this.tr("unitMB", "MB")}`
      : `${nf(Math.max(1, Math.round(bytes / 1024)), 0)} ${this.tr("unitKB", "KB")}`;
  }

  private sizeOf(level: CompressLevel): number | null {
    const e = this.estimate;
    if (!e) return null;
    if (level === "lossless") return e.losslessBytes;
    if (level === "balanced") return e.balancedBytes;
    if (level === "maximum") return e.maximumBytes;
    return this.targetBytes();
  }

  protected override refresh(): void {
    if (!this.bar) return;
    const cur = this.currentBytes;
    this.current.innerHTML = "";
    this.current.append(this.tr("cmpCurrent", "Current size:") + " ");
    const b = this.el("b");
    b.textContent = this.size(cur);
    this.current.append(b);

    for (const [level, row] of this.rows) {
      const on = level === this.level;
      row.btn.classList.toggle("active", on);
      row.btn.setAttribute("aria-pressed", String(on));
      if (level === "target") continue;
      const s = this.sizeOf(level);
      row.size.textContent = s === null ? (this.failed ? "—" : "…") : `~${this.size(s)}`;
      row.gain.textContent = s === null || cur === 0 ? "" : `${s <= cur ? "−" : "+"}${Math.abs(Math.round((1 - s / cur) * 100))} %`;
      row.gain.classList.toggle("good", on);
    }

    const after = this.sizeOf(this.level);
    this.beforeVal.textContent = this.size(cur);
    this.afterVal.textContent = after === null ? (this.failed ? "—" : "…") : `${this.level === "target" ? "≤ " : ""}${this.size(after)}`;
    const pct = after === null || cur === 0 ? 100 : Math.max(2, Math.min(100, (after / cur) * 100));
    this.bar.style.width = `${pct}%`;
    this.okBtn.disabled = this.level === "target" && this.targetBytes() === null;
  }
}
