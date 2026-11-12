import {
  defaultToolState,
  hexToRgb,
  rgbToHex,
  type ActiveToolState,
  type TextAlignmentValue,
  type ToolKind,
  type FontFamilyValue,
  type RgbColor,
  FONT_FAMILIES,
  CSS_UNITS,
} from "./models";
import type { Translations } from "./i18n";
import {
  ICON_EDITOR_FREE_TEXT,
  ICON_EDITOR_SIGNATURE,
  ICON_RECT,
  ICON_CIRCLE,
  ICON_ALIGN_LEFT,
  ICON_ALIGN_CENTER,
  ICON_ALIGN_RIGHT,
  ICON_STROKE_WIDTH,
  ICON_REDACT,
  ICON_LAYER_UP,
  ICON_LAYER_DOWN,
  ICON_INFO,
  ICON_PAGES_1,
  ICON_PAGES_2,
  ICON_FILL,
  ICON_NO_FILL,
  ICON_SIDEBAR,
  ICON_SAVE,
  ICON_UNDO,
  ICON_REDO,
  ICON_HAND,
  ICON_POINTER,
  ICON_MINUS,
  ICON_PLUS,
  ICON_EXPORT,
  ICON_COMPRESS_LAYERS,
} from "./icons";
import { SearchPill } from "./search-pill";

/** What the main toolbar is set up for: reading, annotating or editing. */
export type AppMode = "read" | "annotate" | "edit";
/** What a plain drag does on the page: move around (hand) or select text. */
export type PointerMode = "hand" | "select";

type ToolbarEvent =
  | { type: "open" }
  | { type: "save" }
  | { type: "save-as" }
  | { type: "export" }
  | { type: "compress" }
  | { type: "rotate" }
  | { type: "zoom-in" }
  | { type: "zoom-out" }
  | { type: "zoom-set"; scale: number }
  | { type: "zoom-reset" }
  | { type: "zoom-real" }
  | { type: "columns"; n: number | null }
  | { type: "scroll-mode"; mode: "vertical" | "horizontal" }
  | { type: "info" }
  | { type: "fit-width" }
  | { type: "fit-height" }
  | { type: "mode-change"; mode: AppMode }
  | { type: "pointer-mode"; mode: PointerMode }
  | { type: "rename"; stem: string }
  | { type: "tool-change"; tool: ToolKind }
  | { type: "style-change"; style: ActiveToolState }
  | { type: "layer-change"; dir: "up" | "down" }
  | { type: "signature" }
  | { type: "pages" }
  | { type: "toggle-sidebar" }
  | { type: "select-all-pages" }
  | { type: "insert-blank" }
  | { type: "insert-pdf" }
  | { type: "extract-pages" }
  | { type: "split" }
  | { type: "print" }
  | { type: "settings" }
  | { type: "undo" }
  | { type: "redo" };

type EventHandler = (e: ToolbarEvent) => void;

interface MenuItemDef {
  label: keyof Translations;
  shortcut?: string;
  action: () => void;
  requiresDoc?: boolean;
}

interface MenuDef {
  id: string;
  label: keyof Translations;
  items: (MenuItemDef | null)[]; // null = separator
}

/** Splits "report.final.pdf" into ["report.final", ".pdf"]. */
export function splitFileName(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

/** True when `stem` can be used as a file name on Windows (and elsewhere). */
export function isValidFileStem(stem: string): boolean {
  if (!stem.trim() || stem !== stem.trimEnd() || stem.endsWith(".")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(stem)) return false;
  return !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem);
}

export class Toolbar {
  private state: ActiveToolState = defaultToolState();
  private handlers: EventHandler[] = [];

  private menuBarEl: HTMLElement;
  private contextEl: HTMLElement;
  private toolRow!: HTMLElement;
  readonly search: SearchPill;

  // Menu bar state
  private activeMenuId: string | null = null;
  private dropdowns = new Map<string, HTMLElement>();
  private menuButtons = new Map<string, HTMLButtonElement>();
  private docMenuEntries: HTMLButtonElement[] = [];
  private docTitleEl!: HTMLElement;
  private docTitleName!: HTMLButtonElement;
  private docTitleInput!: HTMLInputElement;
  private docTitleExt!: HTMLElement;
  private docName: string | null = null;
  private renameTitle = "Click to rename";

  // Main toolbar
  private mode: AppMode = "read";
  private pointer: PointerMode = "select";
  private modeBtns: HTMLButtonElement[] = [];
  private pointerBtns: HTMLButtonElement[] = [];
  private annotateTools!: HTMLElement;
  private editTools!: HTMLElement;
  private zoomLabel!: HTMLButtonElement;
  private zoomInput!: HTMLInputElement;
  private columnBtns: HTMLButtonElement[] = [];
  private infoBtn!: HTMLButtonElement;
  private sidebarBtn!: HTMLButtonElement;
  private saveBtn!: HTMLButtonElement;
  private _lastScale = CSS_UNITS;
  private toolBtns: Partial<Record<ToolKind, HTMLButtonElement>> = {};

  private _i18nText  = new Map<HTMLElement, keyof Translations>();
  private _i18nTitle = new Map<HTMLElement, keyof Translations>();

  // Text style section
  private textStyleSection!: HTMLElement;
  private colorPicker!: HTMLInputElement;
  private sizeInput!: HTMLInputElement;
  private boldBtn!: HTMLButtonElement;
  private italicBtn!: HTMLButtonElement;
  private underlineBtn!: HTMLButtonElement;
  private alignBtns: HTMLButtonElement[] = [];

