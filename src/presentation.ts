/**
 * Presentation mode: one page at a time over a black screen, fitted so the
 * whole page shows. Keys, clicks and the wheel turn pages; a small pill with
 * ‹ n / total › ✕ shows while the mouse moves. Esc or ✕ ends it.
 */
import { ICON_CHEVRON_LEFT, ICON_CHEVRON_RIGHT, ICON_CLOSE } from "./icons";

export type PresentAction = "next" | "prev" | "first" | "last" | "exit";

/** What a key does while presenting (null: nothing). */
export function presentActionForKey(key: string): PresentAction | null {
  switch (key) {
    case "ArrowRight": case "ArrowDown": case "PageDown": case " ": case "Enter":
      return "next";
    case "ArrowLeft": case "ArrowUp": case "PageUp": case "Backspace":
      return "prev";
    case "Home": return "first";
    case "End": return "last";
    case "Escape": return "exit";
    default: return null;
  }
}

/** The page shown after `action`, kept within 1…count. */
export function stepPage(page: number, count: number, action: Exclude<PresentAction, "exit">): number {
  const target = action === "next" ? page + 1
    : action === "prev" ? page - 1
    : action === "first" ? 1
    : count;
  return Math.min(Math.max(1, target), Math.max(1, count));
}

export interface PresentationLabels {
  prev: string;
  next: string;
  exit: string;
}

export interface PresentationHost {
  pageCount: number;
  /** Renders page `n` to fit `w` × `h` CSS pixels. */
  render(n: number, w: number, h: number): Promise<HTMLCanvasElement | null>;
  /** Called once when presenting ends, with the last page shown. */
  onExit(page: number): void;
}

/** Idle time before the controls and the cursor hide. */
const IDLE_MS = 2000;
/** Wheel travel that turns one page, and the pause before the next turn. */
const WHEEL_STEP = 40;
const WHEEL_PAUSE_MS = 350;
/**
 * While the window goes full screen it can pass through several sizes
 * (restored from maximized, then full screen, then stretched by hand on
 * Windows 10). The first page is shown only once the size has held still
 * this long, and never later than SETTLE_MAX_MS after the hold began.
 */
const SETTLE_QUIET_MS = 120;
const SETTLE_MAX_MS = 1200;
const SETTLE_POLL_MS = 30;

/** Resolves once `measure()` has returned the same size for `quietMs` (or after `maxMs`). */
export function waitForStableSize(
  measure: () => { w: number; h: number },
  quietMs = SETTLE_QUIET_MS,
  maxMs = SETTLE_MAX_MS,
  pollMs = SETTLE_POLL_MS,
): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    let last = measure();
    let since = start;
    const tick = () => {
      const now = Date.now();
      const cur = measure();
      if (cur.w !== last.w || cur.h !== last.h) { last = cur; since = now; }
      if (now - since >= quietMs || now - start >= maxMs) { resolve(cur); return; }
      setTimeout(tick, pollMs);
    };
    setTimeout(tick, pollMs);
  });
}

export class Presentation {
  readonly el: HTMLElement;
  private stage: HTMLElement;
  private counter: HTMLElement;
  private prevBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
  private page: number;
  /** Rendered pages for the current screen size, keyed by page number. */
  private cache = new Map<number, Promise<HTMLCanvasElement | null>>();
  private cacheSize = "";
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private wheelSum = 0;
  private wheelLockedUntil = 0;
  private closed = false;
  /** Bumped on every page change so a slow render never replaces a newer page. */
  private showToken = 0;
  /** True between open({ hold: true }) and reveal(): nothing is drawn yet. */
  private holding = false;

  constructor(private host: PresentationHost, startPage: number, labels: PresentationLabels) {
    this.page = Math.min(Math.max(1, startPage), Math.max(1, host.pageCount));

    this.el = document.createElement("div");
    this.el.className = "presentation";
    this.el.setAttribute("role", "dialog");
    this.el.setAttribute("aria-modal", "true");
    this.el.tabIndex = -1;

    this.stage = document.createElement("div");
    this.stage.className = "presentation-stage";

    const bar = document.createElement("div");
    bar.className = "presentation-bar";
    const btn = (icon: string, title: string, cls: string, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `presentation-btn ${cls}`;
      b.innerHTML = icon;
      b.title = title;
      b.setAttribute("aria-label", title);
      b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
      return b;
    };
    this.prevBtn = btn(ICON_CHEVRON_LEFT, labels.prev, "pres-prev", () => this.act("prev"));
    this.nextBtn = btn(ICON_CHEVRON_RIGHT, labels.next, "pres-next", () => this.act("next"));
    const exitBtn = btn(ICON_CLOSE, labels.exit, "pres-exit", () => this.act("exit"));
    this.counter = document.createElement("span");
    this.counter.className = "presentation-counter";
    this.counter.setAttribute("aria-live", "polite");
    const sep = document.createElement("span");
    sep.className = "presentation-sep";
    bar.append(this.prevBtn, this.counter, this.nextBtn, sep, exitBtn);
    // Clicks on the bar never turn pages.
    bar.addEventListener("mousedown", (e) => e.stopPropagation());

    this.el.append(this.stage, bar);

    this.el.addEventListener("mousedown", this.onMouseDown);
    this.el.addEventListener("contextmenu", (e) => e.preventDefault());
    this.el.addEventListener("mousemove", this.onMouseMove);
    this.el.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("keydown", this.onKey, true);
    window.addEventListener("resize", this.onResize);
  }

