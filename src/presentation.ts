import { ICON_CHEVRON_LEFT, ICON_CHEVRON_RIGHT, ICON_CLOSE } from "./icons";

export type PresentAction = "next" | "prev" | "first" | "last" | "exit";

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
  render(n: number, w: number, h: number): Promise<HTMLCanvasElement | null>;
  onExit(page: number): void;
}

const IDLE_MS = 2000;
const WHEEL_STEP = 40;
const WHEEL_PAUSE_MS = 350;
const SETTLE_QUIET_MS = 120;
const SETTLE_MAX_MS = 1200;
const SETTLE_POLL_MS = 30;

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
  private cache = new Map<number, Promise<HTMLCanvasElement | null>>();
  private cacheSize = "";
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private wheelSum = 0;
  private wheelLockedUntil = 0;
  private closed = false;
  private showToken = 0;
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

  open(opts: { hold?: boolean } = {}): void {
    this.holding = !!opts.hold;
    this.el.classList.toggle("holding", this.holding);
    document.body.append(this.el);
    this.el.focus();
    this.wake();
    if (!this.holding) void this.show();
  }

  prefetch(w: number, h: number): void {
    if (this.closed || w <= 0 || h <= 0) return;
    void this.renderCached(this.page, Math.round(w), Math.round(h));
  }

  async reveal(): Promise<void> {
    if (!this.holding || this.closed) return;
    await waitForStableSize(() => this.size());
    if (this.closed) return;
    await this.show();
    if (this.closed) return;
    this.holding = false;
    requestAnimationFrame(() => this.el.classList.remove("holding"));
  }

  private size(): { w: number; h: number } {
    return {
      w: this.el.clientWidth || window.innerWidth,
      h: this.el.clientHeight || window.innerHeight,
    };
  }

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

    for (const k of this.cache.keys()) if (Math.abs(k - n) > 1) this.cache.delete(k);
    if (n < count) void this.renderCached(n + 1, w, h);
    if (n > 1) void this.renderCached(n - 1, w, h);
  }

  private lastPointer: { x: number; y: number } | null = null;

  private onMouseMove = (e: MouseEvent): void => {
    const last = this.lastPointer;
    this.lastPointer = { x: e.screenX, y: e.screenY };
    if (last && last.x === e.screenX && last.y === e.screenY) return;
    this.wake();
  };

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

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === "F12") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if ((e.key === "Enter" || e.key === " ") && document.activeElement instanceof HTMLButtonElement
        && this.el.contains(document.activeElement)) {
      document.activeElement.click();
      return;
    }
    const action = presentActionForKey(e.key);
    if (action) this.act(action);
  };

  private onResize = (): void => {
    if (this.holding) return;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => { void this.show(); }, 120);
  };
}