  // Shape style section
  private shapeStyleSection!: HTMLElement;
  private shapeColorPicker!: HTMLInputElement;
  private shapeStrokeInput!: HTMLInputElement;
  private fillPicker!: HTMLInputElement;
  private noFillBtn!: HTMLButtonElement;
  /** Last fill colour picked, restored when fill is switched back on. */
  private lastFill: RgbColor = { r: 255, g: 235, b: 59 };
  private fontSelect!: HTMLSelectElement;

  constructor() {
    this.menuBarEl = document.getElementById("menubar-row")!;
    this.contextEl = document.getElementById("context-toolbar")!;
    this.search = new SearchPill();
    this.buildMenuBar();
    this.buildContextToolbar();
    this.setupMenuInteraction();
  }

  on(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  applyTranslations(t: Translations): void {
    this._i18nText.forEach((key, el)  => { const v = t[key]; if (v !== undefined) el.textContent = v; });
    this._i18nTitle.forEach((key, el) => { const v = t[key]; if (v !== undefined) el.title = v; });
    this.renameTitle = t.ttRename ?? "Click to rename";
    this.docTitleName.title = this.docName ? this.renameTitle : "";
    this.search.applyTranslations(t);
  }

  private reg(el: HTMLElement, text?: keyof Translations, title?: keyof Translations): void {
    if (text)  this._i18nText.set(el, text);
    if (title) this._i18nTitle.set(el, title);
  }

  private emit(e: ToolbarEvent): void {
    this.handlers.forEach((h) => h(e));
  }

  get currentMode(): AppMode { return this.mode; }
  get pointerMode(): PointerMode { return this.pointer; }

  updateZoom(scale: number): void {
    this._lastScale = scale;
    this.zoomLabel.textContent = `${Math.round(scale / CSS_UNITS * 100)} %`;
  }

  /** Fit modes are menu-only now; kept so callers need not care. */
  updateFitMode(_mode: "none" | "fit-width" | "fit-height"): void {}

  /** Highlights the one-page / two-page buttons. */
  updateLayout(columns: number | null, mode: "vertical" | "horizontal"): void {
    this.columnBtns.forEach(b => {
      b.classList.toggle("active", mode === "vertical" && Number(b.dataset["cols"]) === columns);
    });
  }

  setInfoOpen(open: boolean): void {
    this.infoBtn.classList.toggle("active", open);
  }

  /** Shows the open file's name in the title bar, with a dot while it has unsaved changes. */
  setDocTitle(name: string | null, dirty: boolean): void {
    this.docName = name;
    if (!this.docTitleEl.classList.contains("renaming")) this.docTitleName.textContent = name ?? "";
    this.docTitleName.title = name ? this.renameTitle : "";
    this.docTitleName.disabled = !name;
    this.docTitleEl.classList.toggle("dirty", !!name && dirty);
    this.saveBtn.classList.toggle("dirty", !!name && dirty);
    document.title = name ? `${dirty ? "• " : ""}${name} – EzReader` : "EzReader";
  }

  /** Shows the sidebar toggle as pressed while the thumbnails are visible. */
  updateSidebar(visible: boolean): void {
    this.sidebarBtn.classList.toggle("active", visible);
    this.sidebarBtn.setAttribute("aria-pressed", String(visible));
  }

  setLoaded(loaded: boolean): void {
    this.contextEl.style.display = loaded ? "flex" : "none";
    for (const btn of this.docMenuEntries) {
      btn.disabled = !loaded;
    }
    if (!loaded) this.search.close();
  }

  getStyle(): ActiveToolState {
    return { ...this.state };
  }

  showTextStyles(state: Pick<ActiveToolState, "color" | "fontSize" | "bold" | "italic" | "underline" | "alignment"> & { fontFamily?: FontFamilyValue }): void {
    this.state.color     = { ...state.color };
    this.state.fontFamily = state.fontFamily ?? "helvetica";
    this.fontSelect.value = this.state.fontFamily;
    this.state.fontSize  = state.fontSize;
    this.state.bold      = state.bold;
    this.state.italic    = state.italic;
    this.state.underline = state.underline;
    this.state.alignment = state.alignment;

    this.colorPicker.value = rgbToHex(state.color);
    this.sizeInput.value   = String(state.fontSize);
    this.boldBtn.classList.toggle("active",      state.bold);
    this.italicBtn.classList.toggle("active",    state.italic);
    this.underlineBtn.classList.toggle("active", state.underline);
    this.alignBtns.forEach(b => b.classList.toggle("active", b.dataset["align"] === state.alignment));

    this.textStyleSection.style.display = "flex";
  }

  hideTextStyles(): void {
    this.textStyleSection.style.display = "none";
  }

  /** Shows the shape controls for a shape (its outline is `color`) or for new shapes. */
  showShapeStyles(state: { color: RgbColor; strokeWidth: number; fillColor?: RgbColor | null }): void {
    this.state.shapeColor  = { ...state.color };
    this.state.strokeWidth = state.strokeWidth;
    this.state.fillColor   = state.fillColor ? { ...state.fillColor } : null;

    this.shapeColorPicker.value = rgbToHex(state.color);
    this.shapeStrokeInput.value = String(state.strokeWidth);
    this.syncFillControls();

    this.shapeStyleSection.style.display = "flex";
  }

  hideShapeStyles(): void {
    this.shapeStyleSection.style.display = "none";
  }

  private sep(): HTMLElement {
    const d = document.createElement("div");
    d.className = "toolbar-sep";
    return d;
  }

  private segment(...children: HTMLElement[]): HTMLElement {
    const d = document.createElement("div");
    d.className = "toolbar-segment";
    d.append(...children);
    return d;
  }

  private btn(label: string, title: string, cls = "btn"): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = cls;
    b.innerHTML = label;
    b.title = title;
    return b;
  }

