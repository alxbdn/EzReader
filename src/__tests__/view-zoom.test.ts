import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ViewZoom, snapZoom, type ZoomableView } from "../view-zoom";
import { CSS_UNITS } from "../models";
import { VIEWER_PADDING } from "../window-fit";

function fakeView(): ZoomableView & { reflows: number; loaded: boolean } {
  const v = {
    loaded: true,
    reflows: 0,
    scale: CSS_UNITS,
    shownScale: CSS_UNITS,
    isLoaded: () => v.loaded,
    clampScale: (s: number) => Math.min(8 * CSS_UNITS, Math.max(0.1 * CSS_UNITS, s)),
    setScale: async (s: number) => { v.scale = v.shownScale = v.clampScale(s); },
    previewScale: (s: number) => { v.shownScale = s; },
    reflow: () => { v.reflows++; },
  };
  return v;
}

function setup() {
  const view = fakeView();
  const shown = { modes: [] as string[], zoom: 0 };
  const zoom = new ViewZoom(view, {
    showFitMode: (m) => shown.modes.push(m),
    showZoom: (s) => { shown.zoom = s; },
    room: () => ({ width: 800 + VIEWER_PADDING, height: 600 + VIEWER_PADDING }),
    page: () => ({ width: 400, height: 600 }),
    center: () => ({ x: 0, y: 0 }),
    pixelsPerInch: () => 144,
  });
  return { view, shown, zoom };
}

describe("snapZoom", () => {
  it("steps to the next level and stops at the ends", () => {
    expect(snapZoom(CSS_UNITS, 1)).toBeCloseTo(1.1 * CSS_UNITS, 2);
    expect(snapZoom(CSS_UNITS, -1)).toBeCloseTo(0.9 * CSS_UNITS, 2);
    expect(snapZoom(100, 1)).toBeCloseTo(8 * CSS_UNITS, 2);
    expect(snapZoom(0, -1)).toBeCloseTo(0.1 * CSS_UNITS, 2);
  });
});

describe("ViewZoom", () => {
  it("fits the page width and leaves the fit mode on a zoom step", async () => {
    const { view, shown, zoom } = setup();
    await zoom.toggleFit("fit-width");
    expect(zoom.fitMode).toBe("fit-width");
    expect(view.scale).toBe(2);
    expect(shown.zoom).toBe(2);
    await zoom.step(1);
    expect(zoom.fitMode).toBe("none");
    expect(shown.modes.at(-1)).toBe("none");
    expect(view.scale).toBeGreaterThan(2);
  });

  it("turns a fit off when its button is pressed again", async () => {
    const { zoom } = setup();
    await zoom.toggleFit("fit-height");
    expect(zoom.fitMode).toBe("fit-height");
    await zoom.toggleFit("fit-height");
    expect(zoom.fitMode).toBe("none");
  });

  it("fits the whole page and refits after a resize", async () => {
    const { view, zoom } = setup();
    await zoom.fit("fit-page");
    expect(view.scale).toBeCloseTo(1, 5);
    await zoom.refit();
    expect(view.reflows).toBe(1);
  });

  it("only reflows on a resize without a fit mode", async () => {
    const { view, zoom } = setup();
    await zoom.refit();
    expect(view.reflows).toBe(1);
    expect(view.scale).toBe(CSS_UNITS);
  });

  it("applies the Settings preference", async () => {
    const { view, zoom } = setup();
    await zoom.applyPreference("150");
    expect(zoom.fitMode).toBe("none");
    expect(view.scale).toBeCloseTo(1.5 * CSS_UNITS, 5);
    await zoom.applyPreference("fit-width");
    expect(zoom.fitMode).toBe("fit-width");
  });

  it("shows the printed size from the screen's pixels per inch", async () => {
    const { view, zoom } = setup();
    await zoom.actualSize();
    expect(view.scale).toBe(2);
  });

  it("restores a saved mode or scale", async () => {
    const { view, zoom } = setup();
    await zoom.restore("none", 3);
    expect(view.scale).toBe(3);
    await zoom.restore("fit-width", 3);
    expect(view.scale).toBe(2);
  });

  it("does nothing until a document is loaded", async () => {
    const { view, zoom } = setup();
    view.loaded = false;
    await zoom.step(1);
    await zoom.toggleFit("fit-width");
    expect(view.scale).toBe(CSS_UNITS);
    expect(zoom.fitMode).toBe("none");
  });

  describe("wheel", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number);
    });
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

    it("gathers events into one preview, then draws once it settles", async () => {
      const { view, shown, zoom } = setup();
      await zoom.fit("fit-width");
      zoom.wheelBy(-100, { x: 1, y: 1 });
      zoom.wheelBy(-100, { x: 1, y: 1 });
      expect(zoom.fitMode).toBe("none");
      const setScale = vi.spyOn(view, "setScale");
      vi.advanceTimersByTime(16);
      expect(view.shownScale).toBeGreaterThan(2);
      expect(shown.zoom).toBe(view.shownScale);
      expect(setScale).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(setScale).toHaveBeenCalledTimes(1);
      expect(view.scale).toBe(view.shownScale);
    });
  });
});
