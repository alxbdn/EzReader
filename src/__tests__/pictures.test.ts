import { describe, expect, it } from "vitest";
import { fitWithin, isImagePath } from "../pictures";

describe("pictures", () => {
  it("recognises picture files", () => {
    expect(isImagePath("C:\\Photos\\Scan.JPG")).toBe(true);
    expect(isImagePath("/tmp/logo.webp")).toBe(true);
    expect(isImagePath("/tmp/report.pdf")).toBe(false);
  });

  it("scales down to fit, never up", () => {
    expect(fitWithin(800, 400, 400, 400)).toEqual({ width: 400, height: 200 });
    expect(fitWithin(100, 50, 400, 400)).toEqual({ width: 100, height: 50 });
    expect(fitWithin(300, 900, 600, 300)).toEqual({ width: 100, height: 300 });
  });
});
