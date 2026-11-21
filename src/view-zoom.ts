import { CSS_UNITS } from "./models";
import { pageFitScale, VIEWER_PADDING } from "./window-fit";

export type FitMode = "none" | "fit-width" | "fit-height" | "fit-page";

type Point = { x: number; y: number };
type Size = { width: number; height: number };

const ZOOM_LEVELS = [0.1, 0.15, 0.2, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0]
  .map((z) => Math.round(z * CSS_UNITS * 1000) / 1000);

/** The next zoom step above (`1`) or below (`-1`) `current`, in viewer scale units. */
export function snapZoom(current: number, dir: 1 | -1): number {
  if (dir === 1) return ZOOM_LEVELS.find((z) => z > current + 0.005) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
  return [...ZOOM_LEVELS].reverse().find((z) => z < current - 0.005) ?? ZOOM_LEVELS[0];
}

/** The parts of the viewer that zooming drives. */
export interface ZoomableView {
  isLoaded(): boolean;
  readonly scale: number;
  /** The scale on screen, ahead of `scale` while a wheel zoom is being previewed. */
  readonly shownScale: number;
  clampScale(scale: number): number;
  setScale(scale: number, anchor?: Point): Promise<void>;
  previewScale(scale: number, anchor: Point): void;
  reflow(): void;
}

export interface ZoomSurroundings {
  /** Shows the fit mode and the zoom level (the toolbar). */
  showFitMode(mode: FitMode): void;
  showZoom(scale: number): void;
  /** Room the pages have, and the first page's size at scale 1 as shown (rotation applied). */
  room(): Size;
  page(): Size;
  /** Where to keep still when zooming without a pointer: the middle of the viewer. */
  center(): Point;
  /** Screen pixels per inch for "actual size". */
  pixelsPerInch(): number;
}

const WHEEL_SETTLE_SMOOTH_MS = 80;
const WHEEL_SETTLE_NOTCH_MS = 130;

/**
 * The document's zoom: the fit mode (none, width, height, page), zoom steps, Ctrl+wheel and the
 * toolbar's display of both. Every way of zooming goes through here, so zooming by hand always
 * leaves the fit mode, and the toolbar always shows what the viewer does.
 */
export class ViewZoom {
  private mode: FitMode = "none";
  private wheel = { factor: 1, anchor: { x: 0, y: 0 }, settleMs: WHEEL_SETTLE_NOTCH_MS, raf: 0, timer: null as ReturnType<typeof setTimeout> | null };

  constructor(private readonly view: ZoomableView, private readonly around: ZoomSurroundings) {}

  get fitMode(): FitMode { return this.mode; }

  /** One zoom step in or out, keeping `anchor` (the viewer's middle by default) still. */
  async step(dir: 1 | -1, anchor: Point = this.around.center()): Promise<void> {
    if (!this.view.isLoaded()) return;
    await this.set(snapZoom(this.view.scale, dir), anchor);
  }

  /** A given scale, leaving any fit mode. */
  async set(scale: number, anchor: Point = this.around.center()): Promise<void> {
    if (!this.view.isLoaded()) return;
    this.setMode("none");
    await this.view.setScale(scale, anchor);
    this.around.showZoom(this.view.scale);
  }

  /** The page at its printed size on this screen. */
  async actualSize(): Promise<void> {
    if (!this.view.isLoaded()) return;
    const ppi = this.around.pixelsPerInch();
    this.setMode("none");
    await this.view.setScale((Number.isFinite(ppi) && ppi > 0 ? ppi : 96) / 72);
    this.around.showZoom(this.view.scale);
  }

  /** Turns `mode` on, or off when it is already on (the toolbar's fit buttons). */
  async toggleFit(mode: "fit-width" | "fit-height"): Promise<void> {
    if (!this.view.isLoaded()) return;
    this.setMode(this.mode === mode ? "none" : mode);
    if (this.mode === mode) await this.refit();
  }

  /** Sets a fit mode and fits the page to it. */
  async fit(mode: Exclude<FitMode, "none">): Promise<void> {
    this.setMode(mode);
    await this.refit();
  }

  /**
   * The zoom set in Settings: "fit-width", "fit-page" or a percentage of the page's size.
   */
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

  /** Back to a mode and scale saved earlier (a tab shown again). */
  async restore(mode: FitMode, scale: number): Promise<void> {
    this.setMode(mode);
    if (mode !== "none") await this.refit();
    else await this.view.setScale(scale);
    this.around.showZoom(this.view.scale);
  }

  /** Fits the page again after the room changed; without a fit mode, only lays the pages out again. */
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

  /**
   * One Ctrl+wheel event, `px` its vertical distance in pixels. Events are gathered into one
   * preview per frame, and the pages are drawn at the new scale once the wheel settles.
   */
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
