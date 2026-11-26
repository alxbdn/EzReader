import {
  defaultToolState,
  FONT_FAMILIES,
  HIGHLIGHT_PRESETS,
  INK_PRESETS,
  NOTE_PRESETS,
  SIGNATURE_PRESETS,
  STAMP_PRESETS,
  SYSTEM_FONTS,
  type ActiveToolState,
  type FontFamilyValue,
  rgbToHex,
  type RedactShape,
  type RgbColor,
  type ToolKind,
} from "./models";
import type { Translations } from "./i18n";
import type { AppMode, ToolbarEvent } from "./toolbar";
import { ColorRow, SliderRow } from "./color-row";
import {
  ICON_TOOL_TEXT,
  ICON_TOOL_PENCIL,
  ICON_TOOL_SHAPES,
  ICON_TOOL_NOTE,
  ICON_TOOL_HIGHLIGHT,
  ICON_TOOL_SIGN,
  ICON_STYLE_FREEFORM,
  ICON_STYLE_STRAIGHT,
  ICON_SHAPE_RECT,
  ICON_SHAPE_ELLIPSE,
  ICON_SHAPE_ARROW,
  ICON_OPT_TEXT_COLOR,
  ICON_OPT_OUTLINE,
  ICON_OPT_FILL,
  ICON_OPT_COLOR,
  ICON_CHECK,
  ICON_DISCARD,
  ICON_EDIT_TEXT,
  ICON_WATERMARK,
  ICON_IMAGE,
  ICON_REDACT_TEXT,
  ICON_REDACT_AREA,
  ICON_STAMP_CHECK,
  ICON_STAMP_CROSS,
  ICON_SHAPE_LASSO,
  ICON_SHAPE_POLY,
  ICON_CROP,
  ICON_STRAIGHTEN,
  ICON_PLUS,
  ICON_LOCK,
  ICON_REDACT_BAR,
  ICON_STAMP,
} from "./icons";
import { tintedPng } from "./stamp-maker";
import { StampStore } from "./stamp-store";

export type ToolGroup = "text" | "pencil" | "shapes" | "note" | "highlight" | "sign"
  | "etext" | "image" | "redact" | "stamp";
type RedactKind = "text" | "area";
type StampColorMode = "original" | "recolor";
type PencilStyle = "ink" | "line";
type ShapeStyle = "rect" | "circle" | "arrow";
type Key = keyof Translations;

const INK_COLORS: [string, string][] = INK_PRESETS;
const BACKGROUNDS: [string, string][] = [
  ["#ffffff", "White"], ["#fde047", "Yellow"], ["#fca5a5", "Pink"], ["#93c5fd", "Blue"], ["#86efac", "Green"],
];
const NOTE_COLORS: [string, string][] = NOTE_PRESETS;
const HIGHLIGHT_COLORS: [string, string][] = HIGHLIGHT_PRESETS;
const STAMP_COLORS: [string, string][] = STAMP_PRESETS;
const STAMP_MAX = StampStore.MAX;
const COLOR_KEYS: Record<string, Key> = {
  Black: "colBlack", Red: "colRed", Blue: "colBlue", Green: "colGreen", Yellow: "colYellow",
  White: "colWhite", Pink: "colPink", Orange: "colOrange", "Ink blue": "colInkBlue",
};
/** The translated name of a preset colour, named in English in the palettes. */
export function colorName(t: Partial<Translations>, english: string): string {
  const v = COLOR_KEYS[english] ? t[COLOR_KEYS[english]] : undefined;
  return typeof v === "string" ? v : english;
}
const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72];
const SIGNATURE_INKS: [string, string][] = SIGNATURE_PRESETS;

export const BRUSHES: { id: string; key: Key; fb: string; width: number; opacity: number }[] = [
  { id: "ballpoint", key: "brushBallpoint", fb: "Ballpoint pen", width: 1, opacity: 1 },
  { id: "fineliner", key: "brushFineliner", fb: "Fineliner", width: 2, opacity: 1 },
  { id: "fountain", key: "brushFountain", fb: "Fountain pen", width: 3, opacity: 1 },
  { id: "brush", key: "brushBrush", fb: "Brush", width: 6, opacity: 1 },
  { id: "calligraphy", key: "brushCalligraphy", fb: "Calligraphy", width: 4, opacity: 0.9 },
  { id: "marker", key: "brushMarker", fb: "Marker", width: 10, opacity: 0.7 },
  { id: "pencil", key: "brushPencil", fb: "Pencil", width: 1, opacity: 0.6 },
  { id: "charcoal", key: "brushCharcoal", fb: "Charcoal", width: 5, opacity: 0.55 },
  { id: "airbrush", key: "brushAirbrush", fb: "Airbrush", width: 12, opacity: 0.25 },
  { id: "watercolor", key: "brushWatercolor", fb: "Watercolor", width: 8, opacity: 0.4 },
];

export function brushOf(width: number, opacity: number): string | null {
  return BRUSHES.find((b) => b.width === width && Math.abs(b.opacity - opacity) < 0.005)?.id ?? null;
}

export interface SignatureChip { id: string; dataUrl: string }
export interface StampChip { id: string; name: string; dataUrl: string; ratio: number }

export class ToolRow {
  readonly row: HTMLElement;
  readonly options: HTMLElement;

  private state: ActiveToolState = defaultToolState();
  private mode: AppMode = "read";
  private group: ToolGroup | null = null;
  private panel: ToolGroup | null = null;
  private pencilStyle: PencilStyle = "ink";
  private shapeStyle: ShapeStyle = "rect";
  private redactKind: RedactKind = "area";
  private customStamp: string | null = null;
  private stampColorMode: StampColorMode = "original";
  private stamps: StampChip[] = [];
  private stampImgs = new Map<string, HTMLImageElement>();

  private groupBtns = new Map<ToolGroup, HTMLButtonElement>();
  private annotateSeg: HTMLElement;
  private editSeg: HTMLElement;
  private panels = new Map<ToolGroup, HTMLElement>();
  private hint: HTMLElement;
  private validate: HTMLElement;
  private pending = false;

  private t: Translations = {} as Translations;
  private texts: [HTMLElement, Key, string][] = [];
  private titles: [HTMLElement, Key, string][] = [];
  private colorRows: [ColorRow, Key, [string, string][], Key | null][] = [];
  private sliders: [SliderRow, Key, string][] = [];
  private fontGroups: [HTMLOptGroupElement, Key, string][] = [];

