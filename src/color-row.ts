import { hexToRgb, rgbToHex, type RgbColor } from "./models";

const NONE_SWATCH = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 23 23 1" stroke="#E53935" stroke-width="1.8"/></svg>`;

export interface ColorRowOptions {
  icon: string;
  title: string;
  presets: [string, string][];
  noneTitle?: string;
  customTitle: string;
  onPick: (color: RgbColor | null) => void;
}

export function parseHex(text: string): RgbColor | null {
  let h = text.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.split("").map((c) => c + c).join("");
  return /^[0-9a-f]{6}$/i.test(h) ? hexToRgb(`#${h}`) : null;
}

export class ColorRow {
  readonly el: HTMLElement;
  private icon: HTMLElement;
  private label: HTMLElement;
  private swatchRow: HTMLElement;
  private hexWrap: HTMLElement;
  private hexChip: HTMLElement;
  private hexInput: HTMLInputElement;
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
    this.label = document.createElement("span");
    this.label.className = "color-row-label";
    this.swatchRow = document.createElement("div");
    this.swatchRow.className = "color-row-swatches";
    this.el.append(this.icon, this.label, this.swatchRow);

    if (opts.noneTitle !== undefined) {
      this.noneBtn = this.swatch("color-swatch none");
      this.noneBtn.innerHTML = NONE_SWATCH;
      this.noneBtn.addEventListener("click", () => { this.set(null); opts.onPick(null); });
      this.swatchRow.append(this.noneBtn);
    }
    for (const [hex] of opts.presets) {
      const b = this.swatch("color-swatch");
      b.style.background = hex;
      b.dataset["hex"] = hex.toLowerCase();
      b.addEventListener("click", () => { const c = hexToRgb(hex); this.set(c); opts.onPick(c); });
      this.swatches.push(b);
      this.swatchRow.append(b);
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
    this.swatchRow.append(this.customWrap);

    this.hexWrap = document.createElement("label");
    this.hexWrap.className = "color-hex";
    this.hexChip = document.createElement("span");
    this.hexChip.className = "color-hex-chip";
    this.hexInput = document.createElement("input");
    this.hexInput.type = "text";
    this.hexInput.spellcheck = false;
    this.hexInput.maxLength = 7;
    this.hexInput.setAttribute("autocomplete", "off");
    const fmt = document.createElement("span");
    fmt.className = "color-hex-fmt";
    fmt.textContent = "Hex";
    this.hexWrap.append(this.hexChip, this.hexInput, fmt);
    const commit = () => {
      const c = parseHex(this.hexInput.value);
      if (c) { this.set(c); opts.onPick(c); } else this.showHex();
    };
    this.hexInput.addEventListener("change", commit);
    this.hexInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); commit(); this.hexInput.blur(); }
      if (e.key === "Escape") { e.preventDefault(); this.showHex(); this.hexInput.blur(); }
    });
    this.el.append(this.hexWrap);
    this.setTitles(opts.title, opts.presets.map(p => p[1]), opts.noneTitle, opts.customTitle);
  }

  setTitles(title: string, names: string[], noneTitle: string | undefined, customTitle: string): void {
    this.icon.title = title;
    this.label.textContent = title;
    this.hexInput.setAttribute("aria-label", `${title} (hex)`);
    this.swatches.forEach((b, i) => { b.title = names[i] ?? ""; b.setAttribute("aria-label", b.title); });
    if (this.noneBtn && noneTitle !== undefined) { this.noneBtn.title = noneTitle; this.noneBtn.setAttribute("aria-label", noneTitle); }
    this.customWrap.title = customTitle;
    this.custom.setAttribute("aria-label", customTitle);
  }

  set(color: RgbColor | null): void {
    const hex = color ? rgbToHex(color).toLowerCase() : null;
    this.current = hex;
    this.showHex();
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

  private current: string | null = null;

  private showHex(): void {
    this.hexInput.value = this.current ? this.current.toUpperCase() : "";
    this.hexInput.placeholder = this.current ? "" : "—";
    this.hexChip.style.background = this.current ?? "transparent";
    this.hexChip.classList.toggle("none", this.current === null);
  }

  private swatch(cls: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    return b;
  }
}

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