  get currentPage(): number { return this.page; }

  /**
   * Puts the presentation on screen and shows the start page. With `hold`,
   * the screen stays plain black until reveal(): the caller is about to
   * resize the window (full screen) and the page should appear once, at its
   * final size, instead of jumping through every size on the way.
   */
  open(opts: { hold?: boolean } = {}): void {
    this.holding = !!opts.hold;
    this.el.classList.toggle("holding", this.holding);
    document.body.append(this.el);
    this.el.focus();
    this.wake();
    if (!this.holding) void this.show();
  }

  /**
   * Starts drawing the page at `w` × `h` before reveal() so it is ready
   * when the window gets there (the screen size the window is heading to).
   */
  prefetch(w: number, h: number): void {
    if (this.closed || w <= 0 || h <= 0) return;
    void this.renderCached(this.page, Math.round(w), Math.round(h));
  }

  /**
   * Ends the hold: waits for the window size to settle, draws the page once
   * at that size, then fades it in.
   */
  async reveal(): Promise<void> {
    if (!this.holding || this.closed) return;
    await waitForStableSize(() => this.size());
    if (this.closed) return;
    await this.show();
    if (this.closed) return;
    this.holding = false;
    // Next frame, so the canvas is laid out before the fade starts.
    requestAnimationFrame(() => this.el.classList.remove("holding"));
  }

  private size(): { w: number; h: number } {
    return {
      w: this.el.clientWidth || window.innerWidth,
      h: this.el.clientHeight || window.innerHeight,
    };
  }

  /** Ends presenting; the host hears about it once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    window.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("resize", this.onResize);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.cache.clear();
    this.el.remove();
    this.host.onExit(this.page);
  }

  act(action: PresentAction): void {
    if (this.closed) return;
    if (action === "exit") { this.close(); return; }
    const target = stepPage(this.page, this.host.pageCount, action);
    if (target === this.page) return;
    this.page = target;
    // While holding, only the counter moves; reveal() draws the page.
    if (this.holding) { this.counter.textContent = `${target} / ${this.host.pageCount}`; return; }
    void this.show();
  }

  private renderCached(n: number, w: number, h: number): Promise<HTMLCanvasElement | null> {
    const size = `${w}x${h}`;
    if (size !== this.cacheSize) { this.cache.clear(); this.cacheSize = size; }
    let p = this.cache.get(n);
    if (!p) {
      p = this.host.render(n, w, h).catch(() => null);
      this.cache.set(n, p);
    }
    return p;
  }

  private async show(): Promise<void> {
    const token = ++this.showToken;
    const n = this.page;
    const count = this.host.pageCount;
    this.counter.textContent = `${n} / ${count}`;
    this.prevBtn.disabled = n <= 1;
    this.nextBtn.disabled = n >= count;

    const { w, h } = this.size();
    const canvas = await this.renderCached(n, w, h);
    if (token !== this.showToken || this.closed) return;
    if (canvas) this.stage.replaceChildren(canvas);

    // Keep the pages around this one ready, drop the rest.
    for (const k of this.cache.keys()) if (Math.abs(k - n) > 1) this.cache.delete(k);
    if (n < count) void this.renderCached(n + 1, w, h);
    if (n > 1) void this.renderCached(n - 1, w, h);
  }

  /** Where the pointer was at the last mouse move, in screen pixels. */
  private lastPointer: { x: number; y: number } | null = null;

  /**
   * Only a pointer that really moved wakes the controls. On Windows the
   * page also gets mouse moves without any movement, for instance when
   * what lies under the pointer changes (the pill fading out, a tooltip
   * closing): each one woke the controls, so the pill and the cursor kept
   * coming back and going away with the mouse standing still.
   */
  private onMouseMove = (e: MouseEvent): void => {
    const last = this.lastPointer;
    this.lastPointer = { x: e.screenX, y: e.screenY };
    if (last && last.x === e.screenX && last.y === e.screenY) return;
    this.wake();
  };

  /** Shows the controls and the cursor, then hides them after a pause. */
  private wake = (): void => {
    this.el.classList.remove("idle");
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.el.classList.add("idle"), IDLE_MS);
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button === 0) this.act("next");
    else if (e.button === 2) this.act("prev");
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const now = Date.now();
    if (now < this.wheelLockedUntil) return;
    this.wheelSum += e.deltaY;
    if (Math.abs(this.wheelSum) < WHEEL_STEP) return;
    this.act(this.wheelSum > 0 ? "next" : "prev");
    this.wheelSum = 0;
    this.wheelLockedUntil = now + WHEEL_PAUSE_MS;
  };

  /** Takes every key while presenting so the viewer behind never reacts. */
  private onKey = (e: KeyboardEvent): void => {
    if (e.key === "F12") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    // A focused control keeps Enter and Space for itself.
    if ((e.key === "Enter" || e.key === " ") && document.activeElement instanceof HTMLButtonElement
        && this.el.contains(document.activeElement)) {
      document.activeElement.click();
      return;
    }
    const action = presentActionForKey(e.key);
    if (action) this.act(action);
  };

  private onResize = (): void => {
    // reveal() waits for the size to settle itself.
    if (this.holding) return;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => { void this.show(); }, 120);
  };
}
