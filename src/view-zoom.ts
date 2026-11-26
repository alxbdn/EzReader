import { CSS_UNITS } from "./models";
import { pageFitScale, VIEWER_PADDING } from "./window-fit";

export type FitMode = "none" | "fit-width" | "fit-height" | "fit-page";

type Point = { x: number; y: number };
type Size = { width: number; height: number };

const ZOOM_LEVELS = [0.1, 0.15, 0.2, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0]
  .map((z) => Math.round(z * CSS_UNITS * 1000) / 1000);

export function snapZoom(current: number, dir: 1 | -1): number {
  if (dir === 1) return ZOOM_LEVELS.find((z) => z > current + 0.005) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
  return [...ZOOM_LEVELS].reverse().find((z) => z < current - 0.005) ?? ZOOM_LEVELS[0];
}

export interface ZoomableView {
  isLoaded(): boolean;
  readonly scale: number;
  readonly shownScale: number;
  clampScale(scale: number): number;
  setScale(scale: number, anchor?: Point): Promise<void>;
  previewScale(scale: number, anchor: Point): void;
  reflow(): void;
}

export interface ZoomSurroundings {
  showFitMode(mode: FitMode): void;
  showZoom(scale: number): void;
  room(): Size;
  page(): Size;
  center(): Point;
  pixelsPerInch(): number;
}

const WHEEL_SETTLE_SMOOTH_MS = 80;
const WHEEL_SETTLE_NOTCH_MS = 130;

export class ViewZoom {
  private mode: FitMode = "none";
  private wheel = { factor: 1, anchor: { x: 0, y: 0 }, settleMs: WHEEL_SETTLE_NOTCH_MS, raf: 0, timer: null as ReturnType<typeof setTimeout> | null };

  constructor(private readonly view: ZoomableView, private readonly around: ZoomSurroundings) {}

  get fitMode(): FitMode { return this.mode; }

  async step(dir: 1 | -1, anchor: Point = this.around.center()): Promise<void> {
    if (!this.view.isLoaded()) return;
    await this.set(snapZoom(this.view.scale, dir), anchor);
  }

  async set(scale: number, anchor: Point = this.around.center()): Promise<void> {
    if (!this.view.isLoaded()) return;
    this.setMode("none");
    await this.view.setScale(scale, anchor);
    this.around.showZoom(this.view.scale);
  }

  async actualSize(): Promise<void> {
    if (!this.view.isLoaded()) return;
    const ppi = this.around.pixelsPerInch();
    this.setMode("none");
    await this.view.setScale((Number.isFinite(ppi) && ppi > 0 ? ppi : 96) / 72);
    this.around.showZoom(this.view.scale);
  }

  async toggleFit(mode: "fit-width" | "fit-height"): Promise<void> {
    if (!this.view.isLoaded()) return;
    this.setMode(this.mode === mode ? "none" : mode);
    if (this.mode === mode) await this.refit();
  }

  async fit(mode: Exclude<FitMode, "none">): Promise<void> {
    this.setMode(mode);
    await this.refit();
  }

  async applyPreference(pref: string): Promise<void> {
    if (!this.view.isLoaded()) return;
    if (pref === "fit-width" || pref === "fit-page") {
      await this.fit(pref);
    } else {
      this.setMode("none");
      const pct = parseFloat(pref);
      await this.view.setScale((Number.isFinite(pct) ? pct : 100) / 100 * CSS_UNITS);
    }
    this.around.showZoom(this.view.scale);
  }

  async restore(mode: FitMode, scale: number): Promise<void> {
    this.setMode(mode);
    if (mode !== "none") await this.refit();
    else await this.view.setScale(scale);
    this.around.showZoom(this.view.scale);
  }

  async refit(): Promise<void> {
    if (!this.view.isLoaded()) return;
    if (this.mode === "none") { this.view.reflow(); return; }
    const room = this.around.room();
    const page = this.around.page();
    const scale = this.mode === "fit-width" ? (room.width - VIEWER_PADDING) / page.width
      : this.mode === "fit-page" ? pageFitScale(page, room)
      : (room.height - VIEWER_PADDING) / page.height;
    if (Math.abs(this.view.clampScale(scale) - this.view.scale) > 1e-6) await this.view.setScale(scale);
    else this.view.reflow();
    this.around.showZoom(this.view.scale);
  }

  wheelBy(px: number, anchor: Point): void {
    if (!this.view.isLoaded()) return;
    const w = this.wheel;
    w.factor *= Math.min(1.25, Math.max(0.8, Math.exp(-px * 0.0015)));
    w.anchor = anchor;
    w.settleMs = Math.abs(px) < 50 ? WHEEL_SETTLE_SMOOTH_MS : WHEEL_SETTLE_NOTCH_MS;
    if (this.mode !== "none") this.setMode("none");
    if (!w.raf) w.raf = requestAnimationFrame(() => this.previewWheel());
  }

  private previewWheel(): void {
    const w = this.wheel;
    w.raf = 0;
    if (!this.view.isLoaded()) { w.factor = 1; return; }
    const anchor = w.anchor;
    const target = this.view.clampScale(this.view.shownScale * w.factor);
    w.factor = 1;
    this.view.previewScale(target, anchor);
    this.around.showZoom(target);
    if (w.timer) clearTimeout(w.timer);
    w.timer = setTimeout(async () => {
      w.timer = null;
      await this.view.setScale(this.view.shownScale, anchor);
      this.around.showZoom(this.view.scale);
    }, w.settleMs);
  }

  private setMode(mode: FitMode): void {
    this.mode = mode;
    this.around.showFitMode(mode);
  }
}