  // ── Menu Bar ────────────────────────────────────────────────────────────────

  private getMenuDefs(): MenuDef[] {
    return [
      {
        id: "file",
        label: "menuFile",
        items: [
          { label: "btnOpen", shortcut: "Ctrl+O", action: () => this.emit({ type: "open" }) },
          null,
          { label: "btnSave", shortcut: "Ctrl+S", action: () => this.emit({ type: "save" }), requiresDoc: true },
          { label: "btnSaveAs", shortcut: "Ctrl+Shift+S", action: () => this.emit({ type: "save-as" }), requiresDoc: true },
          { label: "btnExport", action: () => this.emit({ type: "export" }), requiresDoc: true },
          { label: "btnCompress", shortcut: "Ctrl+Shift+E", action: () => this.emit({ type: "compress" }), requiresDoc: true },
          null,
          { label: "menuPrint", shortcut: "Ctrl+P", action: () => this.emit({ type: "print" }), requiresDoc: true },
          null,
          { label: "menuSettings", action: () => this.emit({ type: "settings" }) },
        ],
      },
      {
        id: "edit",
        label: "menuEdit",
        items: [
          { label: "menuUndo", shortcut: "Ctrl+Z", action: () => this.emit({ type: "undo" }), requiresDoc: true },
          { label: "menuRedo", shortcut: "Ctrl+Y", action: () => this.emit({ type: "redo" }), requiresDoc: true },
        ],
      },
      {
        id: "view",
        label: "menuView",
        items: [
          { label: "menuZoomIn", shortcut: "Ctrl++", action: () => this.emit({ type: "zoom-in" }), requiresDoc: true },
          { label: "menuZoomOut", shortcut: "Ctrl+−", action: () => this.emit({ type: "zoom-out" }), requiresDoc: true },
          { label: "menuResetZoom", shortcut: "Ctrl+0", action: () => this.emit({ type: "zoom-reset" }), requiresDoc: true },
          null,
          { label: "menuFitWidth", action: () => this.emit({ type: "fit-width" }), requiresDoc: true },
          { label: "menuFitHeight", action: () => this.emit({ type: "fit-height" }), requiresDoc: true },
          null,
          { label: "ttPages1", action: () => this.emit({ type: "columns", n: 1 }), requiresDoc: true },
          { label: "ttPages2", action: () => this.emit({ type: "columns", n: 2 }), requiresDoc: true },
          { label: "menuPages3", action: () => this.emit({ type: "columns", n: 3 }), requiresDoc: true },
          { label: "ttScrollVertical", action: () => this.emit({ type: "scroll-mode", mode: "vertical" }), requiresDoc: true },
          { label: "menuScrollHorizontal", action: () => this.emit({ type: "scroll-mode", mode: "horizontal" }), requiresDoc: true },
          null,
          { label: "menuRotate", action: () => this.emit({ type: "rotate" }), requiresDoc: true },
          { label: "menuPageSidebar", action: () => this.emit({ type: "toggle-sidebar" }), requiresDoc: true },
        ],
      },
      {
        id: "pages",
        label: "menuPages",
        items: [
          { label: "menuSelectAllPages", action: () => this.emit({ type: "select-all-pages" }), requiresDoc: true },
          null,
          { label: "menuInsertBlank", action: () => this.emit({ type: "insert-blank" }), requiresDoc: true },
          { label: "menuInsertPdf", action: () => this.emit({ type: "insert-pdf" }), requiresDoc: true },
          { label: "menuExtractPages", action: () => this.emit({ type: "extract-pages" }), requiresDoc: true },
          null,
          { label: "menuSplit", action: () => this.emit({ type: "split" }), requiresDoc: true },
        ],
      },
    ];
  }

  private buildMenuBar(): void {
    const menus = this.getMenuDefs();
    for (const menu of menus) {
      const wrapper = document.createElement("div");
      wrapper.style.position = "relative";
      wrapper.style.display = "inline-block";

      // Top-level menu button
      const menuBtn = document.createElement("button");
      menuBtn.className = "menubar-item";
      menuBtn.dataset["menuId"] = menu.id;
      this.reg(menuBtn, menu.label);
      this.menuButtons.set(menu.id, menuBtn);

      // Dropdown panel
      const dropdown = document.createElement("div");
      dropdown.className = "menu-dropdown";

      for (const item of menu.items) {
        if (item === null) {
          const sep = document.createElement("div");
          sep.className = "menu-sep";
          dropdown.append(sep);
          continue;
        }

        const entry = document.createElement("button");
        entry.className = "menu-entry";
        entry.tabIndex = -1;

        const labelSpan = document.createElement("span");
        this.reg(labelSpan, item.label);
        entry.append(labelSpan);

        if (item.shortcut) {
          const shortcutSpan = document.createElement("span");
          shortcutSpan.className = "shortcut";
          shortcutSpan.textContent = item.shortcut;
          entry.append(shortcutSpan);
        }

        const action = item.action;
        entry.addEventListener("click", () => {
          this.closeAllMenus();
          action();
        });

        if (item.requiresDoc) {
          entry.disabled = true; // disabled until setLoaded(true)
          this.docMenuEntries.push(entry);
        }

        dropdown.append(entry);
      }

      this.dropdowns.set(menu.id, dropdown);
      wrapper.append(menuBtn, dropdown);
      this.menuBarEl.append(wrapper);
    }

    this.buildDocTitle();
  }