  private fontSelect!: HTMLSelectElement;
  private stdFonts!: HTMLOptGroupElement;
  private sysFonts!: HTMLOptGroupElement;
  private sizeSelect!: HTMLSelectElement;
  private biuBtns: HTMLButtonElement[] = [];
  private textColor!: ColorRow;
  private textBg!: ColorRow;
  private styleBtns = new Map<string, HTMLButtonElement>();
  private outline: ColorRow[] = [];
  private shapeOutline!: ColorRow;
  private lastStrokeWidth = 2;
  private fill: ColorRow[] = [];
  private shapeFillWrap!: HTMLElement;
  private pencilFillWrap!: HTMLElement;
  private thickness: SliderRow[] = [];
  private opacity: SliderRow[] = [];
  private noteColor!: ColorRow;
  private hlColor!: ColorRow;
  private hlOpacity!: SliderRow;
  private textTitle!: HTMLElement;
  private textBgWrap!: HTMLElement;
  private stampColor!: ColorRow;
  private stampColorWrap!: HTMLElement;
  private stampModeSeg!: HTMLElement;
  private stampModeBtns = new Map<StampColorMode, HTMLButtonElement>();
  private markBtns = new Map<string, HTMLButtonElement>();
  private stampList!: HTMLElement;
  private stampCount!: HTMLElement;
  private stampSize!: SliderRow;
  private stampSizeWrap!: HTMLElement;
  private redactBtns = new Map<RedactKind, HTMLButtonElement>();
  private redactShapes!: HTMLElement;
  private summary!: HTMLButtonElement;
  private panelCollapsed = false;
  private sigList!: HTMLElement;
  private sigNew!: HTMLButtonElement;
  private sigCount!: HTMLElement;
  private sigInk!: ColorRow;
  private signatures: SignatureChip[] = [];
  private brushBtns = new Map<string, HTMLButtonElement>();
  private brushWrap!: HTMLElement;
  onSync: ((title: string | null, mode: AppMode) => void) | null = null;
  /** Opens the options panel again, from the summary shown while it is folded. */
  onExpand: (() => void) | null = null;

  constructor(private emit: (e: ToolbarEvent) => void, private canSwitch: () => boolean) {
    this.row = document.createElement("div");
    this.row.className = "tb-row tb-tools";
    this.row.hidden = true;
    this.options = document.createElement("div");
    this.options.className = "tb-row tb-options";
    this.options.hidden = true;

    const defs: [ToolGroup, string, Key, string][] = [
      ["text", ICON_TOOL_TEXT, "toolText", "Text"],
      ["pencil", ICON_TOOL_PENCIL, "toolPencil", "Pencil"],
      ["shapes", ICON_TOOL_SHAPES, "toolShapes", "Shapes"],
      ["note", ICON_TOOL_NOTE, "toolNote", "Sticky note"],
      ["highlight", ICON_TOOL_HIGHLIGHT, "toolHighlight", "Highlighter"],
      ["sign", ICON_TOOL_SIGN, "toolSign", "Sign"],
    ];
    this.annotateSeg = this.segment("tool-seg");
    for (const [g, icon, key, fb] of defs) this.annotateSeg.append(this.groupButton(g, icon, key, fb));
    this.editSeg = document.createElement("div");
    this.editSeg.className = "tool-seg edit-tools";
    const contentSeg = this.segment("");
    const pageSeg = this.segment("");
    const watermark = document.createElement("button");
    watermark.type = "button";
    watermark.className = "tool-btn";
    watermark.dataset["tool"] = "watermark";
    watermark.innerHTML = ICON_WATERMARK;
    const wmLabel = document.createElement("span");
    this.text(wmLabel, "toolWatermark", "Watermark");
    watermark.append(wmLabel);
    this.title(watermark, "ttWatermark", "Watermark: burn a text into every page of a copy");
    watermark.addEventListener("click", () => {
      if (!this.canSwitch()) return;
      if (this.group) this.clearTool();
      this.emit({ type: "watermark" });
    });
    contentSeg.append(
      this.groupButton("etext", ICON_EDIT_TEXT, "toolEditText", "Edit text"),
      this.groupButton("image", ICON_IMAGE, "toolImage", "Image"),
      this.groupButton("redact", ICON_REDACT_BAR, "toolRedact", "Redact", "ttRedact", "Redact: hide text or an area for good"),
      watermark,
      this.groupButton("stamp", ICON_STAMP, "toolStamp", "Stamps", "ttStamp", "Stamps: a check mark, a cross or one of your stamps"),
    );
    pageSeg.append(
      this.pageButton("crop", ICON_CROP, "toolCrop", "Crop"),
      this.pageButton("straighten", ICON_STRAIGHTEN, "toolStraighten", "Straighten"),
    );
    const sep = document.createElement("span");
    sep.className = "tool-sep";
    this.editSeg.append(contentSeg, sep, pageSeg);

    this.hint = document.createElement("span");
    this.hint.className = "tb-hint";
    this.summary = document.createElement("button");
    this.summary.type = "button";
    this.summary.className = "tb-summary";
    this.summary.hidden = true;
    this.summary.addEventListener("click", () => this.onExpand?.());

    this.validate = document.createElement("div");
    this.validate.className = "tb-validate";
    const ok = this.roundBtn("validate-btn", ICON_CHECK, "ttValidate", "Validate (Enter)");
    ok.addEventListener("click", () => this.emit({ type: "draft-apply" }));
    const no = this.roundBtn("discard-btn", ICON_DISCARD, "ttDiscard", "Discard (Esc)");
    no.addEventListener("click", () => this.emit({ type: "draft-discard" }));
    this.validate.append(ok, no);
    this.validate.addEventListener("animationend", () => this.validate.classList.remove("shake"));

    this.row.append(this.annotateSeg, this.editSeg, this.hint, this.summary, this.validate);

    this.buildTextPanel();
    this.buildStrokePanel("pencil");
    this.buildStrokePanel("shapes");
    this.buildNotePanel();
    this.buildHighlightPanel();
    this.buildSignPanel();
    this.buildImagePanel();
    this.buildRedactPanel();
    this.buildStampPanel();
    for (const p of new Set(this.panels.values())) this.options.append(p);

    this.syncAll();
  }

