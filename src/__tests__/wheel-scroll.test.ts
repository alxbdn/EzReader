// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SmoothWheelScroller,
  normalizeWheelDelta,
  type WheelScrollTarget,
} from "../wheel-scroll";

describe("normalizeWheelDelta", () => {
  const base = {
    deltaX: 0,
    deltaY: 0,
    deltaMode: 0,
    shiftKey: false,
    horizontalMode: false,
    clientWidth: 800,
    clientHeight: 600,
  };

  it("converts line (deltaMode=1) and page (deltaMode=2) deltas to pixels as discrete", () => {
    expect(normalizeWheelDelta({ ...base, deltaY: 3, deltaMode: 1 })).toEqual({
      dx: 0,
      dy: 120,
      discrete: true,
    });
    expect(normalizeWheelDelta({ ...base, deltaY: 1, deltaMode: 2 })).toEqual({
      dx: 0,
      dy: 600,
      discrete: true,
    });
  });

  it("distinguishes fine touchpad deltas (<24px) from discrete mouse-wheel notches (>=24px)", () => {
    expect(normalizeWheelDelta({ ...base, deltaY: 12, deltaMode: 0 })).toEqual({
      dx: 0,
      dy: 12,
      discrete: false,
    });
    expect(normalizeWheelDelta({ ...base, deltaY: -24, deltaMode: 0 })).toEqual({
      dx: 0,
      dy: -24,
      discrete: true,
    });
    expect(normalizeWheelDelta({ ...base, deltaY: 100, deltaMode: 0 })).toEqual({
      dx: 0,
      dy: 100,
      discrete: true,
    });
  });

  it("redirects vertical wheel deltas to dx in horizontal mode or when Shift is held", () => {
    expect(normalizeWheelDelta({ ...base, deltaY: 3, deltaMode: 1, horizontalMode: true })).toEqual({
      dx: 120,
      dy: 0,
      discrete: true,
    });
    expect(normalizeWheelDelta({ ...base, deltaY: -80, deltaMode: 0, shiftKey: true })).toEqual({
      dx: -80,
      dy: 0,
      discrete: true,
    });
  });
});

describe("SmoothWheelScroller", () => {
  let target: WheelScrollTarget;

  beforeEach(() => {
    vi.useFakeTimers();
    target = {
      scrollLeft: 0,
      scrollTop: 0,
      scrollWidth: 1000,
      scrollHeight: 2000,
      clientWidth: 800,
      clientHeight: 600,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("smoothly interpolates scrollTop over multiple frames and clamps to max scroll range", () => {
    const scroller = new SmoothWheelScroller(target);
    scroller.scrollBy(0, 120);
    expect(scroller.isAnimating).toBe(true);

    vi.advanceTimersByTime(16);
    const afterFirstFrame = target.scrollTop;
    expect(afterFirstFrame).toBeGreaterThan(0);
    expect(afterFirstFrame).toBeLessThan(120);
    expect(scroller.isAnimating).toBe(true);

    vi.advanceTimersByTime(400);
    expect(target.scrollTop).toBe(120);
    expect(scroller.isAnimating).toBe(false);

    scroller.scrollBy(0, 5000);
    vi.advanceTimersByTime(500);
    expect(target.scrollTop).toBe(1400);
    expect(scroller.isAnimating).toBe(false);
  });

  it("accumulates consecutive wheel notches while an animation is in flight", () => {
    const scroller = new SmoothWheelScroller(target);
    scroller.scrollBy(0, 120);
    vi.advanceTimersByTime(32);
    expect(scroller.isAnimating).toBe(true);

    scroller.scrollBy(0, 120);
    vi.advanceTimersByTime(500);
    expect(target.scrollTop).toBe(240);
    expect(scroller.isAnimating).toBe(false);
  });

  it("yields immediately when external scrolling moves scrollTop", () => {
    const scroller = new SmoothWheelScroller(target);
    scroller.scrollBy(0, 300);
    vi.advanceTimersByTime(16);
    expect(scroller.isAnimating).toBe(true);

    target.scrollTop = 950;
    vi.advanceTimersByTime(16);
    expect(target.scrollTop).toBe(950);
    expect(scroller.isAnimating).toBe(false);
  });

  it("reduces smoothing lag on large accumulated deltas (free-spinning wheel)", () => {
    const slowTarget: WheelScrollTarget = { ...target, scrollHeight: 5000 };
    const fastTarget: WheelScrollTarget = { ...target, scrollHeight: 5000 };
    const slowScroller = new SmoothWheelScroller(slowTarget);
    const fastScroller = new SmoothWheelScroller(fastTarget);

    slowScroller.scrollBy(0, 120);
    fastScroller.scrollBy(0, 1200);

    vi.advanceTimersByTime(16);

    const slowFraction = slowTarget.scrollTop / 120;
    const fastFraction = fastTarget.scrollTop / 1200;
    expect(slowFraction).toBeCloseTo(1 - Math.exp(-16 / 45), 3);
    expect(fastFraction).toBeCloseTo(1 - Math.exp(-16 / 14), 3);
    expect(fastFraction).toBeGreaterThan(slowFraction * 2);
  });

  it("tracks real elapsed time up to 100ms across a slow main-thread frame", () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const queued: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      queued.push(cb);
      return queued.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    const scroller = new SmoothWheelScroller(target);
    scroller.scrollBy(0, 300);
    expect(queued).toHaveLength(1);

    now = 1080;
    queued.shift()!(now);
    const expectedTau = 45 / (1 + (300 - 240) / 300);
    expect(target.scrollTop).toBeCloseTo(300 * (1 - Math.exp(-80 / expectedTau)), 4);
  });
});
