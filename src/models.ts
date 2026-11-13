// PDF points are 1/72 inch; CSS pixels are 1/96 inch.
// Multiplying the pdf.js scale by this factor makes "100%" match actual size.
export const CSS_UNITS = 96 / 72;

/** Zoom limits, as a share of actual size. */
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 8.0;

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
  /** 0–1; absent means opaque. */
  opacity?: number;
}

export interface CircleAnnotation extends BaseAnnotation {
  kind: "circle";
  width: number;
  height: number;
  color: RgbColor;
  strokeWidth: number;
  /** Interior colour; null or absent means hollow. */
  fillColor?: RgbColor | null;
  /** 0–1; absent means opaque. */
  opacity?: number;
}

/**
 * A pencil stroke, straight line or arrow. The points are relative to the
 * box (0–1 from its left and bottom edges), so moving or resizing the box
 * moves or stretches the stroke with it.
 */
export interface InkAnnotation extends BaseAnnotation {
  kind: "ink";
  width: number;
  height: number;
  points: [number, number][];
  color: RgbColor;
  strokeWidth: number;
  /** Closes the stroke and fills it; null or absent means no fill. */
  fillColor?: RgbColor | null;
  /** 0–1; absent means opaque. */
  opacity?: number;
  /** Draws an arrowhead at the last point. */
  arrow?: boolean;
}

/** Highlighted text: one rectangle per line, in PDF points. */
export interface HighlightAnnotation extends BaseAnnotation {
  kind: "highlight";
  width: number;
  height: number;
  rects: { x: number; y: number; width: number; height: number }[];
  color: RgbColor;
  /** 0–1 */
  opacity: number;
}

/** A sticky note: a coloured square with text, drawn on the page. */
export interface NoteAnnotation extends BaseAnnotation {
  kind: "note";
  width: number;
  height: number;
  content: string;
  color: RgbColor;
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
  /** Box colour behind the text; null or absent means none. */
  backgroundColor?: RgbColor | null;
  /** Edited text: the original words' area, painted with the page colour first. */
  cover?: TextCover;
}

export interface TextCover { x: number; y: number; width: number; height: number; color: RgbColor }

export interface SignatureAnnotation extends BaseAnnotation {
  kind: "signature";
  width: number;
  height: number;
  /** Base64-encoded PNG (no data: URI prefix) */
  imageData: string;
}

/** A picture placed on the page; same fields as a signature. */
export interface ImageAnnotation extends BaseAnnotation {
  kind: "image";
  width: number;
  height: number;
  /** Base64-encoded PNG or JPEG (no data: URI prefix) */
  imageData: string;
}

export type StampMark = "check" | "cross";

/** A check mark or a cross. */
export interface StampAnnotation extends BaseAnnotation {
  kind: "stamp";
  width: number;
  height: number;
  mark: StampMark;
  color: RgbColor;
}

/** Outline of a redaction area. */
export type RedactShape = "rect" | "ellipse" | "lasso" | "poly";

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
  /** Absent means a rectangle. */
  shape?: RedactShape;
  /** Outline of a freeform or stretchable area, relative to the box (0–1 from its left and bottom edges). */
  points?: [number, number][];
}

export type Annotation =
  | RectAnnotation
  | CircleAnnotation
  | InkAnnotation
  | HighlightAnnotation
  | NoteAnnotation
  | TextAnnotation
  | SignatureAnnotation
  | ImageAnnotation
  | StampAnnotation
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

export type ToolKind =
  | "select" | "rect" | "circle" | "arrow" | "ink" | "line" | "highlight" | "note"
  | "text" | "signature" | "redact"
  /** Edit mode: replace existing text, place pictures, redact selected text, stamp. */
  | "etext" | "image" | "redact-text" | "stamp";

/** Tools that draw by dragging on the page (the overlay takes the mouse). */
export const DRAW_TOOLS: readonly ToolKind[] = ["rect", "circle", "arrow", "ink", "line", "note", "text", "redact", "stamp"];

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
  /** Opacity of new shapes and pencil strokes, 0–1. */
  opacity: number;
  /** Box colour behind new text, or null. */
  textBackground: RgbColor | null;
  highlightColor: RgbColor;
  highlightOpacity: number;
  noteColor: RgbColor;
  /** Outline of new redaction areas. */
  redactShape: RedactShape;
  stampMark: StampMark;
  stampColor: RgbColor;
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
    strokeWidth: 2,
    opacity: 1,
    textBackground: null,
    highlightColor: { r: 250, g: 204, b: 21 },
    highlightOpacity: 0.45,
    noteColor: { r: 253, g: 224, b: 71 },
    redactShape: "rect",
    stampMark: "check",
    stampColor: { r: 0, g: 0, b: 0 },
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
