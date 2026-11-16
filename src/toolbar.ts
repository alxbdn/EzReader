import {
  type ActiveToolState,
  type ToolKind,
  type FontFamilyValue,
  type RgbColor,
  CSS_UNITS,
  MIN_SCALE,
  MAX_SCALE,
} from "./models";
import { ToolRow, type SignatureChip } from "./tool-row";
import { getTranslations, type Translations } from "./i18n";
import { isMac } from "./platform";
import { MacMenu } from "./mac-menu";
import {
  ICON_INFO,
  ICON_PRESENT,
  ICON_EYE,
  ICON_PEN,
  ICON_EDIT_TEXT,
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
  ICON_LOCK,
  ICON_UNLOCK,
} from "./icons";
import { SearchPill } from "./search-pill";
import { BrightnessButton } from "./brightness-button";
import { blockedWhileProtected } from "./read-only";
import { splitFileName } from "./file-paths";

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
  | { type: "password" }
  | { type: "images-to-pdf" }
  | { type: "ocr" }
  | { type: "rotate" }
  | { type: "zoom-in" }
  | { type: "zoom-out" }
  | { type: "zoom-set"; scale: number }
  | { type: "zoom-reset" }
  | { type: "zoom-real" }
  | { type: "columns"; n: number | null }
  | { type: "scroll-mode"; mode: "vertical" | "horizontal" }
  | { type: "info" }
  | { type: "fullscreen" }
  | { type: "present" }
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
  | { type: "image-browse" }
  | { type: "adjust"; kind: "crop" | "straighten" }
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
  | { type: "redo" }
  | { type: "find" }
  | { type: "insert-image" }
  | { type: "insert-image-page" };

type EventHandler = (e: ToolbarEvent) => void;

interface MenuItemDef {
  label: keyof Translations;
  /** macOS: in the app menu (EzReader ▸ Settings…). */
  appMenu?: boolean;
  shortcut?: string;
  action: () => void;
  requiresDoc?: boolean;
  /** Shows a mark while on: a dot for one-of-several choices, a tick for a toggle. */
  mark?: { id: string; kind: "radio" | "check" };
}

interface MenuDef {
  id: string;
  label: keyof Translations;
  items: (MenuItemDef | null)[]; // null = separator
}

/** Actions that must wait until pending changes are validated or discarded. */
const GUARDED = new Set<ToolbarEvent["type"]>([
  "open", "save", "save-as", "export", "compress", "password", "images-to-pdf", "ocr", "print", "settings", "split", "rotate",
  "insert-blank", "insert-pdf", "insert-image", "insert-image-page", "extract-pages", "present",
]);

export class Toolbar {
  private handlers: EventHandler[] = [];

  private menuBarEl: HTMLElement;
  private contextEl: HTMLElement;
  readonly search: SearchPill;
  private readonly tools: ToolRow;
  /** Changes wait for ✓ / ✕ before anything else can be done. */
  private pending = false;

  // Menu bar state
  private activeMenuId: string | null = null;
  private dropdowns = new Map<string, HTMLElement>();
  private menuButtons = new Map<string, HTMLButtonElement>();
  private docMenuEntries: HTMLButtonElement[] = [];
  /** Menu entries that show a state (layout, thumbnails), by mark id. */
  private markEntries = new Map<string, HTMLButtonElement>();
  /** Shortcut labels, kept raw so "Shift" can be translated. */
  private shortcutEls: [HTMLElement, string][] = [];
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
  /** Page brightness: a button that opens a slider. */
  readonly brightness = new BrightnessButton();
  private zoomInput!: HTMLInputElement;
  /** One page / two pages per row: one button that shows the current layout. */
  private pagesBtn!: HTMLButtonElement;
  private shownColumns = 1;
  private infoBtn!: HTMLButtonElement;
  private sidebarBtn!: HTMLButtonElement;
  private saveBtn!: HTMLButtonElement;
  private lockBtn!: HTMLButtonElement;
  private lockTitles = { on: "Protected: remove the password", off: "Protect with a password" };
  private locked = false;
  private _lastScale = CSS_UNITS;

