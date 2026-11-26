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
import { matchesShortcut, type KeyPress } from "./shortcuts";
import {
  ICON_INFO,
  ICON_MORE,
  ICON_PRESENT,
  ICON_EYE,
  ICON_PEN,
  ICON_EDIT_TEXT,
  ICON_PAGES_1,
  ICON_PAGES_2,
  ICON_PAGES_2_EVEN,
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
  ICON_SUN,
  ICON_MOON,
  ICON_CHEVRON_UP,
  ICON_CHEVRON_DOWN,
} from "./icons";
import { SearchPill } from "./search-pill";
import { BrightnessButton } from "./brightness-button";
import { blockedWhileProtected } from "./read-only";

export type AppMode = "read" | "annotate" | "edit";
export type PointerMode = "hand" | "select";

export type ToolbarEvent =
  | { type: "open" }
  | { type: "save" }
  | { type: "save-as" }
  | { type: "export" }
  | { type: "compress" }
  | { type: "password" }
  | { type: "ocr" }
  | { type: "rotate" }
  | { type: "zoom-in" }
  | { type: "zoom-out" }
  | { type: "zoom-set"; scale: number }
  | { type: "zoom-reset" }
  | { type: "zoom-real" }
  | { type: "columns"; n: number | null; even?: boolean }
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
  | { type: "theme"; dark: boolean }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "duplicate" }
  | { type: "find" }
  | { type: "insert-image" }
  | { type: "insert-image-page" };

type EventHandler = (e: ToolbarEvent) => void;

interface MenuItemDef {
  label: keyof Translations;
  appMenu?: boolean;
  shortcut?: string;
  command: ToolbarEvent;
  action: () => void;
  requiresDoc?: boolean;
  mark?: { id: string; kind: "radio" | "check" };
}

interface MenuDef {
  id: string;
  label: keyof Translations;
  items: (MenuItemDef | null)[];
}

const GUARDED = new Set<ToolbarEvent["type"]>([
  "open", "save", "save-as", "export", "compress", "password", "ocr", "print", "settings", "split", "rotate",
  "insert-blank", "insert-pdf", "insert-image", "insert-image-page", "extract-pages", "present",
]);

export class Toolbar {
  private handlers: EventHandler[] = [];

  private menuBarEl: HTMLElement;
  private contextEl: HTMLElement;
  readonly search: SearchPill;
  private readonly tools: ToolRow;
  private pending = false;

  private activeMenuId: string | null = null;
  private dropdowns = new Map<string, HTMLElement>();
  private menuButtons = new Map<string, HTMLButtonElement>();
  private docMenuEntries: HTMLButtonElement[] = [];
  private markEntries = new Map<string, HTMLButtonElement>();
  private shortcutEls: [HTMLElement, string][] = [];

