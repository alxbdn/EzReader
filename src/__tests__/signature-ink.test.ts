import { describe, it, expect } from "vitest";
import { fitVector, strokeSegments } from "../signature-ink";

describe("signature vectors", () => {
  it("turns each pen stroke into 9-number curve segments", () => {
    const line: [number, number][] = [[10, 10], [20, 12], [30, 18], [40, 30], [50, 45]];
    const segs = strokeSegments([line, [[5, 5]]]); // a lone dot draws nothing, as before
    expect(segs.length % 9).toBe(0);
    expect(segs.length).toBeGreaterThan(0);
    expect(segs.slice(0, 2)).toEqual([10, 10]);
    expect(segs.slice(-3, -1)).toEqual([50, 45]);
    for (let i = 8; i < segs.length; i += 9) {
      expect(segs[i]).toBeGreaterThanOrEqual(0.8);
      expect(segs[i]).toBeLessThanOrEqual(4);
    }
  });

  it("fits the ink in its own box, with half the widest line as margin", () => {
    const v = fitVector([100, 50, 110, 50, 120, 50, 130, 50, 2, 130, 50, 130, 60, 130, 70, 130, 80, 4])!;
    // x 100…130, y 50…80, margin 4/2 + 1 = 3.
    expect(v.w).toBe(36);
    expect(v.h).toBe(36);
    expect(v.segs.slice(0, 2)).toEqual([3, 3]);
    expect(v.segs[8]).toBe(2);
    expect(v.segs[17]).toBe(4);
    expect(v.segs.slice(15, 17)).toEqual([33, 33]);
  });

  it("has nothing to fit without ink", () => {
    expect(fitVector([])).toBeNull();
    expect(fitVector(strokeSegments([[[1, 1]]]))).toBeNull();
  });
});