  getStyle(): ActiveToolState { return { ...this.state }; }
  get activeGroup(): ToolGroup | null { return this.group; }

  setMode(mode: AppMode): void {
    this.mode = mode;
    if (this.group) this.clearTool();
    this.panel = null;
    this.syncAll();
  }

  setPending(pending: boolean): void {
    this.pending = pending;
    this.validate.classList.toggle("on", pending);
    this.syncHint();
  }

  shake(): void {
    this.validate.classList.remove("shake");
    void this.validate.offsetWidth;
    this.validate.classList.add("shake");
    this.syncHint();
  }

  clearTool(): void {
    this.group = null;
    this.state.tool = "select";
    if (this.panel && !this.isSelectionPanel) this.panel = null;
    this.syncAll();
    this.emit({ type: "tool-change", tool: "select" });
  }

  showTextStyles(st: Pick<ActiveToolState, "color" | "fontSize" | "bold" | "italic" | "underline"> & { fontFamily?: FontFamilyValue; fontName?: string | null; backgroundColor?: RgbColor | null }): void {
    this.state.color = { ...st.color };
    this.state.fontFamily = st.fontFamily ?? "helvetica";
    this.state.fontName = st.fontName ?? null;
    this.state.fontSize = st.fontSize;
    this.state.bold = st.bold;
    this.state.italic = st.italic;
    this.state.underline = st.underline;
    if (st.backgroundColor !== undefined) this.state.textBackground = st.backgroundColor ? { ...st.backgroundColor } : null;
    this.selectionPanel = this.mode === "edit" ? "etext" : "text";
    this.panel = this.selectionPanel;
    this.syncAll();
  }

  hideTextStyles(): void {
    this.hideSelectionPanel("text");
    this.hideSelectionPanel("etext");
  }

  showShapeStyles(st: { color: RgbColor; strokeWidth: number; fillColor?: RgbColor | null; opacity?: number }, panel: "pencil" | "shapes" = "shapes"): void {
    this.state.shapeColor = { ...st.color };
    this.state.strokeWidth = st.strokeWidth;
    this.state.fillColor = st.fillColor ? { ...st.fillColor } : null;
    this.state.opacity = st.opacity ?? 1;
    this.selectionPanel = panel;
    this.panel = panel;
    this.syncAll();
  }

  hideShapeStyles(): void {
    this.hideSelectionPanel("pencil");
    this.hideSelectionPanel("shapes");
  }

  showSignatureStyles(color: RgbColor): void {
    this.state.signatureColor = { ...color };
    this.selectionPanel = "sign";
    this.panel = "sign";
    this.syncAll();
  }

  hideSignatureStyles(): void { this.hideSelectionPanel("sign"); }

  showHighlightStyles(st: { color: RgbColor; opacity: number }): void {
    this.state.highlightColor = { ...st.color };
    this.state.highlightOpacity = st.opacity;
    this.selectionPanel = "highlight";
    this.panel = "highlight";
    this.syncAll();
  }

  hideHighlightStyles(): void { this.hideSelectionPanel("highlight"); }

  setSystemFonts(names: string[]): void {
    this.sysFonts.replaceChildren(...SYSTEM_FONTS.filter((f) => names.includes(f.name)).map((f) => {
      const o = document.createElement("option");
      o.value = `sys:${f.name}`;
      o.textContent = f.name;
      o.style.fontFamily = `"${f.name}"`;
      return o;
    }));
    this.sysFonts.hidden = this.sysFonts.children.length === 0;
    this.syncAll();
  }

  setSignatures(list: SignatureChip[]): void {
    this.signatures = list;
    this.renderSignatures();
  }

  private activeSignature: string | null = null;
  setActiveSignature(id: string | null): void {
    this.activeSignature = id;
    this.sigList?.querySelectorAll<HTMLElement>(".sig-chip").forEach((c) => {
      const on = c.dataset.id === id;
      c.classList.toggle("active", on);
      c.querySelector(".sig-chip-use")?.setAttribute("aria-pressed", String(on));
    });
  }

  applyTranslations(t: Translations): void {
    this.t = t;
    for (const [el, key, fb] of this.texts) el.textContent = this.tr(key, fb);
    for (const [el, key, fb] of this.titles) { el.title = this.tr(key, fb); el.setAttribute("aria-label", el.title); }
    for (const [row, key, presets, noneKey] of this.colorRows) {
      row.setTitles(this.tr(key, ""), presets.map(([, n]) => this.tr(COLOR_KEYS[n], n)),
        noneKey ? this.tr(noneKey, noneKey === "optNoOutline" ? "No outline" : "No background") : undefined,
        this.tr("optCustomColor", "Custom color"), this.tr("optEyedropper", "Pick a color from the screen"));
    }
    for (const [s, key, fb] of this.sliders) s.setLabel(this.tr(key, fb));
    for (const [g, key, fb] of this.fontGroups) g.label = this.tr(key, fb);
    this.renderSignatures();
    this.renderStamps();
    this.syncHint();
    this.syncSummary();
  }

  private selectionPanel: ToolGroup | null = null;
  private get isSelectionPanel(): boolean { return this.panel !== null && this.panel === this.selectionPanel && this.group !== this.panel; }

  private hideSelectionPanel(p: ToolGroup): void {
    if (this.selectionPanel === p) this.selectionPanel = null;
    if (this.panel === p && this.group !== p) {
      this.panel = this.group && this.panels.has(this.group) ? this.group : null;
      this.syncAll();
    }
  }

  private toolFor(g: ToolGroup): ToolKind {
    switch (g) {
      case "text": return "text";
      case "pencil": return this.pencilStyle;
      case "shapes": return this.shapeStyle;
      case "note": return "note";
      case "highlight": return "highlight";
      case "sign": return "signature";
      case "redact": return this.redactKind === "text" ? "redact-text" : "redact";
      case "etext": return "etext";
      case "image": return "image";
      case "stamp": return "stamp";
    }
  }

  private pickGroup(g: ToolGroup): void {
    if (this.group === g) { this.clearTool(); return; }
    if (!this.canSwitch()) return;
    this.group = g;
    this.selectionPanel = null;
    this.panel = this.panels.has(g) ? g : null;
    this.state.tool = this.toolFor(g);
    this.syncAll();
    this.emit({ type: "tool-change", tool: this.state.tool });
    if (g === "stamp") this.emit({ type: "style-change", style: this.getStyle() });
  }

