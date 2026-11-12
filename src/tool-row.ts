import {
  defaultToolState,
  FONT_FAMILIES,
  type ActiveToolState,
  type FontFamilyValue,
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
  ICON_REDACT,
} from "./icons";

/** A button of the tool row; pencil and shapes each cover several tools. */
export type ToolGroup = "text" | "pencil" | "shapes" | "note" | "highlight" | "sign" | "redact";
type PencilStyle = "ink" | "line";
type ShapeStyle = "rect" | "circle" | "arrow";
type Key = keyof Translations;

const INK_COLORS: [string, string][] = [
  ["#000000", "Black"], ["#e53935", "Red"], ["#2563eb", "Blue"], ["#16a34a", "Green"], ["#facc15", "Yellow"],
];
const BACKGROUNDS: [string, string][] = [
  ["#ffffff", "White"], ["#fde047", "Yellow"], ["#fca5a5", "Pink"], ["#93c5fd", "Blue"], ["#86efac", "Green"],
];
const NOTE_COLORS: [string, string][] = [
  ["#fde047", "Yellow"], ["#f9a8d4", "Pink"], ["#93c5fd", "Blue"], ["#86efac", "Green"], ["#fdba74", "Orange"],
];
const HIGHLIGHT_COLORS: [string, string][] = [
  ["#facc15", "Yellow"], ["#4ade80", "Green"], ["#f472b6", "Pink"], ["#60a5fa", "Blue"], ["#fb923c", "Orange"],
];
const COLOR_KEYS: Record<string, Key> = {
  Black: "colBlack", Red: "colRed", Blue: "colBlue", Green: "colGreen", Yellow: "colYellow",
  White: "colWhite", Pink: "colPink", Orange: "colOrange",
};
const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72];

export interface SignatureChip { id: string; dataUrl: string }

/**
 * The tools of the Annotate and Edit modes (second toolbar row), the options
 * of the chosen tool (third row, unfolded under it), and the round
 * validate / discard buttons that every change has to go through.
 */
export class ToolRow {
  readonly row: HTMLElement;
  readonly options: HTMLElement;

  private state: ActiveToolState = defaultToolState();
  private mode: AppMode = "read";
  private group: ToolGroup | null = null;
  /** Options panel on show: the chosen tool's, or the selected annotation's. */
  private panel: ToolGroup | null = null;
  private pencilStyle: PencilStyle = "ink";
  private shapeStyle: ShapeStyle = "rect";

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

  // Text options
  private fontSelect!: HTMLSelectElement;
  private sizeSelect!: HTMLSelectElement;
  private biuBtns: HTMLButtonElement[] = [];
  private textColor!: ColorRow;
  private textBg!: ColorRow;
  // Pencil / shapes options (they share their style values)
  private styleBtns = new Map<string, HTMLButtonElement>();
  private outline: ColorRow[] = [];
  private fill: ColorRow[] = [];
  private shapeFillWrap!: HTMLElement;
  private pencilFillWrap!: HTMLElement;
  private thickness: SliderRow[] = [];
  private opacity: SliderRow[] = [];
  // Sticky note / highlighter
  private noteColor!: ColorRow;
  private hlColor!: ColorRow;
  private hlOpacity!: SliderRow;
  // Signatures
  private sigList!: HTMLElement;
  private sigNew!: HTMLButtonElement;
  private sigCount!: HTMLElement;
  private signatures: SignatureChip[] = [];

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
    this.editSeg = this.segment("tool-seg");
    this.editSeg.append(this.groupButton("redact", ICON_REDACT, "btnRedact", "Redact"));

    this.hint = document.createElement("span");
    this.hint.className = "tb-hint";

    this.validate = document.createElement("div");
    this.validate.className = "tb-validate";
    const ok = this.roundBtn("validate-btn", ICON_CHECK, "ttValidate", "Validate (Enter)");
    ok.addEventListener("click", () => this.emit({ type: "draft-apply" }));
    const no = this.roundBtn("discard-btn", ICON_DISCARD, "ttDiscard", "Discard (Esc)");
    no.addEventListener("click", () => this.emit({ type: "draft-discard" }));
    this.validate.append(ok, no);
    this.validate.addEventListener("animationend", () => this.validate.classList.remove("shake"));

