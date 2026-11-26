import { describe, it, expect } from "vitest";
import { a4WelcomeWidth, keepCentred, pageFitScale, planWindowFit } from "../window-fit";

const A4 = { width: 595, height: 842 };
const A4_LANDSCAPE = { width: 842, height: 595 };
const SCREEN = { width: 1920, height: 1040 };
const base = {
  window: { width: 1100, height: 840 },
  viewer: { width: 868, height: 752 },
  scrollbars: { width: 14, height: 0 },
  area: SCREEN,
};

describe("pageFitScale", () => {
  it("is limited by the height for a portrait page in a wide box", () => {
    expect(pageFitScale(A4, { width: 1000, height: 882 })).toBeCloseTo(1);
  });
  it("is limited by the width for a landscape page in a narrow box", () => {
    expect(pageFitScale(A4_LANDSCAPE, { width: 882, height: 1000 })).toBeCloseTo(1);
  });
});

describe("planWindowFit", () => {
  it("makes a portrait window for a portrait page, as tall as the screen allows", () => {
    const fit = planWindowFit({ ...base, page: A4, preferredScale: null });
    expect(fit.window.height).toBeLessThanOrEqual(Math.floor(SCREEN.height * 0.9) + 1);
    expect(Math.abs(fit.window.height - 88 - 40 - A4.height * fit.scale)).toBeLessThanOrEqual(1);
    expect(Math.abs(fit.window.width - 232 - 14 - 40 - A4.width * fit.scale)).toBeLessThanOrEqual(1);
  });

  it("makes a landscape window for a landscape page", () => {
    const fit = planWindowFit({ ...base, page: A4_LANDSCAPE, preferredScale: null });
    expect(Math.abs(fit.window.width - 246 - 40 - A4_LANDSCAPE.width * fit.scale)).toBeLessThanOrEqual(1);
    expect(Math.abs(fit.window.height - 88 - 40 - A4_LANDSCAPE.height * fit.scale)).toBeLessThanOrEqual(1);
    expect(fit.window.width).toBeGreaterThan(fit.window.height);
  });

  it("keeps the zoom from Settings when the page fits the screen at it", () => {
    const fit = planWindowFit({ ...base, page: A4_LANDSCAPE, preferredScale: 1 });
    expect(fit.preferredFits).toBe(true);
    expect(fit.scale).toBe(1);
    expect(fit.window).toEqual({ width: 842 + 40 + 246, height: 595 + 40 + 88 });
  });

  it("shrinks the page when the zoom from Settings does not fit the screen", () => {
    const fit = planWindowFit({ ...base, page: A4, preferredScale: 1.333 });
    expect(fit.preferredFits).toBe(false);
    expect(fit.scale).toBeLessThan(1.333);
  });

  it("never goes below the smallest window", () => {
    const fit = planWindowFit({ ...base, page: { width: 100, height: 100 }, preferredScale: 1 });
    expect(fit.window.width).toBeGreaterThanOrEqual(720);
    expect(fit.window.height).toBeGreaterThanOrEqual(480);
  });
});

describe("keepCentred", () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  it("keeps the window's centre", () => {
    expect(keepCentred({ x: 410, y: 100 }, { width: 1100, height: 840 }, { width: 700, height: 900 }, area))
      .toEqual({ x: 610, y: 70 });
  });
  it("stays inside the work area", () => {
    expect(keepCentred({ x: 1500, y: 600 }, { width: 400, height: 400 }, { width: 800, height: 900 }, area))
      .toEqual({ x: 1120, y: 140 });
  });
});

describe("a4WelcomeWidth", () => {
  it("sizes the window so the opening screen is A4 portrait", () => {
    const w = a4WelcomeWidth({ width: 1100, height: 1000 }, { width: 868, height: 882 }, 2560);
    expect(w).toBe(1100 + Math.round(882 / Math.SQRT2 - 868));
  });

  it("never goes under the minimum width", () => {
    expect(a4WelcomeWidth({ width: 800, height: 500 }, { width: 568, height: 380 }, 2560)).toBe(720);
  });

  it("never goes wider than the screen", () => {
    expect(a4WelcomeWidth({ width: 900, height: 2000 }, { width: 668, height: 1880 }, 1000)).toBe(950);
  });
});
