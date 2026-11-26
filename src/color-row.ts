import { hexToRgb, rgbToHex, type RgbColor } from "./models";

const EYEDROPPER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/></svg>`;

export function pickScreenColor(cancelEl?: Element | null): Promise<string | null> {
  return new Promise((resolve) => {
    const root = document.documentElement;
    root.classList.add("eyedropping");
    const events = ["pointerup", "pointercancel", "mousedown", "mouseup", "click", "auxclick", "contextmenu"] as const;
    let finished = false;
    const release = () => events.forEach((t) => window.removeEventListener(t, swallow, true));
    const swallow = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (finished && (e.type === "pointerup" || e.type === "pointercancel")) setTimeout(release, 0);
    };
    const done = (hex: string | null, midClick = false) => {
      if (finished) return;
      finished = true;
      root.classList.remove("eyedropping");
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      if (!midClick) release();
      resolve(hex);
    };
    const onDown = (e: PointerEvent) => {
      swallow(e);
      const cancel = e.button !== 0 || (cancelEl != null && e.target instanceof Node && cancelEl.contains(e.target));
      done(cancel ? null : sampleAt(e.clientX, e.clientY), true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      swallow(e);
      done(null);
    };
    const onBlur = () => done(null);
    setTimeout(() => {
      if (finished) return;
      window.addEventListener("pointerdown", onDown, true);
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("blur", onBlur);
      events.forEach((t) => window.addEventListener(t, swallow, true));
    }, 0);
  });
}

function normalizeHex(text: string): string | null {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(text);
  if (m) return rgbToHex({ r: +m[1]!, g: +m[2]!, b: +m[3]! }).toLowerCase();
  const c = parseHex(text);
  return c ? rgbToHex(c).toLowerCase() : null;
}

export function sampleAt(x: number, y: number): string | null {
  const seen = new Set<Element>();
  for (const el of document.elementsFromPoint(x, y)) {
    if (el instanceof HTMLCanvasElement) {
      seen.add(el);
      const hex = canvasPixel(el, x, y);
      if (hex) return hex;
      continue;
    }
    const hidden = [...el.querySelectorAll("canvas")].filter((c) => !seen.has(c)).reverse();
    for (const c of hidden) {
      seen.add(c);
      const hex = canvasPixel(c, x, y);
      if (hex) return hex;
    }
    const bg = getComputedStyle(el).backgroundColor;
    if (bg && !/^rgba\(.*,\s*0\)$/.test(bg) && bg !== "transparent") return normalizeHex(bg);
  }
  return null;
}

function canvasPixel(el: HTMLCanvasElement, x: number, y: number): string | null {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0 || el.width === 0 || el.height === 0) return null;
  if (x < r.left || x >= r.right || y < r.top || y >= r.bottom) return null;
  if (getComputedStyle(el).visibility === "hidden") return null;
  const px = Math.min(el.width - 1, Math.floor((x - r.left) * el.width / r.width));
  const py = Math.min(el.height - 1, Math.floor((y - r.top) * el.height / r.height));
  try {
    const d = el.getContext("2d")?.getImageData(px, py, 1, 1).data;
    if (d && d[3]! > 0) return rgbToHex({ r: d[0]!, g: d[1]!, b: d[2]! }).toLowerCase();
  } catch {}
  return null;
}

const NONE_SWATCH = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 23 23 1" stroke="#E53935" stroke-width="1.8"/></svg>`;

export interface ColorRowOptions {
  icon: string;
  title: string;
  presets: [string, string][];
  noneTitle?: string;
  customTitle: string;
  eyedropperTitle?: string;
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
  private customWrap: HTMLButtonElement;
  private picker: HsvPicker;

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
      this.noneBtn.addEventListener("click", () => { this.closePicker(); this.set(null); opts.onPick(null); });
      this.swatchRow.append(this.noneBtn);
    }
    for (const [hex] of opts.presets) {
      const b = this.swatch("color-swatch");
      b.style.background = hex;
      b.dataset["hex"] = hex.toLowerCase();
      b.addEventListener("click", () => { const c = hexToRgb(hex); this.closePicker(); this.set(c); opts.onPick(c); });
      this.swatches.push(b);
      this.swatchRow.append(b);
    }

    this.customWrap = this.swatch("color-swatch custom");
    this.customWrap.setAttribute("aria-expanded", "false");
    this.customWrap.addEventListener("click", () => this.togglePicker());
    this.swatchRow.append(this.customWrap);

    this.picker = new HsvPicker((c) => { this.set(c); opts.onPick(c); }, async (dropper) => {
      const hex = await pickScreenColor(dropper);
      if (!hex) return;
      const c = hexToRgb(hex);
      this.set(c);
      opts.onPick(c);
    });
    this.el.append(this.picker.el);

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
    this.setTitles(opts.title, opts.presets.map(p => p[1]), opts.noneTitle, opts.customTitle, opts.eyedropperTitle);
  }

  setTitles(title: string, names: string[], noneTitle: string | undefined, customTitle: string, eyedropperTitle = "Pick a color from the screen"): void {
    this.icon.title = title;
    this.label.textContent = title;
    this.hexInput.setAttribute("aria-label", `${title} (hex)`);
    this.swatches.forEach((b, i) => { b.title = names[i] ?? ""; b.setAttribute("aria-label", b.title); });
    if (this.noneBtn && noneTitle !== undefined) { this.noneBtn.title = noneTitle; this.noneBtn.setAttribute("aria-label", noneTitle); }
    this.customWrap.title = customTitle;
    this.customWrap.setAttribute("aria-label", customTitle);
    this.picker.setLabel(customTitle, eyedropperTitle);
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
    if (hex && !this.picker.dragging) this.picker.setHex(hex);
    this.customWrap.style.setProperty("--custom", isCustom && hex ? hex : "transparent");
  }

  private current: string | null = null;

  private togglePicker(): void {
    if (this.picker.el.hidden) {
      this.picker.setHex(this.current ?? "#ff0000");
      this.picker.el.hidden = false;
      this.customWrap.setAttribute("aria-expanded", "true");
    } else {
      this.closePicker();
    }
  }

  private closePicker(): void {
    this.picker.el.hidden = true;
    this.customWrap.setAttribute("aria-expanded", "false");
  }

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