    this.row.append(this.annotateSeg, this.editSeg, this.hint, this.validate);

    this.buildTextPanel();
    this.buildStrokePanel("pencil");
    this.buildStrokePanel("shapes");
    this.buildNotePanel();
    this.buildHighlightPanel();
    this.buildSignPanel();
    for (const p of this.panels.values()) this.options.append(p);

    this.syncAll();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  getStyle(): ActiveToolState { return { ...this.state }; }
  get activeGroup(): ToolGroup | null { return this.group; }

  setMode(mode: AppMode): void {
    this.mode = mode;
    if (this.group) this.clearTool();
    this.panel = null;
    this.syncAll();
  }

  /** Shows the round ✓ / ✕ buttons while changes wait for validation. */
  setPending(pending: boolean): void {
    this.pending = pending;
    this.validate.classList.toggle("on", pending);
    this.syncHint();
  }

  /** Shakes ✓ / ✕: validate or discard before doing anything else. */
  shake(): void {
    this.validate.classList.remove("shake");
    void this.validate.offsetWidth; // restart the animation
    this.validate.classList.add("shake");
    this.syncHint();
  }

  /** Drops the active tool (back to selecting and moving annotations). */
  clearTool(): void {
    this.group = null;
    this.state.tool = "select";
    if (this.panel && !this.isSelectionPanel) this.panel = null;
    this.syncAll();
    this.emit({ type: "tool-change", tool: "select" });
  }

  /** Options of the selected text annotation (or of new text). */
  showTextStyles(st: Pick<ActiveToolState, "color" | "fontSize" | "bold" | "italic" | "underline"> & { fontFamily?: FontFamilyValue; backgroundColor?: RgbColor | null }): void {
    this.state.color = { ...st.color };
    this.state.fontFamily = st.fontFamily ?? "helvetica";
    this.state.fontSize = st.fontSize;
    this.state.bold = st.bold;
    this.state.italic = st.italic;
    this.state.underline = st.underline;
    if (st.backgroundColor !== undefined) this.state.textBackground = st.backgroundColor ? { ...st.backgroundColor } : null;
    this.selectionPanel = "text";
    this.panel = "text";
    this.syncAll();
  }

  hideTextStyles(): void { this.hideSelectionPanel("text"); }

  /** Options of the selected shape or pencil stroke. */
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

  setSignatures(list: SignatureChip[]): void {
    this.signatures = list;
    this.renderSignatures();
  }

  applyTranslations(t: Translations): void {
    this.t = t;
    for (const [el, key, fb] of this.texts) el.textContent = this.tr(key, fb);
    for (const [el, key, fb] of this.titles) { el.title = this.tr(key, fb); el.setAttribute("aria-label", el.title); }
    for (const [row, key, presets, noneKey] of this.colorRows) {
      row.setTitles(this.tr(key, ""), presets.map(([, n]) => this.tr(COLOR_KEYS[n], n)),
        noneKey ? this.tr(noneKey, "No background") : undefined, this.tr("optCustomColor", "Custom color"));
    }
    for (const [s, key, fb] of this.sliders) s.setLabel(this.tr(key, fb));
    this.renderSignatures();
    this.syncHint();
  }

