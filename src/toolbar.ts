import {
  type ActiveToolState,
  type ToolKind,
  type FontFamilyValue,
  type RgbColor,
  CSS_UNITS,
} from "./models";
import { ToolRow, type SignatureChip } from "./tool-row";
import type { Translations } from "./i18n";
import {
  ICON_INFO,
  ICON_PAGES_1,
  ICON_PAGES_2,
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

export type ToolbarEvent =
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
  | { type: "signature-use"; id: string }
  | { type: "signature-delete"; id: string }
  | { type: "draft-apply" }
  | { type: "draft-discard" }
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

/** Actions that must wait until pending changes are validated or discarded. */
const GUARDED = new Set<ToolbarEvent["type"]>([
  "open", "save", "save-as", "export", "compress", "print", "settings", "split", "rotate",
  "insert-blank", "insert-pdf", "extract-pages",
]);

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
  private handlers: EventHandler[] = [];

  private menuBarEl: HTMLElement;
  private contextEl: HTMLElement;
  readonly search: SearchPill;
  readonly tools: ToolRow;
  /** Changes wait for ✓ / ✕ before anything else can be done. */
  private pending = false;

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
  private zoomLabel!: HTMLButtonElement;
  private zoomInput!: HTMLInputElement;
  private columnBtns: HTMLButtonElement[] = [];
  private infoBtn!: HTMLButtonElement;
  private sidebarBtn!: HTMLButtonElement;
  private saveBtn!: HTMLButtonElement;
  private _lastScale = CSS_UNITS;

  private _i18nText  = new Map<HTMLElement, keyof Translations>();
  private _i18nTitle = new Map<HTMLElement, keyof Translations>();

  constructor() {
    this.menuBarEl = document.getElementById("menubar-row")!;
    this.contextEl = document.getElementById("context-toolbar")!;
    this.search = new SearchPill();
    this.tools = new ToolRow((e) => this.emit(e), () => this.allowed());
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
    this.tools.applyTranslations(t);
  }

  private reg(el: HTMLElement, text?: keyof Translations, title?: keyof Translations): void {
    if (text)  this._i18nText.set(el, text);
    if (title) this._i18nTitle.set(el, title);
  }

  private emit(e: ToolbarEvent): void {
    if (GUARDED.has(e.type) && !this.allowed()) return;
    this.handlers.forEach((h) => h(e));
  }

  /** While changes wait for validation, shakes ✓ / ✕ and says no. */
  allowed(): boolean {
    if (!this.pending) return true;
    this.tools.shake();
    return false;
  }

  setPending(pending: boolean): void {
    this.pending = pending;
    this.tools.setPending(pending);
  }

  get isPending(): boolean { return this.pending; }

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

  getStyle(): ActiveToolState { return this.tools.getStyle(); }

  showTextStyles(state: Pick<ActiveToolState, "color" | "fontSize" | "bold" | "italic" | "underline"> & { fontFamily?: FontFamilyValue; backgroundColor?: RgbColor | null }): void {
    this.tools.showTextStyles(state);
  }

  hideTextStyles(): void { this.tools.hideTextStyles(); }

  showShapeStyles(state: { color: RgbColor; strokeWidth: number; fillColor?: RgbColor | null; opacity?: number }, panel: "pencil" | "shapes" = "shapes"): void {
    this.tools.showShapeStyles(state, panel);
  }

  hideShapeStyles(): void { this.tools.hideShapeStyles(); }

  setSignatures(list: SignatureChip[]): void { this.tools.setSignatures(list); }

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
    this.contextEl.append(main, this.tools.row, this.tools.options);

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
    this.syncModeBtns();
  }

  /** Switches between reading, annotating and editing; any active tool is dropped. */
  setMode(mode: AppMode): void {
    if (mode === this.mode || !this.allowed()) return;
    this.mode = mode;
    this.tools.setMode(mode);
    this.syncModeBtns();
    this.emit({ type: "mode-change", mode });
  }

  private syncModeBtns(): void {
    for (const b of this.modeBtns) {
      const on = b.dataset["mode"] === this.mode;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    }
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

  /** Back to selecting and moving annotations. */
  clearActiveTool(): void { this.tools.clearTool(); }
}