  private mode: AppMode = "read";
  private pointer: PointerMode = "select";
  private modeBtns: HTMLButtonElement[] = [];
  private pointerBtns: HTMLButtonElement[] = [];
  private zoomLabel!: HTMLButtonElement;
  readonly brightness = new BrightnessButton();
  private zoomInput!: HTMLInputElement;
  private zoomMenu!: HTMLElement;
  private mainRow!: HTMLElement;
  private pagesBtn!: HTMLButtonElement;
  private shownColumns = 1;
  private shownEvenSpread = false;
  private infoEntry!: HTMLButtonElement;
  private moreBtn!: HTMLButtonElement;
  private moreMenu!: HTMLElement;
  private sidebarBtn!: HTMLButtonElement;
  private saveBtn!: HTMLButtonElement;
  private lockEntry!: HTMLButtonElement;
  private lockBtn!: HTMLButtonElement;
  private infoBtn!: HTMLButtonElement;
  private themeSwitch!: HTMLButtonElement;
  /** The parts that need a document: everything but the sidebar button and the theme switch. */
  private idleParts: HTMLElement[] = [];
  private lockTexts = { on: "Remove the password…", off: "Protect with a password…" };
  private lockTitles = { on: "Protected: remove the password", off: "Protect with a password" };
  private locked = false;
  private _lastScale = CSS_UNITS;

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
    this.setLoaded(false);
  }

  on(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  private _lastT: Translations | null = null;

  applyTranslations(t: Translations): void {
    this._lastT = t;
    this._i18nText.forEach((key, el)  => { const v = t[key]; if (v !== undefined) el.textContent = v; });
    this._i18nTitle.forEach((key, el) => { const v = t[key]; if (v !== undefined) el.title = v; });
    this.lockTitles = { on: t.ttLockOn ?? "Protected: remove the password", off: t.ttLockOff ?? "Protect with a password" };
    this.lockTexts = { on: t.moreUnprotect ?? "Remove the password…", off: t.moreProtect ?? "Protect with a password…" };
    this.setProtected(this.locked);
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

  private readOnly = false;
  private readOnlyRefused: (() => void) | null = null;

  onReadOnlyRefused(cb: () => void): void { this.readOnlyRefused = cb; }

  get isReadOnly(): boolean { return this.readOnly; }

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

  private blocker: (() => void) | null = null;

  setBlocker(shake: (() => void) | null): void { this.blocker = shake; }

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

  updateFitMode(_mode: "none" | "fit-width" | "fit-height" | "fit-page"): void {}

  updateLayout(columns: number | null, mode: "vertical" | "horizontal", shown: number = columns ?? 1, even = false): void {
    this.shownColumns = mode === "vertical" && shown >= 2 ? 2 : 1;
    this.shownEvenSpread = this.shownColumns === 2 && even;
    const state = this.shownColumns === 1 ? "1" : this.shownEvenSpread ? "2-even" : "2-odd";
    this.pagesBtn.innerHTML = state === "1" ? ICON_PAGES_1 : state === "2-odd" ? ICON_PAGES_2 : ICON_PAGES_2_EVEN;
    this.pagesBtn.dataset["cols"] = state;
    const nextKey: keyof Translations = state === "1" ? "ttPages2" : state === "2-odd" ? "ttPages2Even" : "ttPages1";
    const nextFb = state === "1" ? "Two pages (odd on left)" : state === "2-odd" ? "Two pages (even on left)" : "One page per row";
    this._i18nTitle.set(this.pagesBtn, nextKey);
    this.pagesBtn.title = this._lastT?.[nextKey] ?? nextFb;
    this.setMark("cols-1", mode === "vertical" && columns === 1);
    this.setMark("cols-2", mode === "vertical" && columns === 2 && !even);
    this.setMark("cols-2-even", mode === "vertical" && columns === 2 && even);
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
    this.infoEntry.classList.toggle("current", open);
    this.infoEntry.setAttribute("aria-current", String(open));
    this.infoBtn.classList.toggle("active", open);
    this.infoBtn.setAttribute("aria-pressed", String(open));
  }

  /** The document's name goes to the window title (taskbar) and its unsaved state to the save
   *  button; the name itself is shown, and renamed, in the page panel's file list. */
  setDocTitle(name: string | null, dirty: boolean): void {
    this.saveBtn.classList.toggle("dirty", !!name && dirty);
    document.title = name ? `${dirty ? "• " : ""}${name} – EzReader` : "EzReader";
  }

  setProtected(on: boolean): void {
    this.locked = on;
    if (!this.lockEntry) return;
    const [icon, label] = Array.from(this.lockEntry.children) as HTMLElement[];
    icon!.innerHTML = on ? ICON_LOCK : ICON_UNLOCK;
    label!.textContent = on ? this.lockTexts.on : this.lockTexts.off;
    this.lockEntry.classList.toggle("on", on);
    this.lockEntry.title = on ? this.lockTitles.on : this.lockTitles.off;
    this.lockBtn.innerHTML = on ? ICON_LOCK : ICON_UNLOCK;
    this.lockBtn.classList.toggle("on", on);
    this.lockBtn.title = this.lockEntry.title;
  }

  /** Shows the theme the window is in on the toolbar switch. */
  private syncThemeSwitch(): void {
    const dark = document.documentElement.dataset["theme"] === "dark";
    this.themeSwitch.classList.toggle("on", dark);
    this.themeSwitch.setAttribute("aria-checked", String(dark));
  }

  updateSidebar(visible: boolean): void {
    this.sidebarBtn.classList.toggle("active", visible);
    this.sidebarBtn.setAttribute("aria-pressed", String(visible));
    this.setMark("sidebar", visible);
  }

  /** With no document the toolbar stays in place, dimmed and out of reach, so the window keeps one layout. */
  setLoaded(loaded: boolean): void {
    this.contextEl.classList.toggle("tb-idle", !loaded);
    for (const el of this.idleParts) el.inert = !loaded;
    for (const btn of this.docMenuEntries) {
      btn.disabled = !loaded;
    }
    this.macMenu?.setLoaded(loaded);
    if (!loaded) this.search.close();
  }

  getStyle(): ActiveToolState { return this.tools.getStyle(); }

  showTextStyles(state: Pick<ActiveToolState, "color" | "fontSize" | "bold" | "italic" | "underline"> & { fontFamily?: FontFamilyValue; fontName?: string | null; backgroundColor?: RgbColor | null }): void {
    this.tools.showTextStyles(state);
  }

  hideTextStyles(): void { this.tools.hideTextStyles(); }

  showShapeStyles(state: { color: RgbColor; strokeWidth: number; fillColor?: RgbColor | null; opacity?: number }, panel: "pencil" | "shapes" = "shapes"): void {
    this.tools.showShapeStyles(state, panel);
  }

  hideShapeStyles(): void { this.tools.hideShapeStyles(); }

  setSystemFonts(names: string[]): void { this.tools.setSystemFonts(names); }

  showSignatureStyles(color: RgbColor): void { this.tools.showSignatureStyles(color); }
  hideSignatureStyles(): void { this.tools.hideSignatureStyles(); }

  showHighlightStyles(state: { color: RgbColor; opacity: number }): void { this.tools.showHighlightStyles(state); }
  hideHighlightStyles(): void { this.tools.hideHighlightStyles(); }

  get toolOptions(): HTMLElement { return this.tools.options; }

  onToolOptions(h: (title: string | null, mode: AppMode) => void): void { this.tools.onSync = h; }

  setSaving(on: boolean): void {
    this.saveBtn.classList.toggle("saving", on);
  }

  flashSave(result: "ok" | "error"): void {
    const cls = result === "ok" ? "save-ok" : "save-error";
    this.saveBtn.classList.remove("save-ok", "save-error");
    void this.saveBtn.offsetWidth;
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

  private pointerSegment(): HTMLElement {
    const seg = this.segment(...this.pointerBtns);
    seg.classList.add("pointer-seg");
    seg.setAttribute("role", "group");
    return seg;
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

  private getMenuDefs(): MenuDef[] {
    const menus: { id: string; label: keyof Translations; items: (Omit<MenuItemDef, "action"> | null)[] }[] = [
      {
        id: "file",
        label: "menuFile",
        items: [
          { label: "menuOpen", shortcut: "Ctrl+O", command: { type: "open" } },
          null,
          { label: "btnSave", shortcut: "Ctrl+S", command: { type: "save" }, requiresDoc: true },
          { label: "menuSaveAs", shortcut: "Ctrl+Shift+S", command: { type: "save-as" }, requiresDoc: true },
          null,
          { label: "menuExport", command: { type: "export" }, requiresDoc: true },
          { label: "menuPrintDialog", shortcut: "Ctrl+P", command: { type: "print" }, requiresDoc: true },
          null,
          { label: "menuSettingsDialog", shortcut: "Ctrl+,", command: { type: "settings" }, appMenu: true },
        ],
      },
      {
        id: "edit",
        label: "menuEdit",
        items: [
          { label: "menuUndo", shortcut: "Ctrl+Z", command: { type: "undo" }, requiresDoc: true },
          { label: "menuRedo", shortcut: "Ctrl+Y", command: { type: "redo" }, requiresDoc: true },
          { label: "menuDuplicate", shortcut: "Ctrl+D", command: { type: "duplicate" }, requiresDoc: true },
          null,
          { label: "menuFind", shortcut: "Ctrl+F", command: { type: "find" }, requiresDoc: true },
          { label: "menuSelectAllPages", command: { type: "select-all-pages" }, requiresDoc: true },
          null,
          { label: "menuInsertBlank", command: { type: "insert-blank" }, requiresDoc: true },
          { label: "menuInsertPdf", command: { type: "insert-pdf" }, requiresDoc: true },
          { label: "menuInsertImage", command: { type: "insert-image" }, requiresDoc: true },
          { label: "menuInsertImagePage", command: { type: "insert-image-page" }, requiresDoc: true },
          { label: "menuRotate90", command: { type: "rotate" }, requiresDoc: true },
          null,
          { label: "menuExtractPages", command: { type: "extract-pages" }, requiresDoc: true },
          { label: "menuSplit", command: { type: "split" }, requiresDoc: true },
        ],
      },
      {
        id: "view",
        label: "menuView",
        items: [
          { label: "menuZoomIn", shortcut: "Ctrl++", command: { type: "zoom-in" }, requiresDoc: true },
          { label: "menuZoomOut", shortcut: "Ctrl+-", command: { type: "zoom-out" }, requiresDoc: true },
          { label: "menuActualSize", shortcut: "Ctrl+0", command: { type: "zoom-reset" }, requiresDoc: true },
          null,
          { label: "menuFitWidth", command: { type: "fit-width" }, requiresDoc: true },
          { label: "menuFitHeight", command: { type: "fit-height" }, requiresDoc: true },
          null,
          { label: "ttPages1", command: { type: "columns", n: 1, even: false }, requiresDoc: true, mark: { id: "cols-1", kind: "radio" } },
          { label: "ttPages2", command: { type: "columns", n: 2, even: false }, requiresDoc: true, mark: { id: "cols-2", kind: "radio" } },
          { label: "ttPages2Even", command: { type: "columns", n: 2, even: true }, requiresDoc: true, mark: { id: "cols-2-even", kind: "radio" } },
          null,
          { label: "ttScrollVertical", command: { type: "scroll-mode", mode: "vertical" }, requiresDoc: true, mark: { id: "scroll-vertical", kind: "radio" } },
          { label: "menuScrollHorizontal", command: { type: "scroll-mode", mode: "horizontal" }, requiresDoc: true, mark: { id: "scroll-horizontal", kind: "radio" } },
          null,
          { label: "menuPageSidebar", command: { type: "toggle-sidebar" }, requiresDoc: true, mark: { id: "sidebar", kind: "check" } },
          null,
          { label: "menuPresent", shortcut: "F5", command: { type: "present" }, requiresDoc: true },
          { label: "menuFullscreen", shortcut: "F11", command: { type: "fullscreen" } },
        ],
      },
      {
        id: "tools",
        label: "menuTools",
        items: [
          { label: "btnCompress", shortcut: "Ctrl+Shift+E", command: { type: "compress" }, requiresDoc: true },
          { label: "menuProtect", command: { type: "password" }, requiresDoc: true },
          null,
          { label: "menuOcr", command: { type: "ocr" } },
        ],
      },
    ];
    return menus.map((m) => ({ ...m, items: m.items.map((i) => i && { ...i, action: () => this.emit(i.command) }) }));
  }

  /**
   * The command a key press stands for, from the shortcuts the menus show, so a shortcut does
   * exactly what its menu item does, through the same guards. Ctrl+Shift+Z is redo too.
   */
  commandForKey(e: KeyPress): ToolbarEvent | null {
    this.shortcuts ??= this.getMenuDefs().flatMap((m) => m.items)
      .filter((i): i is MenuItemDef & { shortcut: string } => !!i?.shortcut)
      .map((i) => [i.shortcut, i.command] as [string, ToolbarEvent])
      .concat([["Ctrl+Shift+Z", { type: "redo" }]]);
    return this.shortcuts.find(([shortcut]) => matchesShortcut(shortcut, e))?.[1] ?? null;
  }

  private shortcuts: [string, ToolbarEvent][] | null = null;

  /** Runs a command as if its button or menu item had been used. */
  dispatch(e: ToolbarEvent): void { this.emit(e); }

  private buildMenuBar(): void {
    const menus = this.getMenuDefs();
    for (const menu of menus) {
      const wrapper = document.createElement("div");
      wrapper.className = "menubar-menu";
      wrapper.style.position = "relative";
      wrapper.style.display = "inline-block";

      const menuBtn = document.createElement("button");
      menuBtn.className = "menubar-item";
      menuBtn.dataset["menuId"] = menu.id;
      this.reg(menuBtn, menu.label);
      this.menuButtons.set(menu.id, menuBtn);

      const dropdown = document.createElement("div");
      dropdown.className = "menu-dropdown";
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
          entry.disabled = true;
          this.docMenuEntries.push(entry);
        }

        dropdown.append(entry);
      }

      this.dropdowns.set(menu.id, dropdown);
      wrapper.append(menuBtn, dropdown);
      this.menuBarEl.append(wrapper);
    }
  }

  private setupMenuInteraction(): void {
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

    this.menuBarEl.addEventListener("mouseover", (e) => {
      if (!this.activeMenuId) return;
      const btn = (e.target as HTMLElement).closest(".menubar-item") as HTMLButtonElement | null;
      if (!btn) return;
      const id = btn.dataset["menuId"]!;
      if (id !== this.activeMenuId) {
        this.openMenu(id);
      }
    });

    document.addEventListener("mousedown", (e) => {
      if (!this.activeMenuId) return;
      if (this.menuBarEl.contains(e.target as Node)) return;
      this.closeAllMenus();
    });

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
    if (this.activeMenuId && this.activeMenuId !== id) {
      this.dropdowns.get(this.activeMenuId)?.classList.remove("open");
      this.menuButtons.get(this.activeMenuId)?.classList.remove("open");
    }

    this.activeMenuId = id;
    const dropdown = this.dropdowns.get(id)!;
    const btn = this.menuButtons.get(id)!;
    dropdown.classList.add("open");
    btn.classList.add("open");

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

    const first = dropdown.querySelector<HTMLButtonElement>(".menu-entry:not(:disabled)");
    first?.focus();
  }

  private closeAllMenus(): void {
    if (!this.activeMenuId) return;
    this.dropdowns.get(this.activeMenuId)?.classList.remove("open");
    this.menuButtons.get(this.activeMenuId)?.classList.remove("open");
    this.activeMenuId = null;
  }

  private buildContextToolbar(): void {
    const main = document.createElement("div");
    main.className = "tb-row tb-main";
    this.mainRow = main;
    this.contextEl.append(main, this.tools.row);

    this.sidebarBtn = this.btn(ICON_SIDEBAR, "Show or hide the page thumbnails", "icon-btn panel-toggle");
    this.reg(this.sidebarBtn, undefined, "ttPageSidebar");
    this.sidebarBtn.addEventListener("click", () => this.emit({ type: "toggle-sidebar" }));

    this.saveBtn = this.btn(ICON_SAVE, "Save (Ctrl+S)", "icon-btn tb-square tb-save");
    this.reg(this.saveBtn, undefined, "ttSave");
    this.saveBtn.addEventListener("click", () => this.emit({ type: "save" }));

    const undo = this.btn(ICON_UNDO, "Undo (Ctrl+Z)", "icon-btn");
    this.reg(undo, undefined, "ttUndo");
    undo.addEventListener("click", () => this.emit({ type: "undo" }));
    const redo = this.btn(ICON_REDO, "Redo (Ctrl+Y)", "icon-btn");
    this.reg(redo, undefined, "ttRedo");
    redo.addEventListener("click", () => this.emit({ type: "redo" }));

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

    const zoomOut = this.btn(ICON_MINUS, "Zoom out (Ctrl+−)", "icon-btn");
    this.reg(zoomOut, undefined, "ttZoomOut");
    zoomOut.addEventListener("click", () => this.emit({ type: "zoom-out" }));
    const zoomIn = this.btn(ICON_PLUS, "Zoom in (Ctrl++)", "icon-btn");
    this.reg(zoomIn, undefined, "ttZoomIn");
    zoomIn.addEventListener("click", () => this.emit({ type: "zoom-in" }));

    this.zoomLabel = this.btn("100 %", "Click to type a zoom level (Ctrl+0 resets it)", "zoom-label");
    this.reg(this.zoomLabel, undefined, "ttZoomLabel");
    this.zoomLabel.addEventListener("click", () => {
      if (this.mainRow.classList.contains("tb-zoom-stack")) this.toggleZoomMenu();
      else this.startZoomEdit();
    });
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

    const realSizeBtn = this.btn("1:1", "Real size (1:1)", "icon-btn text-icon-btn tb-real");
    this.reg(realSizeBtn, undefined, "ttRealSize");
    realSizeBtn.addEventListener("click", () => this.emit({ type: "zoom-real" }));
    realSizeBtn.classList.add("zoom-real");
    zoomOut.classList.add("zoom-step");
    zoomIn.classList.add("zoom-step");

    // A narrow window folds − + and 1:1 into a small up/down pair beside the level; the level then
    // opens a menu with the fits and 1:1 (see fitMainRow).
    const stack = document.createElement("span");
    stack.className = "zoom-stack";
    const stackBtn = (icon: string, title: string, key: keyof Translations, e: ToolbarEvent): HTMLButtonElement => {
      const b = this.btn(icon, title, "zoom-stack-btn");
      this.reg(b, undefined, key);
      b.addEventListener("click", () => this.emit(e));
      return b;
    };
    stack.append(
      stackBtn(ICON_CHEVRON_UP, "Zoom in (Ctrl++)", "ttZoomIn", { type: "zoom-in" }),
      stackBtn(ICON_CHEVRON_DOWN, "Zoom out (Ctrl+−)", "ttZoomOut", { type: "zoom-out" }),
    );
    this.zoomMenu = this.buildZoomMenu();

    this.reg(this.brightness.button, undefined, "settingsBrightness");

    this.pagesBtn = this.btn(ICON_PAGES_1, "Two pages (odd on left)", "icon-btn tb-pages");
    this.reg(this.pagesBtn, undefined, "ttPages2");
    this.pagesBtn.addEventListener("click", () => {
      if (this.shownColumns === 1) {
        this.emit({ type: "columns", n: 2, even: false });
      } else if (!this.shownEvenSpread) {
        this.emit({ type: "columns", n: 2, even: true });
      } else {
        this.emit({ type: "columns", n: 1, even: false });
      }
    });

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
    modeSeg.classList.add("mode-segment");

    this.moreBtn = this.btn(ICON_MORE, "More tools", "icon-btn tb-square tb-more");
    this.reg(this.moreBtn, undefined, "ttMore");
    this.moreBtn.setAttribute("aria-haspopup", "menu");
    this.moreBtn.setAttribute("aria-expanded", "false");
    this.moreBtn.addEventListener("click", () => this.toggleMoreMenu());
    this.moreMenu = document.createElement("div");
    this.moreMenu.className = "tb-more-menu";
    this.moreMenu.setAttribute("role", "menu");
    const moreEntry = (icon: string, text: string, key: keyof Translations | null, e: ToolbarEvent, shortcut?: string): HTMLButtonElement => {
      const entry = document.createElement("button");
      entry.className = "menu-entry";
      entry.setAttribute("role", "menuitem");
      const ic = document.createElement("span");
      ic.className = "more-icon";
      ic.innerHTML = icon;
      const label = document.createElement("span");
      label.className = "more-label";
      label.textContent = text;
      if (key) this.reg(label, key);
      entry.append(ic, label);
      if (shortcut) {
        const sc = document.createElement("span");
        sc.className = "shortcut";
        sc.textContent = shortcut;
        entry.append(sc);
      }
      entry.addEventListener("click", () => { this.closeMoreMenu(); this.emit(e); });
      return entry;
    };
    const moreSep = document.createElement("div");
    moreSep.className = "menu-sep";
    this.lockEntry = moreEntry(ICON_UNLOCK, this.lockTexts.off, null, { type: "password" });
    this.lockEntry.classList.add("more-lock");
    this.infoEntry = moreEntry(ICON_INFO, "Document info", "ttInfo", { type: "info" });
    this.moreMenu.append(
      moreEntry(ICON_EXPORT, "Export or convert…", "moreExport", { type: "export" }),
      moreEntry(ICON_COMPRESS_LAYERS, "Compress…", "moreCompress", { type: "compress" }),
      this.lockEntry,
      moreSep,
      this.infoEntry,
      moreEntry(ICON_PRESENT, "Present", "menuPresent", { type: "present" }, "F5"),
    );
    this.setupMoreMenu();
    const moreWrap = document.createElement("div");
    moreWrap.className = "tb-more-wrap";
    moreWrap.append(this.moreBtn, this.moreMenu);

    const action = (icon: string, title: string, key: keyof Translations, e: ToolbarEvent): HTMLButtonElement => {
      const b = this.btn(icon, title, "icon-btn");
      this.reg(b, undefined, key);
      b.addEventListener("click", () => this.emit(e));
      return b;
    };
    this.lockBtn = action(ICON_UNLOCK, this.lockTitles.off, "ttLockOff", { type: "password" });
    this._i18nTitle.delete(this.lockBtn);
    this.lockBtn.classList.add("tb-lock");
    this.infoBtn = action(ICON_INFO, "Document info", "ttInfo", { type: "info" });
    const actions = this.segment(
      action(ICON_EXPORT, "Export or convert (pictures, Word, Excel…)", "ttExport", { type: "export" }),
      action(ICON_COMPRESS_LAYERS, "Compress PDF", "ttCompress", { type: "compress" }),
      this.lockBtn,
      this.brightness.el,
      this.pagesBtn,
      action(ICON_PRESENT, "Present (F5)", "ttPresent", { type: "present" }),
      this.infoBtn,
    );
    actions.classList.add("tb-actions");

    this.themeSwitch = document.createElement("button");
    this.themeSwitch.className = "theme-switch";
    this.themeSwitch.setAttribute("role", "switch");
    this.themeSwitch.title = "Dark theme";
    this.reg(this.themeSwitch, undefined, "ttDarkTheme");
    this.themeSwitch.innerHTML =
      `<span class="theme-switch-icon sun" aria-hidden="true">${ICON_SUN}</span>` +
      `<span class="theme-switch-icon moon" aria-hidden="true">${ICON_MOON}</span>` +
      `<span class="theme-switch-knob" aria-hidden="true"></span>`;
    this.themeSwitch.addEventListener("click", () => {
      this.emit({ type: "theme", dark: document.documentElement.dataset["theme"] !== "dark" });
    });
    this.syncThemeSwitch();
    if (typeof MutationObserver !== "undefined") {
      new MutationObserver(() => this.syncThemeSwitch())
        .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    }

    const right = document.createElement("div");
    right.className = "toolbar-group tb-right";
    right.append(moreWrap, this.themeSwitch, this.search.el);

    const left = document.createElement("div");
    left.className = "toolbar-group tb-left";
    left.append(
      this.sidebarBtn, modeSeg, this.sep(),
      this.saveBtn, this.segment(undo, redo), this.sep(),
      this.pointerSegment(),
      this.zoomSegment(this.segment(zoomOut, this.zoomLabel, this.zoomInput, zoomIn, realSizeBtn, stack)),
      actions,
    );
    main.append(left, right);
    this.idleParts = [
      ...Array.from(left.children).filter((el) => el !== this.sidebarBtn) as HTMLElement[],
      moreWrap, this.search.el, this.tools.row,
    ];
    this.updateLayout(null, "vertical");
    this.syncModeBtns();

    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => this.fitMainRow(main));
      ro.observe(main);
      ro.observe(this.search.el);
    }
  }

  private toggleMoreMenu(): void {
    if (this.moreMenu.classList.contains("open")) { this.closeMoreMenu(); return; }
    this.closeAllMenus();
    this.moreMenu.classList.add("open");
    this.moreBtn.classList.add("open");
    this.moreBtn.setAttribute("aria-expanded", "true");
    this.moreMenu.querySelector<HTMLButtonElement>(".menu-entry:not(:disabled)")?.focus();
  }

  private closeMoreMenu(): void {
    if (!this.moreMenu.classList.contains("open")) return;
    this.moreMenu.classList.remove("open");
    this.moreBtn.classList.remove("open");
    this.moreBtn.setAttribute("aria-expanded", "false");
  }

  private setupMoreMenu(): void {
    document.addEventListener("mousedown", (e) => {
      const target = e.target as Node;
      if (this.moreMenu.contains(target) || this.moreBtn.contains(target)) return;
      this.closeMoreMenu();
    });
    window.addEventListener("blur", () => this.closeMoreMenu());
    this.moreMenu.addEventListener("keydown", (e) => {
      const entries = Array.from(this.moreMenu.querySelectorAll<HTMLButtonElement>(".menu-entry:not(:disabled)"));
      const at = entries.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "Escape") {
        this.closeMoreMenu();
        this.moreBtn.focus();
      } else if (e.key === "ArrowDown") {
        entries[(at + 1) % entries.length]?.focus();
      } else if (e.key === "ArrowUp") {
        entries[(at - 1 + entries.length) % entries.length]?.focus();
      } else if (e.key === "Home") {
        entries[0]?.focus();
      } else if (e.key === "End") {
        entries[entries.length - 1]?.focus();
      } else if (e.key === "Tab") {
        this.closeMoreMenu();
        return;
      } else {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    });
  }

  private fitMainRow(main: HTMLElement): void {
    const levels = ["tb-zoom-stack", "tb-fold", "tb-compact", "tb-compact-2", "tb-compact-3", "tb-compact-4", "tb-compact-5"];
    const searchOpen = [250, 250, 250, 190, 160, 120, 120, 120];
    const pill = this.search.el;
    const open = pill.classList.contains("open");
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
      return held(left) + rightW + gapOf(main) - room;
    };
    main.classList.remove(...levels);
    let level = 0;
    while (level < levels.length && overflow(level) > 0) main.classList.add(levels[level++]);
    if (level === 0) this.closeZoomMenu();
    const w = `${searchOpen[level]}px`;
    if (pill.style.getPropertyValue("--search-open-w") !== w) pill.style.setProperty("--search-open-w", w);
  }

  setMode(mode: AppMode): void {
    const adjusting = document.getElementById("app")?.classList.contains("adjusting") ?? false;
    if ((mode === this.mode && !adjusting) || this.refusedReadOnly({ type: "mode-change", mode }) || !this.allowed()) return;
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

  private zoomSegment(seg: HTMLElement): HTMLElement {
    seg.classList.add("zoom-seg");
    seg.append(this.zoomMenu);
    return seg;
  }

  private buildZoomMenu(): HTMLElement {
    const menu = document.createElement("div");
    menu.className = "zoom-menu";
    menu.setAttribute("role", "menu");
    const entry = (key: keyof Translations, fb: string, e: (() => void), shortcut?: string): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "menu-entry";
      b.setAttribute("role", "menuitem");
      const label = document.createElement("span");
      label.textContent = fb;
      this.reg(label, key);
      b.append(label);
      if (shortcut) {
        const sc = document.createElement("span");
        sc.className = "shortcut";
        sc.textContent = shortcut;
        b.append(sc);
      }
      b.addEventListener("click", () => { this.closeZoomMenu(); e(); });
      return b;
    };
    const sep = document.createElement("div");
    sep.className = "menu-sep";
    menu.append(
      entry("menuFitWidth", "Fit to width", () => this.emit({ type: "fit-width" })),
      entry("menuFitHeight", "Fit to height", () => this.emit({ type: "fit-height" })),
      entry("ttRealSize", "Actual size (1:1)", () => this.emit({ type: "zoom-real" })),
      sep,
      entry("zoomTypeLevel", "Type a zoom level…", () => this.startZoomEdit()),
    );
    document.addEventListener("mousedown", (e) => {
      const t = e.target as Node;
      if (!menu.contains(t) && !this.zoomLabel.contains(t)) this.closeZoomMenu();
    }, true);
    window.addEventListener("blur", () => this.closeZoomMenu());
    menu.addEventListener("keydown", (e) => {
      const entries = Array.from(menu.querySelectorAll<HTMLButtonElement>(".menu-entry"));
      const at = entries.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "Escape") { e.preventDefault(); this.closeZoomMenu(); this.zoomLabel.focus(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); entries[(at + 1) % entries.length]?.focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); entries[(at - 1 + entries.length) % entries.length]?.focus(); }
    });
    return menu;
  }

  private toggleZoomMenu(): void {
    if (this.zoomMenu.classList.contains("open")) { this.closeZoomMenu(); return; }
    this.closeAllMenus();
    this.zoomMenu.classList.add("open");
    this.zoomLabel.classList.add("open");
    this.zoomLabel.setAttribute("aria-expanded", "true");
    this.zoomMenu.querySelector<HTMLButtonElement>(".menu-entry")?.focus();
  }

  private closeZoomMenu(): void {
    if (!this.zoomMenu?.classList.contains("open")) return;
    this.zoomMenu.classList.remove("open");
    this.zoomLabel.classList.remove("open");
    this.zoomLabel.setAttribute("aria-expanded", "false");
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

  private commitZoomInput(): void {
    const raw = this.zoomInput.value.replace("%", "").trim();
    const pct = parseFloat(raw);
    if (!isNaN(pct) && pct >= MIN_SCALE * 100 && pct <= MAX_SCALE * 100) {
      const scale = Math.round(pct) / 100 * CSS_UNITS;
      this.updateZoom(scale);
      this.emit({ type: "zoom-set", scale });
    }
  }

  clearActiveTool(): void { this.tools.clearTool(); }

  setPageSelection(count: number): void { this.tools.setPageSelection(count); }
}