export function hsvToRgb(h: number, s: number, v: number): RgbColor {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return { r: f(5), g: f(3), b: f(1) };
}

export function rgbToHsv({ r, g, b }: RgbColor): [number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

class HsvPicker {
  readonly el: HTMLElement;
  dragging = false;
  private sv: HTMLElement;
  private knob: HTMLElement;
  private hue: HTMLInputElement;
  private h = 0;
  private s = 1;
  private v = 1;

  private dropper: HTMLButtonElement;

  constructor(private onPick: (c: RgbColor) => void, onDropper: (dropper: HTMLElement) => Promise<void>) {
    this.el = document.createElement("div");
    this.el.className = "color-picker-pop";
    this.el.hidden = true;
    this.sv = document.createElement("div");
    this.sv.className = "cp-sv";
    this.sv.tabIndex = 0;
    this.knob = document.createElement("span");
    this.knob.className = "cp-knob";
    this.sv.append(this.knob);
    this.hue = document.createElement("input");
    this.hue.type = "range";
    this.hue.className = "cp-hue";
    this.hue.min = "0";
    this.hue.max = "360";
    this.hue.addEventListener("input", () => { this.h = Number(this.hue.value); this.emit(); });
    this.dropper = document.createElement("button");
    this.dropper.type = "button";
    this.dropper.className = "cp-dropper";
    this.dropper.innerHTML = EYEDROPPER_ICON;
    this.dropper.setAttribute("aria-pressed", "false");
    this.dropper.addEventListener("click", () => {
      if (this.dropper.classList.contains("on")) return;
      this.dropper.classList.add("on");
      this.dropper.setAttribute("aria-pressed", "true");
      void onDropper(this.dropper).finally(() => {
        this.dropper.classList.remove("on");
        this.dropper.setAttribute("aria-pressed", "false");
      });
    });
    const hueLine = document.createElement("div");
    hueLine.className = "cp-hue-line";
    hueLine.append(this.dropper, this.hue);
    this.el.append(this.sv, hueLine);

    this.sv.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.dragging = true;
      this.sv.setPointerCapture(e.pointerId);
      this.track(e);
    });
    this.sv.addEventListener("pointermove", (e) => { if (this.dragging) this.track(e); });
    const stop = () => { this.dragging = false; };
    this.sv.addEventListener("pointerup", stop);
    this.sv.addEventListener("pointercancel", stop);
    this.sv.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 0.1 : 0.02;
      const moves: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step],
      };
      const m = moves[e.key];
      if (!m) return;
      e.preventDefault();
      e.stopPropagation();
      this.s = clamp01(this.s + m[0]);
      this.v = clamp01(this.v + m[1]);
      this.emit();
    });
  }

  setLabel(text: string, dropper: string): void {
    this.sv.setAttribute("aria-label", text);
    this.hue.setAttribute("aria-label", text);
    this.dropper.title = dropper;
    this.dropper.setAttribute("aria-label", dropper);
  }

  setHex(hex: string): void {
    const [h, s, v] = rgbToHsv(hexToRgb(hex));
    if (s > 0 && v > 0) this.h = h;
    this.s = s;
    this.v = v;
    this.paint();
  }

  private track(e: PointerEvent): void {
    const r = this.sv.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    this.s = clamp01((e.clientX - r.left) / r.width);
    this.v = 1 - clamp01((e.clientY - r.top) / r.height);
    this.emit();
  }

  private emit(): void {
    this.paint();
    this.onPick(hsvToRgb(this.h, this.s, this.v));
  }

  private paint(): void {
    this.hue.value = String(Math.round(this.h));
    this.sv.style.setProperty("--cp-hue", `hsl(${this.h} 100% 50%)`);
    this.knob.style.left = `${this.s * 100}%`;
    this.knob.style.top = `${(1 - this.v) * 100}%`;
    this.knob.style.background = rgbToHex(hsvToRgb(this.h, this.s, this.v));
  }
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