  // ── Tools ───────────────────────────────────────────────────────────────────

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
      case "redact": return "redact";
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
  }

  /** Freeform / straight, or rectangle / ellipse / arrow: same tool button, another drawing. */
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

  // ── Panels ──────────────────────────────────────────────────────────────────

  private buildTextPanel(): void {
    const p = this.panelEl("text", "toolText", "Text");
    this.fontSelect = document.createElement("select");
    this.fontSelect.className = "opt-select";
    this.title(this.fontSelect, "optFont", "Font");
    for (const f of FONT_FAMILIES) {
      const o = document.createElement("option");
      o.value = f.value;
      o.textContent = f.label;
      o.style.fontFamily = f.css;
      this.fontSelect.append(o);
    }
    this.fontSelect.addEventListener("change", () => {
      this.state.fontFamily = this.fontSelect.value as FontFamilyValue;
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
    p.append(this.fontSelect, this.sizeSelect, biuSeg, this.divider(), this.textColor.el, this.divider(), this.textBg.el);
  }

  /** Pencil and shapes: drawing style, outline, background, thickness, opacity. */
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

    const outline = this.colorRow(ICON_OPT_OUTLINE, "optOutline", INK_COLORS, null, (c) => {
      if (c) this.state.shapeColor = c;
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

    const thick = this.slider(1, 12, " px", "optThickness", "Thickness", (v) => { this.state.strokeWidth = v; this.changed(); });
    const op = this.slider(10, 100, " %", "optOpacity", "Opacity", (v) => { this.state.opacity = v / 100; this.changed(); });
    this.outline.push(outline);
    this.fill.push(fill);
    this.thickness.push(thick);
    this.opacity.push(op);
    p.append(seg, this.divider(), outline.el, fillWrap, this.divider(), thick.el, op.el);
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
    p.append(this.sigList, this.sigNew, this.sigCount);
  }

  private renderSignatures(): void {
    if (!this.sigList) return;
    this.sigList.replaceChildren();
    for (const s of this.signatures) {
      const chip = document.createElement("div");
      chip.className = "sig-chip";
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

  // ── Sync ────────────────────────────────────────────────────────────────────

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
    for (const [g, el] of this.panels) el.hidden = g !== this.panel;

    const st = this.state;
    this.fontSelect.value = st.fontFamily;
    this.sizeSelect.value = String(st.fontSize);
    if (this.sizeSelect.value !== String(st.fontSize)) {
      // A size not in the list (from an existing annotation): show it anyway.
      const o = document.createElement("option");
      o.value = o.textContent = String(st.fontSize);
      this.sizeSelect.append(o);
      this.sizeSelect.value = o.value;
    }
    for (const b of this.biuBtns) b.classList.toggle("active", !!st[b.dataset["k"] as "bold"]);
    this.textColor.set(st.color);
    this.textBg.set(st.textBackground);
    for (const r of this.outline) r.set(st.shapeColor);
    for (const r of this.fill) r.set(st.fillColor);
    for (const s of this.thickness) s.set(st.strokeWidth);
    for (const s of this.opacity) s.set(st.opacity * 100);
    this.noteColor.set(st.noteColor);
    this.hlColor.set(st.highlightColor);
    this.hlOpacity.set(st.highlightOpacity * 100);
    for (const [k, b] of this.styleBtns) {
      const [g, style] = k.split(":");
      b.classList.toggle("active", style === (g === "pencil" ? this.pencilStyle : this.shapeStyle));
    }
    // Straight lines and arrows have no inside to fill.
    this.pencilFillWrap.hidden = this.pencilStyle !== "ink" && this.selectionPanel !== "pencil";
    this.shapeFillWrap.hidden = this.shapeStyle === "arrow" && this.selectionPanel !== "shapes";
    this.syncHint();
  }

  private syncHint(): void {
    const hints: Record<ToolGroup, [Key, string]> = {
      text: ["hintText", "Click on the page to type. Enter places the text, Shift+Enter starts a new line."],
      pencil: ["hintPencil", "Draw on the page."],
      shapes: ["hintShapes", "Drag on the page to draw."],
      note: ["hintNote", "Click on the page to stick a note."],
      highlight: ["hintHighlight", "Select text to highlight it. Select it again to remove the highlight."],
      sign: ["hintSign", "Pick a signature, then click where it goes."],
      redact: ["hintRedact", "Drag over what must disappear."],
    };
    const [key, fb] = this.pending ? ["hintPending", "Validate or discard your changes to continue."] as [Key, string]
      : this.group ? hints[this.group] : ["hintPick", "Pick a tool."] as [Key, string];
    this.hint.textContent = this.tr(key, fb);
  }

  // ── DOM helpers ─────────────────────────────────────────────────────────────

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

  private groupButton(g: ToolGroup, icon: string, key: Key, fb: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tool-btn";
    b.dataset["group"] = g;
    b.innerHTML = icon;
    const label = document.createElement("span");
    this.text(label, key, fb);
    b.append(label);
    b.addEventListener("click", () => this.pickGroup(g));
    this.groupBtns.set(g, b);
    return b;
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
      ...(noneKey ? { noneTitle: "No background" } : {}),
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
