import { describe, it, expect } from "vitest";
import { annotationColor } from "../canvas-overlay";
import { colorName } from "../tool-row";
import type { Annotation } from "../models";

const red = { r: 255, g: 0, b: 0 };

describe("selection pill colour", () => {
  it("shows the colour of every annotation that has one", () => {
    const rect: Annotation = { kind: "rect", page: 1, x: 0, y: 0, width: 1, height: 1, color: red, strokeWidth: 2 };
    const stamp: Annotation = { kind: "stamp", page: 1, x: 0, y: 0, width: 1, height: 1, mark: "check", color: red };
    expect(annotationColor(rect)).toEqual(red);
    expect(annotationColor(stamp)).toEqual(red);
  });

  it("has no colour for pictures, scanned signatures and redactions", () => {
    const image: Annotation = { kind: "image", page: 1, x: 0, y: 0, width: 1, height: 1, imageData: "" };
    const scanned: Annotation = { kind: "signature", page: 1, x: 0, y: 0, width: 1, height: 1, imageData: "", color: red };
    const drawn: Annotation = { ...scanned, vector: { w: 1, h: 1, segs: [] } };
    const redact: Annotation = { kind: "redact", page: 1, x: 0, y: 0, width: 1, height: 1 };
    expect(annotationColor(image)).toBeNull();
    expect(annotationColor(scanned)).toBeNull();
    expect(annotationColor(drawn)).toEqual(red);
    expect(annotationColor(redact)).toBeNull();
  });

  it("names preset colours in the window's language", () => {
    expect(colorName({ colRed: "Rouge" }, "Red")).toBe("Rouge");
    expect(colorName({}, "Red")).toBe("Red");
    expect(colorName({ colRed: "Rouge" }, "Teal")).toBe("Teal");
  });
});
