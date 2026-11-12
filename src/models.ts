// PDF points are 1/72 inch; CSS pixels are 1/96 inch.
// Multiplying the pdf.js scale by this factor makes "100%" match actual size.
export const CSS_UNITS = 96 / 72;

// ── Colour ────────────────────────────────────────────────────────────────────

export interface RgbColor {
  r: number; // 0–255
  g: number;
  b: number;
}

export function hexToRgb(hex: string): RgbColor {
  const n = parseInt(hex.replace("#", ""), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex(c: RgbColor): string {
  return (
    "#" +
    [c.r, c.g, c.b]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")
  );
}

export function rgbToCss(c: RgbColor): string {
  return `rgb(${c.r},${c.g},${c.b})`;
}

// ── Annotations ───────────────────────────────────────────────────────────────

interface BaseAnnotation {
  /** 1-indexed page number */
  page: number;
  /** Left edge in PDF points (bottom-left origin) */
  x: number;
  /** Bottom edge in PDF points */
  y: number;
}

export interface RectAnnotation extends BaseAnnotation {
  kind: "rect";
  width: number;
  height: number;
  color: RgbColor;
  strokeWidth: number;
  /** Interior colour; null or absent means hollow. */
  fillColor?: RgbColor | null;
}

export interface CircleAnnotation extends BaseAnnotation {
  kind: "circle";
  width: number;
  height: number;
  color: RgbColor;
  strokeWidth: number;
  /** Interior colour; null or absent means hollow. */
  fillColor?: RgbColor | null;
}

export type TextAlignmentValue = "left" | "center" | "right";

/** PDF standard fonts: available in every viewer without embedding. */
export type FontFamilyValue = "helvetica" | "times" | "courier";

export const FONT_FAMILIES: { value: FontFamilyValue; label: string; css: string }[] = [
  { value: "helvetica", label: "Helvetica", css: `"Segoe UI", Helvetica, Arial, sans-serif` },
  { value: "times",     label: "Times",     css: `"Times New Roman", Times, serif` },
  { value: "courier",   label: "Courier",   css: `"Courier New", Courier, monospace` },
];

/** CSS font-family list that looks like the PDF font the text will be saved with. */
export function fontCss(family: FontFamilyValue | undefined): string {
  return (FONT_FAMILIES.find(f => f.value === family) ?? FONT_FAMILIES[0]).css;
}

export interface TextAnnotation extends BaseAnnotation {
  kind: "text";
  /** Bounding box width in PDF points (used for alignment and word-wrap) */
  width: number;
  content: string;
  color: RgbColor;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  alignment: TextAlignmentValue;
  /** Absent in files saved before font choice existed (Helvetica). */
  fontFamily?: FontFamilyValue;
}

export interface SignatureAnnotation extends BaseAnnotation {
  kind: "signature";
  width: number;
  height: number;
  /** Base64-encoded PNG (no data: URI prefix) */
  imageData: string;
}

/**
 * An area to black out. Until the document is saved it is an ordinary,
 * editable annotation; on save the page is rasterised with the area filled
 * and the original page content is dropped, so the hidden content is gone
 * for good (see DocumentSession and the `redact_pages` command).
 */
export interface RedactAnnotation extends BaseAnnotation {
  kind: "redact";
  width: number;
  height: number;
}

export type Annotation =
  | RectAnnotation
  | CircleAnnotation
  | TextAnnotation
  | SignatureAnnotation
  | RedactAnnotation;

/** Annotations the backend stores as editable metadata (everything but redactions). */
export type StoredAnnotation = Exclude<Annotation, RedactAnnotation>;

export function isRedaction(a: Annotation): a is RedactAnnotation {
  return a.kind === "redact";
}

// ── Form fields ───────────────────────────────────────────────────────────────

export interface FormFieldValue {
  /** Full PDF field name (dotted path for nested fields). */
  name: string;
  /** Text value, or "true"/"false" for checkboxes, or export value for radios. */
  value: string;
}

// ── Tool state ────────────────────────────────────────────────────────────────

export type ToolKind = "select" | "rect" | "circle" | "text" | "signature" | "redact";

export interface ActiveToolState {
  tool: ToolKind;
  color: RgbColor;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  alignment: TextAlignmentValue;
  fontFamily: FontFamilyValue;
  /** Outline colour of rectangles and ellipses (text uses `color`). */
  shapeColor: RgbColor;
  /** Interior colour of new shapes, or null for hollow. */
  fillColor: RgbColor | null;
  strokeWidth: number;
}

export function defaultToolState(): ActiveToolState {
  return {
    tool: "select",
    color: { r: 0, g: 0, b: 0 },
    fontSize: 14,
    bold: false,
    italic: false,
    underline: false,
    alignment: "left",
    fontFamily: "helvetica",
    // Red reads on white pages and on the dark toolbar alike.
    shapeColor: { r: 229, g: 57, b: 53 },
    fillColor: null,
    strokeWidth: 1.5,
  };
}

// ── Document state ────────────────────────────────────────────────────────────

export interface DocumentState {
  filePath: string | null;
  outputPath: string | null;
  pageCount: number;
  currentPage: number;
  zoomLevel: number;
  isDirty: boolean;
}

// ── Coordinate conversion ─────────────────────────────────────────────────────

/**
 * Convert canvas pixel coordinates (top-left origin, Y down) to PDF user-space
 * points (bottom-left origin, Y up).
 */
export function canvasToPdf(
  canvasX: number,
  canvasY: number,
  scale: number,
  pageHeightPt: number
): { x: number; y: number } {
  return {
    x: canvasX / scale,
    y: pageHeightPt - canvasY / scale,
  };
}

/**
 * Convert PDF user-space points to canvas pixel coordinates.
 */
export function pdfToCanvas(
  pdfX: number,
  pdfY: number,
  scale: number,
  pageHeightPt: number
): { x: number; y: number } {
  return {
    x: pdfX * scale,
    y: (pageHeightPt - pdfY) * scale,
  };
}