  private pickRedact(kind: RedactKind): void {
    this.redactKind = kind;
    this.syncAll();
    if (this.group === "redact") {
      this.state.tool = this.toolFor("redact");
      this.emit({ type: "tool-change", tool: this.state.tool });
    }
  }

  private pickMark(mark: "check" | "cross"): void {
    this.state.stampMark = mark;
    this.customStamp = null;
    this.state.stampImage = null;
    this.changed();
  }

  private pickStamp(id: string): void {
    this.customStamp = id;
    this.syncStampImage();
    this.changed();
  }

  /** The picked picture stamp, recoloured when asked, as the tool places it. */
  private syncStampImage(): void {
    const chip = this.stamps.find((s) => s.id === this.customStamp);
    if (!chip) {
      this.customStamp = null;
      this.state.stampImage = null;
      return;
    }
    const data = chip.dataUrl.split(",")[1] ?? "";
    this.state.stampImage = { data, ratio: chip.ratio };
    if (this.stampColorMode !== "recolor") return;
    const img = this.stampImg(chip);
    const tint = () => {
      const tinted = tintedPng(img, this.state.stampColor);
      if (tinted && this.customStamp === chip.id && this.stampColorMode === "recolor") {
        this.state.stampImage = { data: tinted, ratio: chip.ratio };
      }
    };
    if (img.complete && img.naturalWidth) tint();
    else img.addEventListener("load", () => { tint(); this.emit({ type: "style-change", style: this.getStyle() }); }, { once: true });
  }

  private stampImg(chip: StampChip): HTMLImageElement {
    let img = this.stampImgs.get(chip.id);
    if (!img) {
      img = new Image();
      img.src = chip.dataUrl;
      this.stampImgs.set(chip.id, img);
    }
    return img;
  }

  private pickStyle(group: "pencil" | "shapes", style: PencilStyle | ShapeStyle): void {
    if (group === "pencil") this.pencilStyle = style as PencilStyle;
    else this.shapeStyle = style as ShapeStyle;
    this.syncAll();
    if (this.group === group) {
      this.state.tool = this.toolFor(group);
      this.emit({ type: "tool-change", tool: this.state.tool });
    }
  }

  private changed(): void {
    this.syncAll();
    this.emit({ type: "style-change", style: this.getStyle() });
  }

  private buildTextPanel(): void {
    const p = this.panelEl("text", "toolText", "Text");
    this.panels.set("etext", p);
    this.textTitle = p.querySelector(".opt-title")!;
    this.fontSelect = document.createElement("select");
    this.fontSelect.className = "opt-select";
    this.title(this.fontSelect, "optFont", "Font");
    this.stdFonts = document.createElement("optgroup");
    this.fontGroups.push([this.stdFonts, "optFontsStandard", "Standard"]);
    for (const f of FONT_FAMILIES) {
      const o = document.createElement("option");
      o.value = f.value;
      o.textContent = f.label;
      o.style.fontFamily = f.css;
      this.stdFonts.append(o);
    }
    this.sysFonts = document.createElement("optgroup");
    this.fontGroups.push([this.sysFonts, "optFontsInstalled", "On this computer"]);
    this.sysFonts.hidden = true;
    this.fontSelect.append(this.stdFonts, this.sysFonts);
    this.fontSelect.addEventListener("change", () => {
      const v = this.fontSelect.value;
      const sys = v.startsWith("sys:") ? SYSTEM_FONTS.find((f) => f.name === v.slice(4)) : undefined;
      this.state.fontName = sys ? sys.name : null;
      this.state.fontFamily = sys ? sys.fallback : v as FontFamilyValue;
      this.changed();
    });
    this.sizeSelect = document.createElement("select");
    this.sizeSelect.className = "opt-select opt-size";
    this.title(this.sizeSelect, "optSize", "Size");
    for (const n of FONT_SIZES) {
      const o = document.createElement("option");
      o.value = String(n);
      o.textContent = String(n);
      this.sizeSelect.append(o);
    }
    this.sizeSelect.addEventListener("change", () => {
      this.state.fontSize = Number(this.sizeSelect.value);
      this.changed();
    });

    const biu: ["bold" | "italic" | "underline", string, Key, string][] = [
      ["bold", "B", "ttBold", "Bold"], ["italic", "I", "ttItalic", "Italic"], ["underline", "U", "ttUnderline", "Underline"],
    ];
    const biuSeg = this.segment("opt-seg");
    this.biuBtns = biu.map(([k, label, key, fb]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `opt-btn opt-${k}`;
      b.textContent = label;
      b.dataset["k"] = k;
      this.title(b, key, fb);
      b.addEventListener("click", () => { this.state[k] = !this.state[k]; this.changed(); });
      biuSeg.append(b);
      return b;
    });

    this.textColor = this.colorRow(ICON_OPT_TEXT_COLOR, "optTextColor", INK_COLORS, null, (c) => {
      if (c) this.state.color = c;
      this.changed();
    });
    this.textBg = this.colorRow(ICON_OPT_FILL, "optBackground", BACKGROUNDS, "optNoBackground", (c) => {
      this.state.textBackground = c;
      this.changed();
    });
    this.textBgWrap = document.createElement("div");
    this.textBgWrap.className = "opt-group";
    this.textBgWrap.append(this.divider(), this.textBg.el);
    const line = document.createElement("div");
    line.className = "opt-line";
    line.append(this.sizeSelect, biuSeg);
    p.append(this.fontSelect, line, this.divider(), this.textColor.el, this.textBgWrap);
  }

  private buildStrokePanel(group: "pencil" | "shapes"): void {
    const p = this.panelEl(group, group === "pencil" ? "toolPencil" : "toolShapes", group === "pencil" ? "Pencil" : "Shapes");
    const styles: [string, string, Key, string][] = group === "pencil"
      ? [["ink", ICON_STYLE_FREEFORM, "styleFreeform", "Freeform"], ["line", ICON_STYLE_STRAIGHT, "styleStraight", "Straight"]]
      : [["rect", ICON_SHAPE_RECT, "shapeRect", "Rectangle"], ["circle", ICON_SHAPE_ELLIPSE, "shapeEllipse", "Ellipse"], ["arrow", ICON_SHAPE_ARROW, "shapeArrow", "Arrow"]];
    const seg = this.segment("opt-seg");
    for (const [style, icon, key, fb] of styles) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "opt-btn opt-style";
      b.innerHTML = icon;
      const label = document.createElement("span");
      this.text(label, key, fb);
      b.append(label);
      b.addEventListener("click", () => this.pickStyle(group, style as PencilStyle | ShapeStyle));
      this.styleBtns.set(`${group}:${style}`, b);
      seg.append(b);
    }

