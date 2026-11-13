import { describe, expect, it } from "vitest";
import { isValidFileStem, splitFileName } from "../file-paths";

describe("splitFileName", () => {
  it("keeps the last extension apart", () => {
    expect(splitFileName("report.final.pdf")).toEqual(["report.final", ".pdf"]);
    expect(splitFileName("notes")).toEqual(["notes", ""]);
    expect(splitFileName(".hidden")).toEqual([".hidden", ""]);
  });
});

describe("isValidFileStem", () => {
  it("accepts ordinary names", () => {
    expect(isValidFileStem("Invoice 2026 (final)")).toBe(true);
    expect(isValidFileStem("été")).toBe(true);
  });

  it("refuses names Windows cannot store", () => {
    for (const bad of ["", "  ", "a/b", "a\\b", "a:b", "what?", "star*", "trailing.", "trailing ", "CON", "lpt1"]) {
      expect(isValidFileStem(bad), bad).toBe(false);
    }
  });
});
