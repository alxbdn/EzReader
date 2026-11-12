import { describe, it, expect } from "vitest";
import { formatPageSize, formatPdfDate } from "../info-panel";
import { AnnotationStore } from "../annotation-store";
import type { RectAnnotation } from "../models";

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

describe("AnnotationStore.moveLayer", () => {
  // Each rect is told apart by its width.
  const rect = (width: number): RectAnnotation => ({
    page: 1, kind: "rect", x: 0, y: 0, width, height: 10,
    color: { r: 0, g: 0, b: 0 }, strokeWidth: 1,
  });
  const order = (store: AnnotationStore) => store.getAll().map(x => (x as RectAnnotation).width);

  it("swaps an annotation with its neighbour and stops at the ends", () => {
    const store = new AnnotationStore();
    const [a, b, c] = [rect(1), rect(2), rect(3)];
    store.add(a); store.add(b); store.add(c);

    store.moveLayer(a, 1);
    expect(order(store)).toEqual([2, 1, 3]);

    store.moveLayer(c, 1); // already on top
    expect(order(store)).toEqual([2, 1, 3]);

    store.moveLayer(b, -1); // already at the bottom
    store.moveLayer(c, -1);
    expect(order(store)).toEqual([2, 3, 1]);
  });
});