  // ── File name (click to rename) ─────────────────────────────────────────────

  private buildDocTitle(): void {
    this.docTitleEl = document.createElement("div");
    this.docTitleEl.className = "doc-title";
    this.docTitleName = document.createElement("button");
    this.docTitleName.className = "doc-title-name";
    this.docTitleName.disabled = true;
    this.docTitleName.addEventListener("click", () => this.startRename());
    this.docTitleName.addEventListener("dblclick", (e) => e.stopPropagation());

    const field = document.createElement("label");
    field.className = "doc-title-field";
    this.docTitleInput = document.createElement("input");
    this.docTitleInput.className = "doc-title-input";
    this.docTitleInput.spellcheck = false;
    this.docTitleInput.autocomplete = "off";
    this.docTitleExt = document.createElement("span");
    this.docTitleExt.className = "doc-title-ext";
    field.append(this.docTitleInput, this.docTitleExt);
    field.addEventListener("dblclick", (e) => e.stopPropagation());

    this.docTitleInput.addEventListener("input", () => this.sizeTitleInput());
    this.docTitleInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); this.endRename(true); }
      else if (e.key === "Escape") { e.preventDefault(); this.endRename(false); }
    });
    this.docTitleInput.addEventListener("blur", () => this.endRename(true));

    const dirtyDot = document.createElement("span");
    dirtyDot.className = "doc-title-dirty";
    this.docTitleEl.append(this.docTitleName, field, dirtyDot);
    this.menuBarEl.append(this.docTitleEl);
  }

  private startRename(): void {
    if (!this.docName) return;
    const [stem, ext] = splitFileName(this.docName);
    this.docTitleInput.value = stem;
    this.docTitleExt.textContent = ext;
    this.docTitleEl.classList.add("renaming");
    this.sizeTitleInput();
    this.docTitleInput.focus();
    this.docTitleInput.select();
  }

  private endRename(commit: boolean): void {
    if (!this.docTitleEl.classList.contains("renaming")) return;
    this.docTitleEl.classList.remove("renaming");
    const stem = this.docTitleInput.value.trim();
    const [current] = splitFileName(this.docName ?? "");
    if (commit && stem && stem !== current) this.emit({ type: "rename", stem });
    this.docTitleName.textContent = this.docName ?? "";
  }

  private measureCtx: CanvasRenderingContext2D | null = null;

  /** Fits the rename field to its text, so the extension sits right after it. */
  private sizeTitleInput(): void {
    this.measureCtx ??= document.createElement("canvas").getContext("2d");
    const ctx = this.measureCtx;
    if (!ctx) return;
    ctx.font = getComputedStyle(this.docTitleInput).font;
    const w = ctx.measureText(this.docTitleInput.value || " ").width;
    this.docTitleInput.style.width = `${Math.ceil(w) + 6}px`;
  }

  private setupMenuInteraction(): void {
    // Click on menu button: toggle
    this.menuBarEl.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest(".menubar-item") as HTMLButtonElement | null;
      if (!btn) return;
      const id = btn.dataset["menuId"]!;
      if (this.activeMenuId === id) {
        this.closeAllMenus();
      } else {
        this.openMenu(id);
      }
    });

    // Hover: switch when another menu is already open
    this.menuBarEl.addEventListener("mouseover", (e) => {
      if (!this.activeMenuId) return;
      const btn = (e.target as HTMLElement).closest(".menubar-item") as HTMLButtonElement | null;
      if (!btn) return;
      const id = btn.dataset["menuId"]!;
      if (id !== this.activeMenuId) {
        this.openMenu(id);
      }
    });

    // Click outside: close
    document.addEventListener("mousedown", (e) => {
      if (!this.activeMenuId) return;
      if (this.menuBarEl.contains(e.target as Node)) return;
      this.closeAllMenus();
    });

    // Keyboard navigation
    document.addEventListener("keydown", (e) => {
      if (!this.activeMenuId) return;

      const dropdown = this.dropdowns.get(this.activeMenuId)!;
      const entries = Array.from(dropdown.querySelectorAll<HTMLButtonElement>(".menu-entry:not(:disabled)"));
      const currentIdx = entries.indexOf(document.activeElement as HTMLButtonElement);

      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.closeAllMenus();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopImmediatePropagation();
        const next = currentIdx < entries.length - 1 ? currentIdx + 1 : 0;
        entries[next]?.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopImmediatePropagation();
        const prev = currentIdx > 0 ? currentIdx - 1 : entries.length - 1;
        entries[prev]?.focus();
      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopImmediatePropagation();
        const menuIds = Array.from(this.menuButtons.keys());
        const curIdx = menuIds.indexOf(this.activeMenuId!);
        const nextIdx = e.key === "ArrowRight"
          ? (curIdx + 1) % menuIds.length
          : (curIdx - 1 + menuIds.length) % menuIds.length;
        this.openMenu(menuIds[nextIdx]);
      }
    });
  }

  private openMenu(id: string): void {
    // Close previous
    if (this.activeMenuId && this.activeMenuId !== id) {
      this.dropdowns.get(this.activeMenuId)?.classList.remove("open");
      this.menuButtons.get(this.activeMenuId)?.classList.remove("open");
    }

    this.activeMenuId = id;
    const dropdown = this.dropdowns.get(id)!;
    const btn = this.menuButtons.get(id)!;
    dropdown.classList.add("open");
    btn.classList.add("open");

    // Check if dropdown overflows right edge
    requestAnimationFrame(() => {
      const rect = dropdown.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        dropdown.style.left = "auto";
        dropdown.style.right = "0";
      } else {
        dropdown.style.left = "0";
        dropdown.style.right = "auto";
      }
    });

    // Focus first enabled entry
    const first = dropdown.querySelector<HTMLButtonElement>(".menu-entry:not(:disabled)");
    first?.focus();
  }

  private closeAllMenus(): void {
    if (!this.activeMenuId) return;
    this.dropdowns.get(this.activeMenuId)?.classList.remove("open");
    this.menuButtons.get(this.activeMenuId)?.classList.remove("open");
    this.activeMenuId = null;
  }


  // ── Main toolbar ────────────────────────────────────────────────────────────

  private buildContextToolbar(): void {
    const main = document.createElement("div");
    main.className = "tb-row tb-main";
    this.toolRow = document.createElement("div");
    this.toolRow.className = "tb-row tb-tools";
    this.toolRow.hidden = true;
    this.contextEl.append(main, this.toolRow);

    // Page thumbnails sidebar toggle
    this.sidebarBtn = this.btn(ICON_SIDEBAR, "Show or hide the page thumbnails", "icon-btn");
    this.reg(this.sidebarBtn, undefined, "ttPageSidebar");
    this.sidebarBtn.addEventListener("click", () => this.emit({ type: "toggle-sidebar" }));

    // Save, then undo / redo
    this.saveBtn = this.btn(ICON_SAVE, "Save (Ctrl+S)", "btn tb-save");
    const saveLabel = document.createElement("span");
    saveLabel.textContent = "Save";
    this.saveBtn.append(saveLabel);
    this.reg(saveLabel, "btnSave");
    this.reg(this.saveBtn, undefined, "ttSave");
    this.saveBtn.addEventListener("click", () => this.emit({ type: "save" }));

    const undo = this.btn(ICON_UNDO, "Undo (Ctrl+Z)", "icon-btn");
    this.reg(undo, undefined, "ttUndo");
    undo.addEventListener("click", () => this.emit({ type: "undo" }));
    const redo = this.btn(ICON_REDO, "Redo (Ctrl+Y)", "icon-btn");
    this.reg(redo, undefined, "ttRedo");
    redo.addEventListener("click", () => this.emit({ type: "redo" }));

    // Hand / select
    const pointerDefs: [PointerMode, string, keyof Translations, string][] = [
      ["hand", ICON_HAND, "ttHand", "Hand: drag to move around"],
      ["select", ICON_POINTER, "ttSelectText", "Select text"],
    ];
    this.pointerBtns = pointerDefs.map(([mode, icon, tt, fb]) => {
      const b = this.btn(icon, fb, "icon-btn");
      b.dataset["pointer"] = mode;
      this.reg(b, undefined, tt);
      b.addEventListener("click", () => this.setPointerMode(mode));
      return b;
    });
    this.syncPointerBtns();

    // Zoom: − / 100 % / + / 1:1
    const zoomOut = this.btn(ICON_MINUS, "Zoom out (Ctrl+−)", "icon-btn");
    this.reg(zoomOut, undefined, "ttZoomOut");
    zoomOut.addEventListener("click", () => this.emit({ type: "zoom-out" }));
    const zoomIn = this.btn(ICON_PLUS, "Zoom in (Ctrl++)", "icon-btn");
    this.reg(zoomIn, undefined, "ttZoomIn");
    zoomIn.addEventListener("click", () => this.emit({ type: "zoom-in" }));

    // The percentage resets the zoom; a double click lets you type a value.
    this.zoomLabel = this.btn("100 %", "Click to reset the zoom, double-click to type a value", "zoom-label");
    this.reg(this.zoomLabel, undefined, "ttZoomLabel");
    this.zoomLabel.addEventListener("click", () => this.emit({ type: "zoom-reset" }));
    this.zoomLabel.addEventListener("dblclick", () => this.startZoomEdit());
    this.zoomInput = document.createElement("input");
    this.zoomInput.type = "text";
    this.zoomInput.className = "zoom-input";
    this.zoomInput.hidden = true;
    this.zoomInput.inputMode = "numeric";
    this.reg(this.zoomInput, undefined, "ttZoomInput");
    this.zoomInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { this.commitZoomInput(); this.endZoomEdit(); }
      else if (e.key === "Escape") this.endZoomEdit();
    });
    this.zoomInput.addEventListener("blur", () => this.endZoomEdit());

    const realSizeBtn = this.btn("1:1", "Real size (1:1)", "icon-btn text-icon-btn");
    this.reg(realSizeBtn, undefined, "ttRealSize");
    realSizeBtn.addEventListener("click", () => this.emit({ type: "zoom-real" }));

    // One page / two pages per row; clicking the active one goes back to "as many as fit".
    const colDefs: [number, string, keyof Translations][] = [[1, ICON_PAGES_1, "ttPages1"], [2, ICON_PAGES_2, "ttPages2"]];
    this.columnBtns = colDefs.map(([n, icon, tt]) => {
      const b = this.btn(icon, `${n}`, "icon-btn");
      b.dataset["cols"] = String(n);
      this.reg(b, undefined, tt);
      b.addEventListener("click", () => this.emit({ type: "columns", n: b.classList.contains("active") ? null : n }));
      return b;
    });

    // Read / Annotate / Edit
    const modeDefs: [AppMode, keyof Translations, string][] = [
      ["read", "modeRead", "Read"], ["annotate", "modeAnnotate", "Annotate"], ["edit", "modeEdit", "Edit"],
    ];
    this.modeBtns = modeDefs.map(([mode, key, fb]) => {
      const b = document.createElement("button");
      b.className = "mode-btn";
      b.dataset["mode"] = mode;
      b.textContent = fb;
      this.reg(b, key);
      b.addEventListener("click", () => this.setMode(mode));
      return b;
    });
    const modeSeg = this.segment(...this.modeBtns);
    modeSeg.classList.add("mode-segment");

    // Right side: export, compress, info, then the search pill
    const exportBtn = this.btn(ICON_EXPORT, "Export a copy", "icon-btn tb-square");
    this.reg(exportBtn, undefined, "ttExport");
    exportBtn.addEventListener("click", () => this.emit({ type: "export" }));
    const compressBtn = this.btn(ICON_COMPRESS_LAYERS, "Compress", "icon-btn tb-square");
    this.reg(compressBtn, undefined, "ttCompress");
    compressBtn.addEventListener("click", () => this.emit({ type: "compress" }));
    this.infoBtn = this.btn(ICON_INFO, "Document info", "icon-btn tb-square");
    this.reg(this.infoBtn, undefined, "ttInfo");
    this.infoBtn.addEventListener("click", () => this.emit({ type: "info" }));
    const right = document.createElement("div");
    right.className = "toolbar-group tb-right";
    right.append(exportBtn, compressBtn, this.infoBtn, this.sep(), this.search.el);

    main.append(
      this.sidebarBtn, this.saveBtn, this.segment(undo, redo), this.sep(),
      this.segment(...this.pointerBtns),
      this.segment(zoomOut, this.zoomLabel, this.zoomInput, zoomIn, realSizeBtn),
      this.segment(...this.columnBtns), this.sep(),
      modeSeg, right,
    );
    this.updateLayout(null, "vertical");

    this.buildToolRow();
    this.syncModeBtns();
  }

  /** Second row: the tools of the Annotate or Edit mode and their options. */
  private buildToolRow(): void {
    // Annotate
    this.annotateTools = document.createElement("div");
    this.annotateTools.className = "toolbar-group tb-tool-group";
    const toolSegment = this.segment();
    const tools: [ToolKind, string, string, keyof Translations][] = [
      ["text",   ICON_EDITOR_FREE_TEXT, "Text",      "ttText"],
      ["rect",   ICON_RECT,             "Rectangle", "ttRect"],
      ["circle", ICON_CIRCLE,           "Circle",    "ttCircle"],
    ];
    for (const [kind, icon, title, ttKey] of tools) {
      const b = this.btn(icon, title, "icon-btn");
      this.reg(b, undefined, ttKey);
      b.addEventListener("click", () => this.setActiveTool(kind));
      this.toolBtns[kind] = b;
      toolSegment.append(b);
    }
    const signBtn = this.labeledBtn(ICON_EDITOR_SIGNATURE, "btnSign", "Sign", "ttSignature");
    signBtn.addEventListener("click", () => this.emit({ type: "signature" }));
    this.annotateTools.append(toolSegment, signBtn);

    // Edit
    this.editTools = document.createElement("div");
    this.editTools.className = "toolbar-group tb-tool-group";
    const redactBtn = this.labeledBtn(ICON_REDACT, "btnRedact", "Redact", "ttRedact");
    redactBtn.addEventListener("click", () => {
      if (this.state.tool === "redact") this.clearActiveTool();
      else this.setActiveTool("redact");
    });
    this.toolBtns["redact"] = redactBtn;
    this.editTools.append(redactBtn);

    this.toolRow.append(this.annotateTools, this.editTools);
    // Contextual style sections (hidden until a text or shape tool is used)
    this.buildTextStyleSection(this.toolRow);
    this.buildShapeStyleSection(this.toolRow);
  }

  /** Ghost button with an icon and a translated text label. */
  private labeledBtn(icon: string, label: keyof Translations, fallback: string, tooltip: keyof Translations): HTMLButtonElement {
    const b = this.btn(icon, fallback, "btn btn-ghost");
    const span = document.createElement("span");
    span.textContent = fallback;
    b.append(span);
    this.reg(span, label);
    this.reg(b, undefined, tooltip);
    return b;
  }

  /** Switches between reading, annotating and editing; any active tool is dropped. */
  setMode(mode: AppMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (this.state.tool !== "select") this.clearActiveTool();
    this.hideTextStyles();
    this.hideShapeStyles();
    this.syncModeBtns();
    this.emit({ type: "mode-change", mode });
  }

  private syncModeBtns(): void {
    for (const b of this.modeBtns) {
      const on = b.dataset["mode"] === this.mode;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    }
    this.toolRow.hidden = this.mode === "read";
    this.annotateTools.hidden = this.mode !== "annotate";
    this.editTools.hidden = this.mode !== "edit";
  }

  setPointerMode(mode: PointerMode): void {
    if (mode !== this.pointer) {
      this.pointer = mode;
      this.emit({ type: "pointer-mode", mode });
    }
    this.syncPointerBtns();
  }

  private syncPointerBtns(): void {
    for (const b of this.pointerBtns) {
      const on = b.dataset["pointer"] === this.pointer;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    }
  }

  private startZoomEdit(): void {
    this.zoomInput.value = String(Math.round(this._lastScale / CSS_UNITS * 100));
    this.zoomLabel.hidden = true;
    this.zoomInput.hidden = false;
    this.zoomInput.focus();
    this.zoomInput.select();
  }

  private endZoomEdit(): void {
    if (this.zoomInput.hidden) return;
    this.zoomInput.hidden = true;
    this.zoomLabel.hidden = false;
  }

  private buildTextStyleSection(container: HTMLElement): void {
    this.textStyleSection = document.createElement("div");
    this.textStyleSection.className = "toolbar-group";
    this.textStyleSection.style.cssText = "display:none;gap:4px;";

    this.textStyleSection.append(this.sep());

    // Colour
    this.colorPicker = document.createElement("input");
    this.colorPicker.type = "color";
    this.colorPicker.className = "color-picker";
    this.colorPicker.title = "Text colour";
    this.reg(this.colorPicker, undefined, "ttTextColor");
    this.colorPicker.value = rgbToHex(this.state.color);
    this.colorPicker.addEventListener("input", () => {
      this.state.color = hexToRgb(this.colorPicker.value);
      this.emitStyleChange();
    });
    this.textStyleSection.append(this.colorPicker);

    // Font family (PDF standard fonts)
    this.fontSelect = document.createElement("select");
    this.fontSelect.className = "toolbar-select";
    this.reg(this.fontSelect, undefined, "ttFont");
    for (const f of FONT_FAMILIES) {
      const opt = document.createElement("option");
      opt.value = f.value;
      opt.textContent = f.label;
      opt.style.fontFamily = f.css;
      this.fontSelect.append(opt);
    }
    this.fontSelect.value = this.state.fontFamily;
    this.fontSelect.addEventListener("change", () => {
      this.state.fontFamily = this.fontSelect.value as FontFamilyValue;
      this.emitStyleChange();
    });
    this.textStyleSection.append(this.fontSelect);

    // Font size
    this.sizeInput = document.createElement("input");
    this.sizeInput.type = "number";
    this.sizeInput.className = "toolbar-input";
    this.sizeInput.title = "Font size";
    this.sizeInput.value = String(this.state.fontSize);
    this.sizeInput.min = "6";
    this.sizeInput.max = "72";
    this.sizeInput.addEventListener("change", () => {
      const n = parseInt(this.sizeInput.value, 10);
      if (!isNaN(n) && n > 0) { this.state.fontSize = n; this.emitStyleChange(); }
    });
    this.textStyleSection.append(this.sizeInput);

    // Bold / Italic / Underline
    this.boldBtn      = this.btn("B", "Bold",      "icon-btn");
    this.italicBtn    = this.btn("I", "Italic",    "icon-btn");
    this.underlineBtn = this.btn("U", "Underline", "icon-btn");
    this.reg(this.boldBtn,      undefined, "ttBold");
    this.reg(this.italicBtn,    undefined, "ttItalic");
    this.reg(this.underlineBtn, undefined, "ttUnderline");
    this.boldBtn.style.fontWeight          = "700";
    this.italicBtn.style.fontStyle         = "italic";
    this.underlineBtn.style.textDecoration = "underline";

    ([
      [this.boldBtn,      "bold"]      as const,
      [this.italicBtn,    "italic"]    as const,
      [this.underlineBtn, "underline"] as const,
    ] as const).forEach(([b, key]) => {
      b.addEventListener("click", () => {
        (this.state[key] as boolean) = !this.state[key];
        b.classList.toggle("active", this.state[key] as boolean);
        this.emitStyleChange();
      });
    });
    this.textStyleSection.append(this.segment(this.boldBtn, this.italicBtn, this.underlineBtn));

    // Alignment
    const alignDefs: [TextAlignmentValue, string, string, keyof Translations][] = [
      ["left",   ICON_ALIGN_LEFT,   "Align left",   "ttAlignLeft"],
      ["center", ICON_ALIGN_CENTER, "Align center", "ttAlignCenter"],
      ["right",  ICON_ALIGN_RIGHT,  "Align right",  "ttAlignRight"],
    ];
    this.alignBtns = alignDefs.map(([val, icon, title, ttKey]) => {
      const b = this.btn(icon, title, "icon-btn");
      this.reg(b, undefined, ttKey);
      b.dataset["align"] = val;
      if (val === "left") b.classList.add("active");
      b.addEventListener("click", () => {
        this.state.alignment = val;
        this.alignBtns.forEach(ab => ab.classList.remove("active"));
        b.classList.add("active");
        this.emitStyleChange();
      });
      return b;
    });
    this.textStyleSection.append(this.segment(...this.alignBtns));

    // Layer order
    const frontBtn = this.btn(ICON_LAYER_UP,   "Move up one layer",   "icon-btn");
    const backBtn  = this.btn(ICON_LAYER_DOWN, "Move down one layer", "icon-btn");
    this.reg(frontBtn, undefined, "ttLayerUp");
    this.reg(backBtn,  undefined, "ttLayerDown");
    frontBtn.addEventListener("click", () => this.emit({ type: "layer-change", dir: "up" }));
    backBtn.addEventListener ("click", () => this.emit({ type: "layer-change", dir: "down" }));
    this.textStyleSection.append(this.segment(frontBtn, backBtn));

    container.append(this.textStyleSection);
  }

  private buildShapeStyleSection(container: HTMLElement): void {
    this.shapeStyleSection = document.createElement("div");
    this.shapeStyleSection.className = "toolbar-group";
    this.shapeStyleSection.style.cssText = "display:none;gap:4px;";

    this.shapeStyleSection.append(this.sep());

    // Stroke colour
    this.shapeColorPicker = document.createElement("input");
    this.shapeColorPicker.type = "color";
    this.shapeColorPicker.className = "color-picker";
    this.shapeColorPicker.title = "Stroke colour";
    this.reg(this.shapeColorPicker, undefined, "ttStrokeColor");
    this.shapeColorPicker.value = rgbToHex(this.state.shapeColor);
    this.shapeColorPicker.addEventListener("input", () => {
      this.state.shapeColor = hexToRgb(this.shapeColorPicker.value);
      this.emitStyleChange();
    });

    // Fill: colour, or none
    this.fillPicker = document.createElement("input");
    this.fillPicker.type = "color";
    this.fillPicker.className = "color-picker";
    this.reg(this.fillPicker, undefined, "ttFillColor");
    this.fillPicker.addEventListener("input", () => {
      this.lastFill = hexToRgb(this.fillPicker.value);
      this.state.fillColor = { ...this.lastFill };
      this.syncFillControls();
      this.emitStyleChange();
    });
    this.noFillBtn = this.btn(ICON_NO_FILL, "No fill", "icon-btn");
    this.reg(this.noFillBtn, undefined, "ttNoFill");
    this.noFillBtn.addEventListener("click", () => {
      this.state.fillColor = this.state.fillColor ? null : { ...this.lastFill };
      this.syncFillControls();
      this.emitStyleChange();
    });
    const fillLabel = document.createElement("span");
    fillLabel.className = "toolbar-label";
    fillLabel.innerHTML = ICON_FILL;
    this.reg(fillLabel, undefined, "lblFill");
    this.syncFillControls();

    const outlineLabel = document.createElement("span");
    outlineLabel.className = "toolbar-label";
    outlineLabel.innerHTML = ICON_RECT;
    this.reg(outlineLabel, undefined, "lblOutline");
    this.shapeStyleSection.append(
      outlineLabel, this.shapeColorPicker,
      this.sep(), fillLabel, this.fillPicker, this.noFillBtn, this.sep(),
    );

    // Stroke width
    const strokeLabel = document.createElement("span");
    strokeLabel.className = "toolbar-label";
    strokeLabel.innerHTML = ICON_STROKE_WIDTH;

    this.shapeStrokeInput = document.createElement("input");
    this.shapeStrokeInput.type = "number";
    this.shapeStrokeInput.className = "toolbar-input";
    this.shapeStrokeInput.title = "Stroke width";
    this.shapeStrokeInput.value = String(this.state.strokeWidth);
    this.shapeStrokeInput.min = "0";
    this.shapeStrokeInput.max = "20";
    this.shapeStrokeInput.step = "0.5";
    this.shapeStrokeInput.addEventListener("change", () => {
      const sw = parseFloat(this.shapeStrokeInput.value);
      if (!isNaN(sw) && sw >= 0) { this.state.strokeWidth = sw; this.emitStyleChange(); }
    });
    this.shapeStyleSection.append(strokeLabel, this.shapeStrokeInput);

    // Layer order
    const frontBtn = this.btn(ICON_LAYER_UP,   "Move up one layer",   "icon-btn");
    const backBtn  = this.btn(ICON_LAYER_DOWN, "Move down one layer", "icon-btn");
    this.reg(frontBtn, undefined, "ttLayerUp");
    this.reg(backBtn,  undefined, "ttLayerDown");
    frontBtn.addEventListener("click", () => this.emit({ type: "layer-change", dir: "up" }));
    backBtn.addEventListener ("click", () => this.emit({ type: "layer-change", dir: "down" }));
    this.shapeStyleSection.append(this.segment(frontBtn, backBtn));

    container.append(this.shapeStyleSection);
  }

  /** The fill swatch shows the current fill; "no fill" is lit when the shape is hollow. */
  private syncFillControls(): void {
    if (this.state.fillColor) this.lastFill = { ...this.state.fillColor };
    this.fillPicker.value = rgbToHex(this.lastFill);
    this.fillPicker.classList.toggle("is-off", !this.state.fillColor);
    this.noFillBtn.classList.toggle("active", !this.state.fillColor);
  }

  // ── Shared logic ────────────────────────────────────────────────────────────

  private commitZoomInput(): void {
    const raw = this.zoomInput.value.replace("%", "").trim();
    const pct = parseFloat(raw);
    if (!isNaN(pct) && pct >= 10 && pct <= 500) {
      const scale = Math.round(pct) / 100 * CSS_UNITS;
      this.updateZoom(scale);
      this.emit({ type: "zoom-set", scale });
    }
  }

  private emitStyleChange(): void {
    this.emit({ type: "style-change", style: this.getStyle() });
  }

  private setActiveTool(tool: ToolKind): void {
    this.state.tool = tool;
    for (const [kind, btn] of Object.entries(this.toolBtns) as [
      ToolKind,
      HTMLButtonElement,
    ][]) {
      btn.classList.toggle("active", kind === tool);
    }
    this.emit({ type: "tool-change", tool });
  }

  clearActiveTool(): void {
    this.state.tool = "select";
    for (const btn of Object.values(this.toolBtns)) {
      btn?.classList.remove("active");
    }
    this.emit({ type: "tool-change", tool: "select" });
  }
}
