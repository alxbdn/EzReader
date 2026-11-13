import { describe, it, expect } from "vitest";
import { formatPageSize, formatPdfDate } from "../info-panel";

describe("formatPageSize", () => {
  it("shows A4 in centimetres with its name", () => {
    expect(formatPageSize(595.28, 841.89, "en")).toBe("21.0 × 29.7 cm (A4)");
  });

  it("recognises landscape pages and uses the UI language's decimal comma", () => {
    expect(formatPageSize(841.89, 595.28, "fr")).toBe("29,7 × 21,0 cm (A4)");
  });

  it("leaves unknown sizes unnamed", () => {
    expect(formatPageSize(720, 720, "en")).toBe("25.4 × 25.4 cm");
  });
});

describe("formatPdfDate", () => {
  it("parses PDF date strings", () => {
    const out = formatPdfDate("D:20240131120000Z", "en");
    expect(out).toContain("2024");
    expect(out).toContain("January");
  });

  it("returns null for missing or invalid dates", () => {
    expect(formatPdfDate(undefined, "en")).toBeNull();
    expect(formatPdfDate("", "en")).toBeNull();
    expect(formatPdfDate("not a date", "en")).toBeNull();
  });
});
