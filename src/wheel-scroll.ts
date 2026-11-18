export interface WheelScrollTarget {
  scrollLeft: number;
  scrollTop: number;
  readonly scrollWidth: number;
  readonly scrollHeight: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
}

export interface WheelDeltaInput {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
  horizontalMode: boolean;
  clientWidth: number;
  clientHeight: number;
}

const LINE_PX = 40;
const DISCRETE_PIXEL_THRESHOLD = 24;
const BASE_TAU_MS = 45;
const MIN_FAST_TAU_MS = 14;
const FAST_THRESHOLD_PX = 240;
const FAST_RAMP_PX = 300;
const MAX_DT_MS = 100;
const EXTERNAL_SCROLL_EPSILON_PX = 4;

export function normalizeWheelDelta(input: WheelDeltaInput): { dx: number; dy: number; discrete: boolean } {
  let rawDx = input.deltaX;
  let rawDy = input.deltaY;

  if (input.deltaMode === 1) {
    rawDx *= LINE_PX;
    rawDy *= LINE_PX;
  } else if (input.deltaMode === 2) {
    rawDx *= Math.max(1, input.clientWidth || 400);
    rawDy *= Math.max(1, input.clientHeight || 400);
  }

  const discrete =
    input.deltaMode !== 0 || Math.max(Math.abs(rawDx), Math.abs(rawDy)) >= DISCRETE_PIXEL_THRESHOLD;

  if ((input.horizontalMode || input.shiftKey) && Math.abs(rawDy) > Math.abs(rawDx) && rawDy !== 0) {
    return { dx: rawDy, dy: 0, discrete };
  }

  return { dx: rawDx || 0, dy: rawDy || 0, discrete };
}

export class SmoothWheelScroller {
  private rafId: number | null = null;
  private posX = 0;
  private posY = 0;
  private targetX = 0;
  private targetY = 0;
  private lastAppliedX = 0;
  private lastAppliedY = 0;
  private lastTime = 0;

  constructor(private readonly el: WheelScrollTarget) {}

  get isAnimating(): boolean {
    return this.rafId !== null;
  }

  cancel(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  scrollBy(dx: number, dy: number): void {
    const maxX = Math.max(0, this.el.scrollWidth - this.el.clientWidth);
    const maxY = Math.max(0, this.el.scrollHeight - this.el.clientHeight);

    if (!this.isAnimating || this.wasScrolledExternally()) {
      this.posX = this.el.scrollLeft;
      this.posY = this.el.scrollTop;
      this.targetX = this.posX;
      this.targetY = this.posY;
      this.lastAppliedX = this.posX;
      this.lastAppliedY = this.posY;
      this.lastTime = performance.now();
    }

    this.targetX = Math.min(maxX, Math.max(0, this.targetX + dx));
    this.targetY = Math.min(maxY, Math.max(0, this.targetY + dy));

    if (Math.abs(this.targetX - this.posX) < 0.5 && Math.abs(this.targetY - this.posY) < 0.5) {
      return;
    }

    if (this.rafId === null) {
      this.lastTime = performance.now();
      this.rafId = requestAnimationFrame(this.step);
    }
  }

  private wasScrolledExternally(): boolean {
    return (
      Math.abs(this.el.scrollLeft - this.lastAppliedX) > EXTERNAL_SCROLL_EPSILON_PX ||
      Math.abs(this.el.scrollTop - this.lastAppliedY) > EXTERNAL_SCROLL_EPSILON_PX
    );
  }

  private readonly step = (): void => {
    this.rafId = null;
    if (this.wasScrolledExternally()) {
      return;
    }

    const maxX = Math.max(0, this.el.scrollWidth - this.el.clientWidth);
    const maxY = Math.max(0, this.el.scrollHeight - this.el.clientHeight);
    this.targetX = Math.min(maxX, Math.max(0, this.targetX));
    this.targetY = Math.min(maxY, Math.max(0, this.targetY));

    const now = performance.now();
    const dt = Math.min(MAX_DT_MS, Math.max(1, now - this.lastTime));
    this.lastTime = now;

    const remX = this.targetX - this.posX;
    const remY = this.targetY - this.posY;
    const remaining = Math.hypot(remX, remY);
    const tau =
      remaining <= FAST_THRESHOLD_PX
        ? BASE_TAU_MS
        : Math.max(MIN_FAST_TAU_MS, BASE_TAU_MS / (1 + (remaining - FAST_THRESHOLD_PX) / FAST_RAMP_PX));
    const alpha = 1 - Math.exp(-dt / tau);

    this.posX += remX * alpha;
    this.posY += remY * alpha;

    const done =
      Math.abs(this.targetX - this.posX) < 0.75 &&
      Math.abs(this.targetY - this.posY) < 0.75;

    if (done) {
      this.posX = this.targetX;
      this.posY = this.targetY;
    }

    this.el.scrollLeft = this.posX;
    this.el.scrollTop = this.posY;
    this.lastAppliedX = this.el.scrollLeft;
    this.lastAppliedY = this.el.scrollTop;

    if (!done) {
      this.rafId = requestAnimationFrame(this.step);
    }
  };
}
