import { hexToRgb, rgbToHex, type RgbColor } from "./models";

const NONE_SWATCH = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 23 23 1" stroke="#E53935" stroke-width="1.8"/></svg>`;

export interface ColorRowOptions {
  /** Small icon shown before the swatches (its title says what the colour is for). */
  icon: string;
  title: string;
  /** Preset colours as "#rrggbb" with their names. */
  presets: [string, string][];
  /** Adds a crossed-out swatch meaning "no colour". */
  noneTitle?: string;
  customTitle: string;
  onPick: (color: RgbColor | null) => void;
}

/**
 * An icon, then 24 px rounded swatches (a ring marks the chosen one) and a
 * custom colour picker. No text, as in the approved design.
 */
export class ColorRow {
  readonly el: HTMLElement;
  private icon: HTMLElement;
  private noneBtn: HTMLButtonElement | null = null;
  private swatches: HTMLButtonElement[] = [];
  private custom: HTMLInputElement;
  private customWrap: HTMLElement;

  constructor(private opts: ColorRowOptions) {
    this.el = document.createElement("div");
    this.el.className = "color-row";
    this.icon = document.createElement("span");
    this.icon.className = "color-row-icon";
    this.icon.innerHTML = opts.icon;
    this.el.append(this.icon);

    if (opts.noneTitle !== undefined) {
      this.noneBtn = this.swatch("color-swatch none");
      this.noneBtn.innerHTML = NONE_SWATCH;
      this.noneBtn.addEventListener("click", () => { this.set(null); opts.onPick(null); });
      this.el.append(this.noneBtn);
    }
    for (const [hex] of opts.presets) {
      const b = this.swatch("color-swatch");
      b.style.background = hex;
      b.dataset["hex"] = hex.toLowerCase();
      b.addEventListener("click", () => { const c = hexToRgb(hex); this.set(c); opts.onPick(c); });
      this.swatches.push(b);
      this.el.append(b);
    }

    this.customWrap = document.createElement("label");
    this.customWrap.className = "color-swatch custom";
    this.custom = document.createElement("input");
    this.custom.type = "color";
    this.custom.addEventListener("input", () => {
      const c = hexToRgb(this.custom.value);
      this.set(c);
      opts.onPick(c);
    });
    this.customWrap.append(this.custom);
    this.el.append(this.customWrap);
    this.setTitles(opts.title, opts.presets.map(p => p[1]), opts.noneTitle, opts.customTitle);
  }

  setTitles(title: string, names: string[], noneTitle: string | undefined, customTitle: string): void {
    this.icon.title = title;
    this.swatches.forEach((b, i) => { b.title = names[i] ?? ""; b.setAttribute("aria-label", b.title); });
    if (this.noneBtn && noneTitle !== undefined) { this.noneBtn.title = noneTitle; this.noneBtn.setAttribute("aria-label", noneTitle); }
    this.customWrap.title = customTitle;
    this.custom.setAttribute("aria-label", customTitle);
  }

  /** Marks `color` (or "none") as the chosen one. */
  set(color: RgbColor | null): void {
    const hex = color ? rgbToHex(color).toLowerCase() : null;
    let matched = false;
    for (const b of this.swatches) {
      const on = b.dataset["hex"] === hex;
      b.classList.toggle("on", on);
      matched ||= on;
    }
    this.noneBtn?.classList.toggle("on", hex === null);
    const isCustom = hex !== null && !matched;
    this.customWrap.classList.toggle("on", isCustom);
    if (hex) this.custom.value = hex;
    this.customWrap.style.setProperty("--custom", isCustom && hex ? hex : "transparent");
  }

  private swatch(cls: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    return b;
  }
}

/** "Thickness ━━●━━ 3 px" */
export class SliderRow {
  readonly el: HTMLElement;
  private label: HTMLElement;
  private input: HTMLInputElement;
  private value: HTMLElement;

  constructor(min: number, max: number, private unit: string, onChange: (v: number) => void) {
    this.el = document.createElement("label");
    this.el.className = "slider-row";
    this.label = document.createElement("span");
    this.input = document.createElement("input");
    this.input.type = "range";
    this.input.min = String(min);
    this.input.max = String(max);
    this.value = document.createElement("span");
    this.value.className = "slider-row-value";
    this.input.addEventListener("input", () => {
      this.show();
      onChange(Number(this.input.value));
    });
    this.el.append(this.label, this.input, this.value);
  }

  setLabel(text: string): void { this.label.textContent = text; }

  set(v: number): void {
    this.input.value = String(Math.round(v));
    this.show();
  }

  private show(): void { this.value.textContent = `${this.input.value}${this.unit}`; }
}
