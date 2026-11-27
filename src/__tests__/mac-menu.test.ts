// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

type Opts = { text?: string; items?: Fake[]; item?: unknown; accelerator?: string; enabled?: boolean; checked?: boolean; action?: () => void };

const { Fake, state } = vi.hoisted(() => {
  const state = { appMenus: 0, menu: null as unknown, focus: null as ((e: { payload: boolean }) => void) | null };
  class Fake {
    text: string;
    enabled: boolean;
    checked: boolean;
    constructor(readonly kind: string, readonly opts: Opts) {
      this.text = opts.text ?? "";
      this.enabled = opts.enabled ?? true;
      this.checked = opts.checked ?? false;
    }
    async setText(t: string) { this.text = t; }
    async setEnabled(on: boolean) { this.enabled = on; }
    async setChecked(on: boolean) { this.checked = on; }
    async setAsAppMenu() { state.appMenus++; }
  }
  return { Fake, state };
});
type Fake = InstanceType<typeof Fake>;

vi.mock("@tauri-apps/api/menu", () => {
  const make = (kind: string) => class extends Fake {
    static async new(opts: Opts) {
      const f = new this(kind, opts);
      if (kind === "menu") state.menu = f;
      return f;
    }
  };
  return { Menu: make("menu"), Submenu: make("submenu"), MenuItem: make("item"), CheckMenuItem: make("check"), PredefinedMenuItem: make("predefined") };
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onFocusChanged: async (cb: (e: { payload: boolean }) => void) => { state.focus = cb; } }),
}));

const { MacMenu, accelerator, menuOwnsKey } = await import("../mac-menu");
import type { Translations } from "../i18n";

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

function build() {
  const calls: string[] = [];
  const t = { menuFile: "File", menuEdit: "Edit", menuOpen: "Open", menuUndo: "Undo", menuRedo: "Redo", menuSettings: "Settings" } as unknown as Translations;
  const menu = new MacMenu([
    { id: "file", label: "menuFile", items: [
      null,
      { label: "menuOpen", shortcut: "Ctrl+O", action: () => calls.push("open") },
      null,
      null,
      { label: "menuSave" as keyof Translations, shortcut: "Ctrl+S", requiresDoc: true, action: () => calls.push("save") },
      { label: "menuFullscreen" as keyof Translations, shortcut: "F11", action: () => calls.push("full") },
      { label: "menuSettings", appMenu: true, action: () => calls.push("settings") },
      null,
    ] },
    { id: "edit", label: "menuEdit", items: [
      { label: "menuUndo", shortcut: "Ctrl+Z", action: () => calls.push("undo") },
      { label: "menuRedo", shortcut: "Ctrl+Y", action: () => calls.push("redo") },
      { label: "menuDark" as keyof Translations, mark: { id: "dark", kind: "check" }, action: () => calls.push("dark") },
    ] },
  ], t);
  return { menu, calls, t };
}

const tree = () => state.menu as Fake;
const sub = (name: string) => tree().opts.items!.find((s) => s.text === name)!;
const entry = (s: Fake, text: string) => s.opts.items!.find((i) => i.text === text)!;

describe("mac menu", () => {
  beforeEach(() => { state.appMenus = 0; state.menu = null; state.focus = null; document.body.innerHTML = ""; });

  it("maps shortcuts to macOS accelerators", () => {
    expect(accelerator(undefined)).toBeUndefined();
    expect(accelerator("Ctrl++")).toBe("CmdOrCtrl+=");
    expect(accelerator("Ctrl+-")).toBe("CmdOrCtrl+-");
    expect(accelerator("Ctrl+Y")).toBe("CmdOrCtrl+Shift+Z");
    expect(accelerator("F11")).toBe("Ctrl+Cmd+F");
    expect(accelerator("Ctrl+Shift+S")).toBe("CmdOrCtrl+Shift+S");
    expect(accelerator("Delete")).toBe("Delete");
  });

  it("builds the app, document and window menus and installs them", async () => {
    build();
    await flush();
    const names = tree().opts.items!.map((s) => s.text);
    expect(names).toEqual(["EzReader", "File", "Edit", "Window"]);
    expect(state.appMenus).toBe(1);

    const app = sub("EzReader");
    expect(app.opts.items!.some((i) => i.text === "Settings")).toBe(true);

    const file = sub("File").opts.items!;
    expect(file.map((i) => i.kind)).toEqual(["item", "predefined", "item"]);
    expect(file.some((i) => i.text === "menuFullscreen")).toBe(false);
    expect(entry(sub("File"), "Open").opts.accelerator).toBe("CmdOrCtrl+O");
    expect(entry(sub("File"), "menuSave").enabled).toBe(false);

    const edit = sub("Edit").opts.items!.map((i) => i.kind);
    expect(edit).toEqual(["item", "item", "predefined", "predefined", "predefined", "predefined", "predefined", "check"]);

    state.focus!({ payload: false });
    state.focus!({ payload: true });
    await flush();
    expect(state.appMenus).toBe(2);
  });

  it("runs actions, and leaves undo to a focused text field", async () => {
    const { calls } = build();
    await flush();
    entry(sub("File"), "Open").opts.action!();
    entry(sub("EzReader"), "Settings").opts.action!();
    entry(sub("Edit"), "Undo").opts.action!();
    expect(calls).toEqual(["open", "settings", "undo"]);

    const exec = vi.fn();
    Object.defineProperty(document, "execCommand", { value: exec, configurable: true });
    document.body.innerHTML = "<input>";
    document.querySelector("input")!.focus();
    entry(sub("Edit"), "Undo").opts.action!();
    entry(sub("Edit"), "Redo").opts.action!();
    expect(exec.mock.calls).toEqual([["undo"], ["redo"]]);
    expect(calls).toEqual(["open", "settings", "undo"]);
  });

  it("follows the document, the marks and the language", async () => {
    const { menu } = build();
    menu.setLoaded(true);
    menu.setMark("dark", true);
    menu.setMark("missing", true);
    await flush();
    expect(entry(sub("File"), "menuSave").enabled).toBe(true);
    expect(entry(sub("Edit"), "menuDark").checked).toBe(true);

    menu.setLoaded(false);
    menu.applyTranslations({ menuFile: "Fichier", menuOpen: "Ouvrir" } as unknown as Translations);
    await flush();
    expect(sub("Fichier")).toBeDefined();
    expect(entry(sub("Fichier"), "Ouvrir")).toBeDefined();
    expect(entry(sub("Fichier"), "menuSave").enabled).toBe(false);
  });

  it("claims the Command shortcuts the menu handles", async () => {
    const key = (k: string, over: Partial<KeyboardEventInit> = {}) => new KeyboardEvent("keydown", { key: k, metaKey: true, ...over });
    build();
    await flush();
    expect(menuOwnsKey(key("o"))).toBe(true);
    expect(menuOwnsKey(key("S"))).toBe(true);
    expect(menuOwnsKey(key("k"))).toBe(false);
    expect(menuOwnsKey(key("o", { metaKey: false }))).toBe(false);
    expect(menuOwnsKey(key("o", { altKey: true }))).toBe(false);
    expect(menuOwnsKey(key("o", { ctrlKey: true }))).toBe(false);
  });
});
