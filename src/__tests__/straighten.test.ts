import { describe, expect, it } from "vitest";
import { moveTextRuns, pageMap } from "../straighten";
import { apply3, type Mat3 } from "../warp";

const identity: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

describe("moveTextRuns", () => {
  it("keeps a run in place when nothing moves", () => {
    const runs = moveTextRuns([{ str: "Hello", transform: [12, 0, 0, 12, 72, 700], width: 30, height: 12 }], identity);
    expect(runs).toEqual([{ text: "Hello", x0: 72, y0: 700, x1: 102, y1: 700, size: 12 }]);
  });

  it("scales a run with the page", () => {
    const double: Mat3 = [2, 0, 0, 0, 2, 0, 0, 0, 1];
    const [run] = moveTextRuns([{ str: "Hi", transform: [10, 0, 0, 10, 5, 5], width: 8, height: 10 }], double);
    expect(run).toMatchObject({ x0: 10, y0: 10, x1: 26, y1: 10, size: 20 });
  });

  it("leaves out blank runs", () => {
    expect(moveTextRuns([{ str: "  ", transform: [10, 0, 0, 10, 0, 0], width: 5, height: 10 }], identity)).toEqual([]);
  });
});

describe("pageMap", () => {
  it("sends the quad's corners to the page's corners, in user space", () => {
    // A 100 × 200 pt page rendered at 2× with y pointing down.
    const shown = [2, 0, 0, -2, 0, 400];
    const quad: [number, number][] = [[0.1, 0.1], [0.9, 0.05], [0.95, 0.9], [0.05, 0.95]];
    const m = pageMap(shown, quad as never, 200, 400);
    // Top left of the quad (fraction 0.1, 0.1 of the picture) is user (10, 180).
    const [x, y] = apply3(m, [10, 180]);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(200, 6);
  });
});
