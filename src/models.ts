export const CSS_UNITS = 96 / 72;

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 8.0;

export interface RgbColor {
  r: number;
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

interface BaseAnnotation {
  page: number;
  x: number;
  y: number;
}

export interface RectAnnotation extends BaseAnnotation {
  kind: "rect";
  width: number;
  height: number;
  color: RgbColor;
  strokeWidth: number;
  fillColor?: RgbColor | null;
  opacity?: number;
}

export interface CircleAnnotation extends BaseAnnotation {
  kind: "circle";
  width: number;
  height: number;
  color: RgbColor;
  strokeWidth: number;
  fillColor?: RgbColor | null;
  opacity?: number;
}

export interface InkAnnotation extends BaseAnnotation {
  kind: "ink";
  width: number;
  height: number;
  points: [number, number][];
  color: RgbColor;
  strokeWidth: number;
  fillColor?: RgbColor | null;
  opacity?: number;
  arrow?: boolean;
}

export interface HighlightAnnotation extends BaseAnnotation {
  kind: "highlight";
  width: number;
  height: number;
  rects: { x: number; y: number; width: number; height: number }[];
  color: RgbColor;
  opacity: number;
}

export interface NoteAnnotation extends BaseAnnotation {
  kind: "note";
  width: number;
  height: number;
  content: string;
  color: RgbColor;
}

export type TextAlignmentValue = "left" | "center" | "right";

export type FontFamilyValue = "helvetica" | "times" | "courier";

export const FONT_FAMILIES: { value: FontFamilyValue; label: string; css: string }[] = [
  { value: "helvetica", label: "Helvetica", css: `"Segoe UI", Helvetica, Arial, sans-serif` },
  { value: "times",     label: "Times",     css: `"Times New Roman", Times, serif` },
  { value: "courier",   label: "Courier",   css: `"Courier New", Courier, monospace` },
];

export const SYSTEM_FONTS: { name: string; fallback: FontFamilyValue }[] = [
  { name: "Arial", fallback: "helvetica" },
  { name: "Arial Black", fallback: "helvetica" },
  { name: "Verdana", fallback: "helvetica" },
  { name: "Tahoma", fallback: "helvetica" },
  { name: "Trebuchet MS", fallback: "helvetica" },
  { name: "Georgia", fallback: "times" },
  { name: "Times New Roman", fallback: "times" },
  { name: "Courier New", fallback: "courier" },
  { name: "Comic Sans MS", fallback: "helvetica" },
  { name: "Impact", fallback: "helvetica" },
  { name: "Palatino Linotype", fallback: "times" },
  { name: "Book Antiqua", fallback: "times" },
  { name: "Garamond", fallback: "times" },
  { name: "Century Gothic", fallback: "helvetica" },
  { name: "Franklin Gothic Medium", fallback: "helvetica" },
  { name: "Lucida Console", fallback: "courier" },
  { name: "Segoe UI", fallback: "helvetica" },
  { name: "Calibri", fallback: "helvetica" },
  { name: "Cambria", fallback: "times" },
  { name: "Candara", fallback: "helvetica" },
  { name: "Consolas", fallback: "courier" },
  { name: "Constantia", fallback: "times" },
  { name: "Corbel", fallback: "helvetica" },
  { name: "Helvetica Neue", fallback: "helvetica" },
  { name: "Avenir Next", fallback: "helvetica" },
  { name: "Futura", fallback: "helvetica" },
  { name: "Gill Sans", fallback: "helvetica" },
  { name: "Optima", fallback: "helvetica" },
  { name: "Baskerville", fallback: "times" },
  { name: "Menlo", fallback: "courier" },
  { name: "Aptos", fallback: "helvetica" },
  { name: "Calibri Light", fallback: "helvetica" },
  { name: "Arial Narrow", fallback: "helvetica" },
  { name: "Century Schoolbook", fallback: "times" },
  { name: "Bookman Old Style", fallback: "times" },
  { name: "Lucida Sans Unicode", fallback: "helvetica" },
  { name: "Microsoft Sans Serif", fallback: "helvetica" },
  { name: "Myriad Pro", fallback: "helvetica" },
  { name: "Roboto", fallback: "helvetica" },
  { name: "Open Sans", fallback: "helvetica" },
];

export function fontCss(family: FontFamilyValue | undefined, name?: string | null): string {
  const base = (FONT_FAMILIES.find(f => f.value === family) ?? FONT_FAMILIES[0]).css;
  return name ? `"${name.replace(/["\\]/g, "")}", ${base}` : base;
}

export interface TextAnnotation extends BaseAnnotation {
  kind: "text";
  width: number;
  content: string;
  color: RgbColor;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  alignment: TextAlignmentValue;
  fontFamily?: FontFamilyValue;
  fontName?: string;
  backgroundColor?: RgbColor | null;
  cover?: TextCover;
}

export interface TextCover { x: number; y: number; width: number; height: number; color: RgbColor }

export interface InkVector {
  w: number;
  h: number;
  segs: number[];
}

export interface SignatureAnnotation extends BaseAnnotation {
  kind: "signature";
  width: number;
  height: number;
  imageData: string;
  vector?: InkVector;
  color?: RgbColor;
}

export interface ImageAnnotation extends BaseAnnotation {
  kind: "image";
  width: number;
  height: number;
  imageData: string;
}

export type StampMark = "check" | "cross";

export interface StampAnnotation extends BaseAnnotation {
  kind: "stamp";
  width: number;
  height: number;
  mark: StampMark;
  color: RgbColor;
}

export type RedactShape = "rect" | "ellipse" | "lasso" | "poly";

export interface RedactAnnotation extends BaseAnnotation {
  kind: "redact";
  width: number;
  height: number;
  shape?: RedactShape;
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

export type StoredAnnotation = Exclude<Annotation, RedactAnnotation>;

export function isRedaction(a: Annotation): a is RedactAnnotation {
  return a.kind === "redact";
}

export interface FormFieldValue {
  name: string;
  value: string;
}

export type ToolKind =
  | "select" | "rect" | "circle" | "arrow" | "ink" | "line" | "highlight" | "note"
  | "text" | "signature" | "redact"
  | "etext" | "image" | "redact-text" | "stamp";

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
  fontName: string | null;
  shapeColor: RgbColor;
  fillColor: RgbColor | null;
  strokeWidth: number;
  opacity: number;
  textBackground: RgbColor | null;
  highlightColor: RgbColor;
  highlightOpacity: number;
  noteColor: RgbColor;
  redactShape: RedactShape;
  stampMark: StampMark;
  stampColor: RgbColor;
  signatureColor: RgbColor;
}

export const HIGHLIGHT_PRESETS: [string, string][] = [
  ["#fef08a", "Yellow"],
  ["#bbf7d0", "Green"],
  ["#fbcfe8", "Pink"],
  ["#bfdbfe", "Blue"],
  ["#fed7aa", "Orange"],
];

export const INK_PRESETS: [string, string][] = [
  ["#000000", "Black"], ["#e53935", "Red"], ["#2563eb", "Blue"], ["#16a34a", "Green"], ["#facc15", "Yellow"],
];
export const NOTE_PRESETS: [string, string][] = [
  ["#fde047", "Yellow"], ["#f9a8d4", "Pink"], ["#93c5fd", "Blue"], ["#86efac", "Green"], ["#fdba74", "Orange"],
];
export const STAMP_PRESETS: [string, string][] = [
  ["#000000", "Black"], ["#1e3a8a", "Ink blue"], ["#16a34a", "Green"], ["#dc2626", "Red"], ["#2563eb", "Blue"],
];
export const SIGNATURE_PRESETS: [string, string][] = [
  ["#18181b", "Black"], ["#1d4ed8", "Blue"], ["#dc2626", "Red"], ["#15803d", "Green"],
];

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
    fontName: null,
    shapeColor: { r: 229, g: 57, b: 53 },
    fillColor: null,
    strokeWidth: 2,
    opacity: 1,
    textBackground: null,
    highlightColor: { r: 254, g: 240, b: 138 },
    highlightOpacity: 0.55,
    noteColor: { r: 253, g: 224, b: 71 },
    redactShape: "rect",
    stampMark: "check",
    stampColor: { r: 0, g: 0, b: 0 },
    signatureColor: { r: 24, g: 24, b: 27 },
  };
}

export interface DocumentState {
  filePath: string | null;
  outputPath: string | null;
  pageCount: number;
  currentPage: number;
  zoomLevel: number;
  isDirty: boolean;
}

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