  /** macOS: the same menus, at the top of the screen. */
  private macMenu: MacMenu | null = null;

  private _i18nText  = new Map<HTMLElement, keyof Translations>();
  private _i18nTitle = new Map<HTMLElement, keyof Translations>();

  constructor() {
    this.menuBarEl = document.getElementById("menubar-row")!;
    this.contextEl = document.getElementById("context-toolbar")!;
    this.search = new SearchPill();
    this.tools = new ToolRow((e) => this.emit(e), () => this.allowed());
    this.buildMenuBar();
    if (isMac && "__TAURI_INTERNALS__" in window) {
      document.body.classList.add("mac");
      const welcomeKeys = document.querySelector(".welcome-shortcut");
      if (welcomeKeys) welcomeKeys.innerHTML = "<kbd>⌘</kbd> <kbd>O</kbd>";
      this.macMenu = new MacMenu(this.getMenuDefs(), getTranslations("en"));
    }
    this.buildContextToolbar();
    this.setupMenuInteraction();
  }

  on(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  private _lastT: Translations | null = null;

  applyTranslations(t: Translations): void {
    this._lastT = t;
    this._i18nText.forEach((key, el)  => { const v = t[key]; if (v !== undefined) el.textContent = v; });
    this._i18nTitle.forEach((key, el) => { const v = t[key]; if (v !== undefined) el.title = v; });
    this.renameTitle = t.ttRename ?? "Click to rename";
    this.lockTitles = { on: t.ttLockOn ?? "Protected: remove the password", off: t.ttLockOff ?? "Protect with a password" };
    this.setProtected(this.locked);
    this.docTitleName.title = this.docName ? this.renameTitle : "";
    const shift = t.kbdShift ?? "Shift";
    for (const [el, raw] of this.shortcutEls) el.textContent = raw.replace("Shift", shift);
    this.search.applyTranslations(t);
    this.tools.applyTranslations(t);
    this.macMenu?.applyTranslations(t);
  }

  private reg(el: HTMLElement, text?: keyof Translations, title?: keyof Translations): void {
    if (text)  this._i18nText.set(el, text);
    if (title) this._i18nTitle.set(el, title);
  }

  private emit(e: ToolbarEvent): void {
    if (this.refusedReadOnly(e)) return;
    if (GUARDED.has(e.type) && !this.allowed()) return;
    this.handlers.forEach((h) => h(e));
  }

  /** True while the open document is protected: only reading is allowed. */
  private readOnly = false;
  private readOnlyRefused: (() => void) | null = null;

  /** Called when an action is refused because the document is protected. */
  onReadOnlyRefused(cb: () => void): void { this.readOnlyRefused = cb; }

  get isReadOnly(): boolean { return this.readOnly; }

  /** Makes the toolbar read-only (back to Read mode) or editable again. */
  setReadOnly(on: boolean): void {
    this.readOnly = on;
    document.body.classList.toggle("read-only", on);
    if (on && this.mode !== "read") {
      this.mode = "read";
      this.tools.setMode("read");
      this.syncModeBtns();
      this.handlers.forEach((h) => h({ type: "mode-change", mode: "read" }));
    }
  }

  private refusedReadOnly(e: ToolbarEvent): boolean {
    if (!this.readOnly || !blockedWhileProtected(e)) return false;
    this.readOnlyRefused?.();
    return true;
  }

  /** Set while another view (Crop / Straighten) holds its own ✓ / ✕. */
  private blocker: (() => void) | null = null;

  /** While `shake` is set, every guarded action calls it and is refused. */
  setBlocker(shake: (() => void) | null): void { this.blocker = shake; }

  /** While changes wait for validation, shakes ✓ / ✕ and says no. */
  allowed(): boolean {
    if (this.blocker) { this.blocker(); return false; }
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
  updateFitMode(_mode: "none" | "fit-width" | "fit-height" | "fit-page"): void {}

  /**
   * Shows the layout on the pages button: `columns` is the forced count (null:
   * as many as fit), `shown` the number of pages per row on screen.
   */
  updateLayout(columns: number | null, mode: "vertical" | "horizontal", shown: number = columns ?? 1): void {
    this.shownColumns = mode === "vertical" && shown >= 2 ? 2 : 1;
    const two = this.shownColumns === 2;
    this.pagesBtn.innerHTML = two ? ICON_PAGES_2 : ICON_PAGES_1;
    this.pagesBtn.dataset["cols"] = String(this.shownColumns);
    // The tooltip says what a click does.
    this._i18nTitle.set(this.pagesBtn, two ? "ttPages1" : "ttPages2");
    this.pagesBtn.title = this._lastT?.[two ? "ttPages1" : "ttPages2"] ?? (two ? "One page per row" : "Two pages per row");
    for (const n of [1, 2, 3]) this.setMark(`cols-${n}`, mode === "vertical" && columns === n);
    this.setMark("scroll-vertical", mode === "vertical");
    this.setMark("scroll-horizontal", mode === "horizontal");
  }

  private setMark(id: string, on: boolean): void {
    this.macMenu?.setMark(id, on);
    const entry = this.markEntries.get(id);
    if (!entry) return;
    entry.classList.toggle("marked", on);
    entry.setAttribute("aria-checked", String(on));
  }

  setInfoOpen(open: boolean): void {
    this.infoBtn.classList.toggle("active", open);
  }

  /** The file name in the title bar (the tab strip holds it in the active tab). */
  get titleElement(): HTMLElement { return this.docTitleEl; }

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

  /** Closed padlock (green) while the document is, or will be saved, with a password. */
  setProtected(on: boolean): void {
    this.locked = on;
    if (!this.lockBtn) return;
    this.lockBtn.innerHTML = on ? ICON_LOCK : ICON_UNLOCK;
    this.lockBtn.classList.toggle("on", on);
    this.lockBtn.title = on ? this.lockTitles.on : this.lockTitles.off;
    this.lockBtn.setAttribute("aria-label", this.lockBtn.title);
    this.lockBtn.setAttribute("aria-pressed", String(on));
  }

  /** Shows the sidebar toggle as pressed while the thumbnails are visible. */
  updateSidebar(visible: boolean): void {
    this.sidebarBtn.classList.toggle("active", visible);
    this.sidebarBtn.setAttribute("aria-pressed", String(visible));
    this.setMark("sidebar", visible);
  }

  setLoaded(loaded: boolean): void {
    this.contextEl.style.display = loaded ? "flex" : "none";
    for (const btn of this.docMenuEntries) {
      btn.disabled = !loaded;
    }
    this.macMenu?.setLoaded(loaded);
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

  /** While a save runs: the Save button pulses. */
  setSaving(on: boolean): void {
    this.saveBtn.classList.toggle("saving", on);
  }

  /** After a save: a green ring (saved) or a red shake (failed) around Save. */
  flashSave(result: "ok" | "error"): void {
    const cls = result === "ok" ? "save-ok" : "save-error";
    this.saveBtn.classList.remove("save-ok", "save-error");
    void this.saveBtn.offsetWidth; // restart the animation
    this.saveBtn.classList.add(cls);
    window.setTimeout(() => this.saveBtn.classList.remove(cls), 1200);
  }

  setActiveSignature(id: string | null): void { this.tools.setActiveSignature(id); }

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
    const go = (e: ToolbarEvent) => () => this.emit(e);
    return [
      {
        id: "file",
        label: "menuFile",
        items: [
          { label: "menuOpen", shortcut: "Ctrl+O", action: go({ type: "open" }) },
          null,
          { label: "btnSave", shortcut: "Ctrl+S", action: go({ type: "save" }), requiresDoc: true },
          { label: "menuSaveAs", shortcut: "Ctrl+Shift+S", action: go({ type: "save-as" }), requiresDoc: true },
          null,
          { label: "menuExport", action: go({ type: "export" }), requiresDoc: true },
          { label: "menuPrintDialog", shortcut: "Ctrl+P", action: go({ type: "print" }), requiresDoc: true },
          null,
          { label: "menuSettingsDialog", shortcut: "Ctrl+,", action: go({ type: "settings" }), appMenu: true },
        ],
      },
      {
        id: "edit",
        label: "menuEdit",
        items: [
          { label: "menuUndo", shortcut: "Ctrl+Z", action: go({ type: "undo" }), requiresDoc: true },
          { label: "menuRedo", shortcut: "Ctrl+Y", action: go({ type: "redo" }), requiresDoc: true },
          null,
          { label: "menuFind", shortcut: "Ctrl+F", action: go({ type: "find" }), requiresDoc: true },
          { label: "menuSelectAllPages", action: go({ type: "select-all-pages" }), requiresDoc: true },
          null,
          { label: "menuInsertBlank", action: go({ type: "insert-blank" }), requiresDoc: true },
          { label: "menuInsertPdf", action: go({ type: "insert-pdf" }), requiresDoc: true },
          { label: "menuInsertImage", action: go({ type: "insert-image" }), requiresDoc: true },
          { label: "menuInsertImagePage", action: go({ type: "insert-image-page" }), requiresDoc: true },
          { label: "menuRotate90", action: go({ type: "rotate" }), requiresDoc: true },
          null,
          { label: "menuExtractPages", action: go({ type: "extract-pages" }), requiresDoc: true },
          { label: "menuSplit", action: go({ type: "split" }), requiresDoc: true },
        ],
      },
      {
        id: "view",
        label: "menuView",
        items: [
          { label: "menuZoomIn", shortcut: "Ctrl++", action: go({ type: "zoom-in" }), requiresDoc: true },
          { label: "menuZoomOut", shortcut: "Ctrl+-", action: go({ type: "zoom-out" }), requiresDoc: true },
          { label: "menuActualSize", shortcut: "Ctrl+0", action: go({ type: "zoom-reset" }), requiresDoc: true },
          null,
          { label: "menuFitWidth", action: go({ type: "fit-width" }), requiresDoc: true },
          { label: "menuFitHeight", action: go({ type: "fit-height" }), requiresDoc: true },
          null,
          { label: "ttPages1", action: go({ type: "columns", n: 1 }), requiresDoc: true, mark: { id: "cols-1", kind: "radio" } },
          { label: "ttPages2", action: go({ type: "columns", n: 2 }), requiresDoc: true, mark: { id: "cols-2", kind: "radio" } },
          { label: "menuPages3", action: go({ type: "columns", n: 3 }), requiresDoc: true, mark: { id: "cols-3", kind: "radio" } },
          null,
          { label: "ttScrollVertical", action: go({ type: "scroll-mode", mode: "vertical" }), requiresDoc: true, mark: { id: "scroll-vertical", kind: "radio" } },
          { label: "menuScrollHorizontal", action: go({ type: "scroll-mode", mode: "horizontal" }), requiresDoc: true, mark: { id: "scroll-horizontal", kind: "radio" } },
          null,
          { label: "menuPageSidebar", action: go({ type: "toggle-sidebar" }), requiresDoc: true, mark: { id: "sidebar", kind: "check" } },
          null,
          { label: "menuPresent", shortcut: "F5", action: go({ type: "present" }), requiresDoc: true },
          { label: "menuFullscreen", shortcut: "F11", action: go({ type: "fullscreen" }) },
        ],
      },
      {
        id: "tools",
        label: "menuTools",
        items: [
          { label: "btnCompress", shortcut: "Ctrl+Shift+E", action: go({ type: "compress" }), requiresDoc: true },
          { label: "menuProtect", action: go({ type: "password" }), requiresDoc: true },
          null,
          { label: "menuOcr", action: go({ type: "ocr" }) },
          { label: "menuImagesToPdf", action: go({ type: "images-to-pdf" }) },
        ],
      },
    ];
  }

  private buildMenuBar(): void {
    const menus = this.getMenuDefs();
    for (const menu of menus) {
      const wrapper = document.createElement("div");
      wrapper.className = "menubar-menu";
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
      // Room on the left for the dots and ticks, so every label lines up.
      if (menu.items.some((i) => i?.mark)) dropdown.classList.add("has-marks");

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
        labelSpan.className = "menu-label";
        this.reg(labelSpan, item.label);
        entry.append(labelSpan);

        if (item.mark) {
          entry.classList.add(`menu-${item.mark.kind}`);
          entry.setAttribute("role", item.mark.kind === "radio" ? "menuitemradio" : "menuitemcheckbox");
          entry.setAttribute("aria-checked", "false");
          this.markEntries.set(item.mark.id, entry);
        }

        if (item.shortcut) {
          const shortcutSpan = document.createElement("span");
          shortcutSpan.className = "shortcut";
          shortcutSpan.textContent = item.shortcut;
          this.shortcutEls.push([shortcutSpan, item.shortcut]);
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
    this.saveBtn = this.btn(ICON_SAVE, "Save (Ctrl+S)", "icon-btn tb-square tb-save");
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

    // Clicking the percentage lets you type a value (Ctrl+0 resets the zoom).
    this.zoomLabel = this.btn("100 %", "Click to type a zoom level (Ctrl+0 resets it)", "zoom-label");
    this.reg(this.zoomLabel, undefined, "ttZoomLabel");
    this.zoomLabel.addEventListener("click", () => this.startZoomEdit());
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

    this.reg(this.brightness.button, undefined, "settingsBrightness");
    const brightnessSeg = this.segment(this.brightness.el);
    brightnessSeg.classList.add("tb-brightness");

    // One button for one page / two pages per row: it shows the current
    // layout, and a click switches to the other one.
    this.pagesBtn = this.btn(ICON_PAGES_1, "Two pages per row", "icon-btn tb-pages");
    this.reg(this.pagesBtn, undefined, "ttPages2");
    this.pagesBtn.addEventListener("click", () => this.emit({ type: "columns", n: this.shownColumns === 2 ? 1 : 2 }));

    // Read / Annotate / Edit
    // On a narrow window the names give way to icons (see fitMainRow).
    const modeDefs: [AppMode, keyof Translations, string, string][] = [
      ["read", "modeRead", "Read", ICON_EYE], ["annotate", "modeAnnotate", "Annotate", ICON_PEN], ["edit", "modeEdit", "Edit", ICON_EDIT_TEXT],
    ];
    this.modeBtns = modeDefs.map(([mode, key, fb, icon]) => {
      const b = document.createElement("button");
      b.className = "mode-btn";
      b.dataset["mode"] = mode;
      const ic = document.createElement("span");
      ic.className = "mode-icon";
      ic.innerHTML = icon;
      ic.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.className = "mode-label";
      label.textContent = fb;
      b.title = fb;
      b.append(ic, label);
      this.reg(label, key);
      this.reg(b, undefined, key);
      b.addEventListener("click", () => this.setMode(mode));
      return b;
    });
    const modeSeg = this.segment(...this.modeBtns);
    const columnsSeg = this.segment(this.pagesBtn);
    columnsSeg.classList.add("tb-columns");
    modeSeg.classList.add("mode-segment");

    // Right side: export, compress, info, then the search pill
    const exportBtn = this.btn(ICON_EXPORT, "Export a copy", "icon-btn tb-square");
    this.reg(exportBtn, undefined, "ttExport");
    exportBtn.addEventListener("click", () => this.emit({ type: "export" }));
    const compressBtn = this.btn(ICON_COMPRESS_LAYERS, "Compress", "icon-btn tb-square");
    this.reg(compressBtn, undefined, "ttCompress");
    compressBtn.addEventListener("click", () => this.emit({ type: "compress" }));
    this.lockBtn = this.btn(ICON_UNLOCK, this.lockTitles.off, "icon-btn tb-square tb-lock");
    this.lockBtn.addEventListener("click", () => this.emit({ type: "password" }));
    this.infoBtn = this.btn(ICON_INFO, "Document info", "icon-btn tb-square");
    this.reg(this.infoBtn, undefined, "ttInfo");
    this.infoBtn.addEventListener("click", () => this.emit({ type: "info" }));
    const presentBtn = this.btn(ICON_PRESENT, "Present (F5)", "icon-btn tb-square");
    this.reg(presentBtn, undefined, "ttPresent");
    presentBtn.addEventListener("click", () => this.emit({ type: "present" }));
    const right = document.createElement("div");
    right.className = "toolbar-group tb-right";
    right.append(exportBtn, compressBtn, this.lockBtn, this.infoBtn, presentBtn, this.sep(), this.search.el);

    // Left group (side panel, then Read / Annotate / Edit), right group.
    const left = document.createElement("div");
    left.className = "toolbar-group tb-left";
    left.append(
      this.sidebarBtn, modeSeg, this.sep(),
      this.saveBtn, this.segment(undo, redo), this.sep(),
      this.segment(...this.pointerBtns),
      this.segment(zoomOut, this.zoomLabel, this.zoomInput, zoomIn, realSizeBtn),
      brightnessSeg, columnsSeg,
    );
    main.append(left, right);
    this.updateLayout(null, "vertical");
    this.syncModeBtns();

    // Keep the main row on one line: compact it when it would wrap.
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => this.fitMainRow(main));
      ro.observe(main);
      ro.observe(this.search.el);
    }
  }

  /**
   * Compacts the main row step by step (mode names become icons, the open
   * search box narrows, then less used bits hide) only when it would
   * otherwise take two lines. The search box's final width is used, not the
   * one mid-animation, so the result doesn't flicker while it opens.
   */
  private fitMainRow(main: HTMLElement): void {
    const levels = ["tb-compact", "tb-compact-2", "tb-compact-3"];
    // Width of the open search box at each level.
    const searchOpen = [250, 190, 160, 120];
    const pill = this.search.el;
    const open = pill.classList.contains("open");
    // Laid out on one line, how much wider than the row the content is, with
    // the search box at its final width (not the one mid-animation). The side
    // groups stretch to fill the row, so add up what they hold.
    const [left, right] = Array.from(main.children) as HTMLElement[];
    const gapOf = (el: HTMLElement) => parseFloat(getComputedStyle(el).columnGap) || 0;
    const held = (group: HTMLElement): number => {
      const shown = (Array.from(group.children) as HTMLElement[]).filter((c) => c.offsetWidth > 0);
      return shown.reduce((sum, c) => sum + c.offsetWidth, 0) + gapOf(group) * Math.max(0, shown.length - 1);
    };
    const overflow = (level: number): number => {
      const style = getComputedStyle(main);
      const room = main.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
      const rightW = held(right) - pill.offsetWidth + (open ? searchOpen[level] : 34);
      // Only a row too full for everything gets compacted.
      return held(left) + rightW + gapOf(main) - room;
    };
    main.style.flexWrap = "nowrap";
    main.classList.remove(...levels);
    let level = 0;
    while (level < levels.length && overflow(level) > 0) main.classList.add(levels[level++]);
    main.style.flexWrap = "";
    const w = `${searchOpen[level]}px`;
    if (pill.style.getPropertyValue("--search-open-w") !== w) pill.style.setProperty("--search-open-w", w);
  }



  /** Switches between reading, annotating and editing; any active tool is dropped. */
  setMode(mode: AppMode): void {
    if (mode === this.mode || this.refusedReadOnly({ type: "mode-change", mode }) || !this.allowed()) return;
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
    if (!isNaN(pct) && pct >= MIN_SCALE * 100 && pct <= MAX_SCALE * 100) {
      const scale = Math.round(pct) / 100 * CSS_UNITS;
      this.updateZoom(scale);
      this.emit({ type: "zoom-set", scale });
    }
  }

  /** Back to selecting and moving annotations. */
  clearActiveTool(): void { this.tools.clearTool(); }

  /** How many pages are checked in the side panel (page tools apply to them). */
  setPageSelection(count: number): void { this.tools.setPageSelection(count); }
}