    // Shapes can drop their outline (like the background); a pencil stroke always shows.
    const shapes = group === "shapes";
    const outline = this.colorRow(ICON_OPT_OUTLINE, "optOutline", INK_COLORS, shapes ? "optNoOutline" : null, (c) => {
      if (c) {
        this.state.shapeColor = c;
        if (this.state.strokeWidth === 0) this.state.strokeWidth = this.lastStrokeWidth;
      } else {
        if (this.state.strokeWidth > 0) this.lastStrokeWidth = this.state.strokeWidth;
        this.state.strokeWidth = 0;
      }
      this.changed();
    });
    const fill = this.colorRow(ICON_OPT_FILL, "optBackground", BACKGROUNDS, "optNoBackground", (c) => {
      this.state.fillColor = c;
      this.changed();
    });
    const fillWrap = document.createElement("div");
    fillWrap.className = "opt-group";
    fillWrap.append(this.divider(), fill.el);
    if (group === "pencil") this.pencilFillWrap = fillWrap; else this.shapeFillWrap = fillWrap;

    const thick = this.slider(shapes ? 0 : 1, 12, " px", "optThickness", "Thickness", (v) => {
      this.state.strokeWidth = v;
      if (v > 0) this.lastStrokeWidth = v;
      this.changed();
    });
    const op = this.slider(10, 100, " %", "optOpacity", "Opacity", (v) => {
      this.state.opacity = v / 100;
      this.changed();
    });
    if (shapes) this.shapeOutline = outline; else this.outline.push(outline);
    this.fill.push(fill);
    this.thickness.push(thick);
    this.opacity.push(op);
    if (group === "pencil") {
      p.append(seg, this.buildBrushes(), this.divider(), outline.el, fillWrap, this.divider(), thick.el, op.el);
    } else {
      p.append(seg, this.divider(), outline.el, fillWrap, this.divider(), thick.el, op.el);
    }
  }

  private buildBrushes(): HTMLElement {
    this.brushWrap = document.createElement("div");
    this.brushWrap.className = "opt-brushes";
    const label = document.createElement("span");
    label.className = "opt-label";
    this.text(label, "optBrush", "Brush");
    const list = document.createElement("div");
    list.className = "brush-list";
    list.setAttribute("role", "listbox");
    for (const b of BRUSHES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "brush-item";
      btn.dataset["brush"] = b.id;
      btn.setAttribute("role", "option");
      const name = document.createElement("span");
      name.className = "brush-name";
      this.text(name, b.key, b.fb);
      const sw = Math.min(10, 0.6 + b.width * 0.85);
      btn.insertAdjacentHTML("beforeend",
        `<svg class="brush-sample" viewBox="0 0 120 20" preserveAspectRatio="none" aria-hidden="true"><path d="M4 12 C 30 4, 52 16, 78 9 S 108 6, 116 9" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="${sw}" opacity="${b.opacity}"/></svg>`);
      btn.prepend(name);
      btn.addEventListener("click", () => {
        this.state.strokeWidth = b.width;
        this.state.opacity = b.opacity;
        this.changed();
      });
      this.brushBtns.set(b.id, btn);
      list.append(btn);
    }
    this.brushWrap.append(label, list);
    return this.brushWrap;
  }

  private buildNotePanel(): void {
    const p = this.panelEl("note", "toolNote", "Sticky note");
    this.noteColor = this.colorRow(ICON_OPT_COLOR, "optColor", NOTE_COLORS, null, (c) => {
      if (c) this.state.noteColor = c;
      this.changed();
    });
    p.append(this.noteColor.el);
  }

  private buildHighlightPanel(): void {
    const p = this.panelEl("highlight", "toolHighlight", "Highlighter");
    this.hlColor = this.colorRow(ICON_OPT_COLOR, "optColor", HIGHLIGHT_COLORS, null, (c) => {
      if (c) this.state.highlightColor = c;
      this.changed();
    });
    this.hlOpacity = this.slider(10, 100, " %", "optOpacity", "Opacity", (v) => { this.state.highlightOpacity = v / 100; this.changed(); });
    p.append(this.hlColor.el, this.divider(), this.hlOpacity.el);
  }

  private buildSignPanel(): void {
    const p = this.panelEl("sign", "toolSign", "Sign");
    this.sigList = document.createElement("div");
    this.sigList.className = "sig-chips";
    this.sigNew = document.createElement("button");
    this.sigNew.type = "button";
    this.sigNew.className = "sig-new";
    this.text(this.sigNew, "sigNew", "+ New signature");
    this.sigNew.addEventListener("click", () => this.emit({ type: "signature" }));
    this.sigCount = document.createElement("span");
    this.sigCount.className = "opt-note";
    this.sigInk = this.colorRow(ICON_OPT_COLOR, "optInk", SIGNATURE_INKS, null, (c) => {
      if (c) this.state.signatureColor = c;
      this.changed();
    });
    p.append(this.sigList, this.sigNew, this.sigCount, this.divider(), this.sigInk.el);
  }

  private buildImagePanel(): void {
    const p = this.panelEl("image", "toolImage", "Image");
    const browse = document.createElement("button");
    browse.type = "button";
    browse.className = "opt-browse";
    this.text(browse, "optBrowse", "Browse…");
    browse.addEventListener("click", () => this.emit({ type: "image-browse" }));
    const note = document.createElement("span");
    note.className = "opt-note";
    this.text(note, "optImageDrop", "or drop a picture on the page to place it, or in the side panel to add it as a new page");
    p.append(browse, note);
  }

  private buildRedactPanel(): void {
    const p = this.panelEl("redact", "toolRedact", "Redact");
    const kinds: [RedactKind, string, Key, string][] = [
      ["text", ICON_REDACT_TEXT, "redactText", "Text"],
      ["area", ICON_REDACT_AREA, "redactArea", "An area"],
    ];
    const kindSeg = this.segment("opt-seg opt-split");
    for (const [kind, icon, key, fb] of kinds) {
      const b = this.optButton(icon, key, fb);
      b.dataset["redact"] = kind;
      b.addEventListener("click", () => this.pickRedact(kind));
      this.redactBtns.set(kind, b);
      kindSeg.append(b);
    }
    const shapes: [RedactShape, string, Key, string][] = [
      ["rect", ICON_SHAPE_RECT, "shapeRect", "Rectangle"],
      ["ellipse", ICON_SHAPE_ELLIPSE, "shapeEllipse", "Ellipse"],
      ["lasso", ICON_SHAPE_LASSO, "styleFreeform", "Freeform"],
      ["poly", ICON_SHAPE_POLY, "shapeStretch", "Stretchable"],
    ];
    const seg = this.segment("opt-seg opt-tiles");
    for (const [shape, icon, key, fb] of shapes) {
      const b = this.optButton(icon, key, fb);
      b.addEventListener("click", () => { this.state.redactShape = shape; this.changed(); });
      this.styleBtns.set(`redact:${shape}`, b);
      seg.append(b);
    }
    this.redactShapes = this.labelled("optShape", "Shape", seg);
    p.append(this.labelled("toolRedact", "Redact", kindSeg), this.redactShapes,
      this.lockNote("redactNote", "Permanent when saved: what is hidden is removed from the file."));
  }

  private buildStampPanel(): void {
    const p = this.panelEl("stamp", "toolStamp", "Stamp");
    const marks = this.segment("opt-seg opt-tiles opt-marks");
    for (const [mark, icon, key, fb] of [
      ["check", ICON_STAMP_CHECK, "toolCheck", "Check mark"], ["cross", ICON_STAMP_CROSS, "toolCross", "Cross"],
    ] as ["check" | "cross", string, Key, string][]) {
      const b = this.optButton(icon, key, fb);
      b.dataset["mark"] = mark;
      b.addEventListener("click", () => this.pickMark(mark));
      this.markBtns.set(mark, b);
      marks.append(b);
    }

    this.stampList = document.createElement("div");
    this.stampList.className = "stamp-chips";
    const mine = document.createElement("div");
    mine.className = "opt-field";
    const head = document.createElement("div");
    head.className = "opt-field-head";
    const label = document.createElement("span");
    label.className = "opt-label";
    this.text(label, "stampMine", "My stamps");
    this.stampCount = document.createElement("span");
    this.stampCount.className = "opt-label";
    head.append(label, this.stampCount);
    mine.append(head, this.stampList);

    this.stampModeSeg = this.segment("opt-seg opt-split");
    for (const [mode, key, fb] of [["original", "stmOriginal", "Original"], ["recolor", "stmRecolor", "Recolor"]] as [StampColorMode, Key, string][]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "opt-btn";
      this.text(b, key, fb);
      b.addEventListener("click", () => {
        this.stampColorMode = mode;
        this.syncStampImage();
        this.changed();
      });
      this.stampModeBtns.set(mode, b);
      this.stampModeSeg.append(b);
    }
    this.stampColor = this.colorRow(ICON_OPT_COLOR, "optColor", STAMP_COLORS, null, (c) => {
      if (c) this.state.stampColor = c;
      this.syncStampImage();
      this.changed();
    });
    this.stampColorWrap = document.createElement("div");
    this.stampColorWrap.className = "opt-field";
    this.stampColorWrap.append(this.stampModeSeg, this.stampColor.el);

    this.stampSize = this.slider(15, 80, " mm", "optSize", "Size", (v) => {
      this.state.stampSize = v;
      this.changed();
    });
    this.stampSizeWrap = this.stampSize.el;

    p.append(this.labelled("optType", "Type", marks), mine, this.stampColorWrap, this.stampSizeWrap);
  }

  setStamps(list: StampChip[]): void {
    this.stamps = list;
    for (const id of [...this.stampImgs.keys()]) if (!list.some((s) => s.id === id)) this.stampImgs.delete(id);
    if (this.customStamp && !list.some((s) => s.id === this.customStamp)) {
      this.customStamp = null;
      this.state.stampImage = null;
    }
    this.renderStamps();
    this.syncAll();
  }

  /** Picks a stamp just made, so the next click places it. */
  useStamp(id: string): void {
    if (this.group !== "stamp") this.pickGroup("stamp");
    this.pickStamp(id);
  }

  setPanelCollapsed(collapsed: boolean): void {
    this.panelCollapsed = collapsed;
    this.syncSummary();
  }

  get summaryText(): string { return this.summary.hidden ? "" : this.summary.textContent ?? ""; }

  private renderStamps(): void {
    if (!this.stampList) return;
    const chips = this.stamps.map((s) => {
      const chip = document.createElement("div");
      chip.className = "stamp-chip";
      chip.dataset.id = s.id;
      const use = document.createElement("button");
      use.type = "button";
      use.className = "stamp-chip-use";
      use.title = s.name;
      use.setAttribute("aria-label", s.name);
      const img = document.createElement("img");
      img.src = s.dataUrl;
      img.alt = "";
      use.append(img);
      use.addEventListener("click", () => this.pickStamp(s.id));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "sig-chip-del";
      del.textContent = "×";
      del.title = this.tr("stampDelete", "Delete this stamp");
      del.setAttribute("aria-label", del.title);
      del.addEventListener("click", () => this.emit({ type: "stamp-delete", id: s.id }));
      chip.append(use, del);
      return chip;
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "stamp-new";
    add.innerHTML = ICON_PLUS;
    const addLabel = document.createElement("span");
    addLabel.textContent = this.tr("stampCreate", "Create…");
    add.append(addLabel);
    add.title = this.tr("ttStampCreate", "Create a stamp from a PNG, JPEG or SVG picture");
    add.hidden = this.stamps.length >= STAMP_MAX;
    add.addEventListener("click", () => this.emit({ type: "stamp-create" }));
    this.stampList.replaceChildren(...chips, add);
    this.stampCount.textContent = this.stamps.length ? `${this.stamps.length}/${STAMP_MAX}` : "";
  }

  private renderSignatures(): void {
    if (!this.sigList) return;
    this.sigList.replaceChildren();
    for (const s of this.signatures) {
      const chip = document.createElement("div");
      chip.className = "sig-chip";
      chip.dataset.id = s.id;
      chip.classList.toggle("active", s.id === this.activeSignature);
      const use = document.createElement("button");
      use.type = "button";
      use.className = "sig-chip-use";
      use.title = this.tr("sigUse", "Place this signature");
      const img = document.createElement("img");
      img.src = s.dataUrl;
      img.alt = "";
      use.append(img);
      use.addEventListener("click", () => this.emit({ type: "signature-use", id: s.id }));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "sig-chip-del";
      del.textContent = "×";
      del.title = this.tr("sigDelete", "Delete this signature");
      del.setAttribute("aria-label", del.title);
      del.addEventListener("click", () => this.emit({ type: "signature-delete", id: s.id }));
      chip.append(use, del);
      this.sigList.append(chip);
    }
    this.sigCount.textContent = this.tr("sigSavedCount", "{n}/3 saved").replace("{n}", String(this.signatures.length));
  }

  private syncAll(): void {
    this.row.hidden = this.mode === "read";
    this.annotateSeg.hidden = this.mode !== "annotate";
    this.editSeg.hidden = this.mode !== "edit";
    for (const [g, b] of this.groupBtns) {
      const on = g === this.group;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    }
    const show = this.mode !== "read" && this.panel !== null && this.panels.has(this.panel);
    this.options.hidden = !show;
    const shown = this.panel ? this.panels.get(this.panel) : undefined;
    for (const el of this.panels.values()) el.hidden = el !== shown;
    const editText = this.panel === "etext";
    this.textTitle.textContent = editText ? this.tr("toolEditText", "Edit text") : this.tr("toolText", "Text");
    this.textBgWrap.hidden = editText;

    const st = this.state;
    this.fontSelect.value = st.fontName ? `sys:${st.fontName}` : st.fontFamily;
    if (st.fontName && this.fontSelect.value !== `sys:${st.fontName}`) {
      const o = document.createElement("option");
      o.value = `sys:${st.fontName}`;
      o.textContent = st.fontName;
      this.sysFonts.append(o);
      this.sysFonts.hidden = false;
      this.fontSelect.value = o.value;
    }
    this.sizeSelect.value = String(st.fontSize);
    if (this.sizeSelect.value !== String(st.fontSize)) {
      const o = document.createElement("option");
      o.value = o.textContent = String(st.fontSize);
      this.sizeSelect.append(o);
      this.sizeSelect.value = o.value;
    }
    for (const b of this.biuBtns) b.classList.toggle("active", !!st[b.dataset["k"] as "bold"]);
    this.textColor.set(st.color);
    this.textBg.set(st.textBackground);
    for (const r of this.outline) r.set(st.shapeColor);
    this.shapeOutline.set(st.strokeWidth === 0 ? null : st.shapeColor);
    for (const r of this.fill) r.set(st.fillColor);
    for (const s of this.thickness) s.set(st.strokeWidth);
    for (const s of this.opacity) s.set(st.opacity * 100);
    this.noteColor.set(st.noteColor);
    this.hlColor.set(st.highlightColor);
    this.hlOpacity.set(st.highlightOpacity * 100);
    for (const [k, b] of this.styleBtns) {
      const [g, style] = k.split(":");
      const current = g === "pencil" ? this.pencilStyle : g === "shapes" ? this.shapeStyle : st.redactShape;
      b.classList.toggle("active", style === current);
    }
    this.stampColor.set(st.stampColor);
    for (const [k, b] of this.redactBtns) b.classList.toggle("active", k === this.redactKind);
    this.redactShapes.hidden = this.redactKind !== "area";
    const custom = this.customStamp !== null;
    for (const [m, b] of this.markBtns) b.classList.toggle("active", !custom && m === st.stampMark);
    this.stampList.querySelectorAll<HTMLElement>(".stamp-chip").forEach((c) => {
      const on = c.dataset.id === this.customStamp;
      c.classList.toggle("active", on);
      c.querySelector(".stamp-chip-use")?.setAttribute("aria-pressed", String(on));
    });
    this.stampModeSeg.hidden = !custom;
    for (const [m, b] of this.stampModeBtns) b.classList.toggle("active", m === this.stampColorMode);
    this.stampColor.el.hidden = custom && this.stampColorMode === "original";
    this.stampSizeWrap.hidden = !custom;
    this.stampSize.set(st.stampSize);
    this.sigInk.set(st.signatureColor);
    const brush = brushOf(st.strokeWidth, st.opacity);
    for (const [id, b] of this.brushBtns) {
      const on = id === brush;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
    }
    this.pencilFillWrap.hidden = this.pencilStyle !== "ink" && this.selectionPanel !== "pencil";
    this.shapeFillWrap.hidden = this.shapeStyle === "arrow" && this.selectionPanel !== "shapes";
    this.brushWrap.hidden = this.pencilStyle !== "ink" && this.selectionPanel !== "pencil";
    this.syncHint();
    this.syncSummary();
    const title = show && shown ? shown.querySelector(".opt-title")?.textContent ?? null : null;
    this.onSync?.(title, this.mode);
  }

  get hintText(): string { return this.hint.textContent ?? ""; }

  private syncHint(): void {
    const hints: Record<ToolGroup, [Key, string]> = {
      text: ["hintText", "Click on the page to type. Enter places the text, Shift+Enter starts a new line."],
      pencil: ["hintPencil", "Draw on the page."],
      shapes: ["hintShapes", "Drag on the page to draw."],
      note: ["hintNote", "Click to stick a note, or drag to set its size. Double-click a note to write in it."],
      highlight: ["hintHighlight", "Select text to highlight it. Select it again to remove the highlight."],
      sign: ["hintSign", "Pick a signature, then click where it goes."],
      redact: this.redactKind === "text"
        ? ["hintRedactText", "Select text to redact it. Select it again to undo."]
        : ["hintRedact", "Drag over what must disappear."],
      etext: ["hintEditText", "Click existing text to replace it."],
      image: ["hintImage", "Browse for a picture, or drop one on the page."],
      stamp: ["hintStamp", "Click on the page to stamp."],
    };
    if (!this.pending && !this.group && this.mode === "edit") {
      this.hint.textContent = this.tr("hintEditPick", "Pick a tool. Crop and Straighten work on this page, the selected pages or all of them.");
      return;
    }
    const [key, fb] = this.pending ? ["hintPending", "Validate or discard your changes to continue."] as [Key, string]
      : this.group ? hints[this.group] : ["hintPick", "Pick a tool."] as [Key, string];
    this.hint.textContent = this.tr(key, fb);
  }

  /** One line on the tool's settings, shown in the tool row while the options panel is folded. */
  private syncSummary(): void {
    const parts = this.panelCollapsed && this.mode !== "read" && this.group ? this.summaryParts(this.group) : [];
    this.summary.hidden = parts.length === 0;
    this.summary.textContent = parts.join(" · ");
    this.summary.title = this.tr("ttStudioShow", "Show the panel");
    this.hint.hidden = !this.summary.hidden && !this.pending;
  }

  private summaryParts(g: ToolGroup): string[] {
    const st = this.state;
    const color = (presets: [string, string][], c: RgbColor) => {
      const hex = rgbToHex(c).toLowerCase();
      const p = presets.find(([h]) => h.toLowerCase() === hex);
      return p ? this.tr(COLOR_KEYS[p[1]], p[1]) : hex;
    };
    switch (g) {
      case "redact": {
        if (this.redactKind === "text") return [this.tr("redactText", "Text")];
        const shape = this.styleBtns.get(`redact:${st.redactShape}`)?.textContent ?? "";
        return [this.tr("redactArea", "An area"), shape];
      }
      case "stamp": {
        const chip = this.stamps.find((s) => s.id === this.customStamp);
        if (chip) {
          return [chip.name, this.stampColorMode === "recolor" ? color(STAMP_COLORS, st.stampColor) : this.tr("stmOriginal", "Original"), `${st.stampSize} mm`];
        }
        const mark = st.stampMark === "cross" ? this.tr("toolCross", "Cross") : this.tr("toolCheck", "Check mark");
        return [mark, color(STAMP_COLORS, st.stampColor)];
      }
      case "etext":
      case "text": {
        const font = st.fontName ?? FONT_FAMILIES.find((f) => f.value === st.fontFamily)?.label ?? "";
        return [font, String(st.fontSize)];
      }
      case "pencil":
      case "shapes":
        return [color(INK_COLORS, st.shapeColor), `${st.strokeWidth} px`];
      case "highlight":
        return [color(HIGHLIGHT_COLORS, st.highlightColor), `${Math.round(st.highlightOpacity * 100)} %`];
      case "note":
        return [color(NOTE_COLORS, st.noteColor)];
      case "sign":
        return [color(SIGNATURE_INKS, st.signatureColor)];
      case "image":
        return [];
    }
  }

  private tr(key: Key, fb: string): string {
    const v = this.t[key];
    return typeof v === "string" ? v : fb;
  }

  private text(el: HTMLElement, key: Key, fb: string): void {
    el.textContent = fb;
    this.texts.push([el, key, fb]);
  }

  private title(el: HTMLElement, key: Key, fb: string): void {
    el.title = fb;
    el.setAttribute("aria-label", fb);
    this.titles.push([el, key, fb]);
  }

  private segment(cls: string): HTMLElement {
    const d = document.createElement("div");
    d.className = `toolbar-segment ${cls}`;
    return d;
  }

  private divider(): HTMLElement {
    const d = document.createElement("span");
    d.className = "opt-divider";
    return d;
  }

  private groupButton(g: ToolGroup, icon: string, key: Key, fb: string, ttKey: Key = key, ttFb: string = fb): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tool-btn";
    b.dataset["group"] = g;
    b.innerHTML = icon;
    const label = document.createElement("span");
    this.text(label, key, fb);
    b.append(label);
    this.title(b, ttKey, ttFb);
    b.addEventListener("click", () => this.pickGroup(g));
    this.groupBtns.set(g, b);
    return b;
  }

  private pageButton(kind: "crop" | "straighten", icon: string, key: Key, fb: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tool-btn";
    b.dataset["adjust"] = kind;
    b.innerHTML = icon;
    const label = document.createElement("span");
    this.text(label, key, fb);
    b.append(label);
    this.title(b, key, fb);
    b.addEventListener("click", () => {
      if (!this.canSwitch()) return;
      if (this.group) this.clearTool();
      this.emit({ type: "adjust", kind });
    });
    return b;
  }

  private optButton(icon: string, key: Key, fb: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "opt-btn opt-style";
    b.innerHTML = icon;
    const label = document.createElement("span");
    this.text(label, key, fb);
    b.append(label);
    return b;
  }

  /** `el` under a small label, as a block of the options panel. */
  private labelled(key: Key, fb: string, el: HTMLElement): HTMLElement {
    const f = document.createElement("div");
    f.className = "opt-field";
    const label = document.createElement("span");
    label.className = "opt-label";
    this.text(label, key, fb);
    f.append(label, el);
    return f;
  }

  private lockNote(key: Key, fb: string): HTMLElement {
    const n = document.createElement("div");
    n.className = "opt-lock";
    n.innerHTML = ICON_LOCK;
    const t = document.createElement("span");
    this.text(t, key, fb);
    n.append(t);
    return n;
  }

  private roundBtn(cls: string, icon: string, key: Key, fb: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.innerHTML = icon;
    this.title(b, key, fb);
    return b;
  }

  private panelEl(g: ToolGroup, key: Key, fb: string): HTMLElement {
    const p = document.createElement("div");
    p.className = "opt-panel";
    p.hidden = true;
    const title = document.createElement("span");
    title.className = "opt-title";
    this.text(title, key, fb);
    p.append(title);
    this.panels.set(g, p);
    return p;
  }

  private colorRow(icon: string, key: Key, presets: [string, string][], noneKey: Key | null, onPick: (c: RgbColor | null) => void): ColorRow {
    const row = new ColorRow({
      icon, title: key, presets, customTitle: "Custom color", onPick,
      ...(noneKey ? { noneTitle: noneKey === "optNoOutline" ? "No outline" : "No background" } : {}),
    });
    this.colorRows.push([row, key, presets, noneKey]);
    return row;
  }

  private slider(min: number, max: number, unit: string, key: Key, fb: string, onChange: (v: number) => void): SliderRow {
    const s = new SliderRow(min, max, unit, onChange);
    s.setLabel(fb);
    this.sliders.push([s, key, fb]);
    return s;
  }
}
