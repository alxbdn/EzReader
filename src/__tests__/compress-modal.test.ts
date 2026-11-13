import { describe, expect, it } from "vitest";
import { wontShrink } from "../compress-modal";

const estimate = { originalBytes: 1000, losslessBytes: 1000, balancedBytes: 600, maximumBytes: 1200 };

describe("wontShrink (FR-009)", () => {
  it("warns when a level gives a file as big or bigger", () => {
    expect(wontShrink("lossless", estimate, 1000)).toBe(true);
    expect(wontShrink("maximum", estimate, 1000)).toBe(true);
  });

  it("stays quiet when the file gets smaller", () => {
    expect(wontShrink("balanced", estimate, 1000)).toBe(false);
  });

  it("stays quiet before the estimate and for a target size", () => {
    expect(wontShrink("lossless", null, 1000)).toBe(false);
    expect(wontShrink("target", estimate, 1000)).toBe(false);
  });
});
