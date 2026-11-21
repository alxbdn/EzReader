import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Translations } from "./i18n";

export interface NativeMenuItem {
  label: keyof Translations;
  shortcut?: string;
  action: () => void;
  requiresDoc?: boolean;
  mark?: { id: string; kind: "radio" | "check" };
  appMenu?: boolean;
}

export interface NativeMenu {
  id: string;
  label: keyof Translations;
  items: (NativeMenuItem | null)[];
}

export function accelerator(shortcut: string | undefined): string | undefined {
  if (!shortcut) return undefined;
  switch (shortcut) {
    case "Ctrl++": return "CmdOrCtrl+=";
    case "Ctrl+-": return "CmdOrCtrl+-";
    case "Ctrl+Y": return "CmdOrCtrl+Shift+Z";
    case "F11": return "Ctrl+Cmd+F";
  }
  return shortcut.replace(/^Ctrl\+/, "CmdOrCtrl+");
}

export function menuOwnsKey(e: KeyboardEvent): boolean {
  if (!menuUp || !e.metaKey || e.altKey || e.ctrlKey) return false;
  return OWNED_KEYS.has(e.key.toLowerCase());
}

const OWNED_KEYS = new Set(["o", "s", "p", ",", "z", "f", "e", "d", "+", "=", "-", "0"]);
let menuUp = false;

function editing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

type Entry = { item: MenuItem | CheckMenuItem; def: NativeMenuItem };

export class MacMenu {
  private entries: Entry[] = [];
  private marks = new Map<string, CheckMenuItem>();
  private submenus: [Submenu, keyof Translations][] = [];
  private loaded = false;
  private ready: Promise<void>;
  private menu: Menu | null = null;

  constructor(menus: NativeMenu[], t: Translations) {
    this.ready = this.build(menus, t).catch((e) => { console.error("native menu", e); });
  }

  private async build(menus: NativeMenu[], t: Translations): Promise<void> {
    const sep = () => PredefinedMenuItem.new({ item: "Separator" });
    const make = async (def: NativeMenuItem): Promise<MenuItem | CheckMenuItem> => {
      const opts = {
        text: t[def.label] ?? String(def.label),
        accelerator: accelerator(def.shortcut),
        enabled: !def.requiresDoc,
        action: () => {
          if ((def.label === "menuUndo" || def.label === "menuRedo") && editing()) {
            document.execCommand(def.label === "menuUndo" ? "undo" : "redo");
            return;
          }
          def.action();
        },
      };
      const item = def.mark ? await CheckMenuItem.new({ ...opts, checked: false }) : await MenuItem.new(opts);
      this.entries.push({ item, def });
      if (def.mark && item instanceof CheckMenuItem) this.marks.set(def.mark.id, item);
      return item;
    };

    const appItems = menus.flatMap((m) => m.items).filter((i): i is NativeMenuItem => !!i?.appMenu);
    const app = await Submenu.new({
      text: "EzReader",
      items: [
        await PredefinedMenuItem.new({ item: { About: { name: "EzReader" } } }),
        await sep(),
        ...(await Promise.all(appItems.map(make))),
        await sep(),
        await PredefinedMenuItem.new({ item: "Services" }),
        await sep(),
        await PredefinedMenuItem.new({ item: "Hide" }),
        await PredefinedMenuItem.new({ item: "HideOthers" }),
        await PredefinedMenuItem.new({ item: "ShowAll" }),
        await sep(),
        await PredefinedMenuItem.new({ item: "Quit" }),
      ],
    });

    const subs: Submenu[] = [app];
    for (const menu of menus) {
      const items: (MenuItem | CheckMenuItem | PredefinedMenuItem)[] = [];
      const defs = menu.items.filter((i) => !i?.appMenu && i?.shortcut !== "F11");
      for (const [i, def] of defs.entries()) {
        if (def === null) {
          if (i > 0 && i < defs.length - 1 && defs[i - 1] !== null) items.push(await sep());
          continue;
        }
        items.push(await make(def));
        if (menu.id === "edit" && def.shortcut === "Ctrl+Y") {
          items.push(
            await sep(),
            await PredefinedMenuItem.new({ item: "Cut" }),
            await PredefinedMenuItem.new({ item: "Copy" }),
            await PredefinedMenuItem.new({ item: "Paste" }),
            await PredefinedMenuItem.new({ item: "SelectAll" }),
          );
        }
      }
      const sub = await Submenu.new({ text: t[menu.label] ?? menu.id, items });
      this.submenus.push([sub, menu.label]);
      subs.push(sub);
    }
    subs.push(await Submenu.new({
      text: t.menuWindow ?? "Window",
      items: [
        await PredefinedMenuItem.new({ item: "Minimize" }),
        await PredefinedMenuItem.new({ item: "Maximize" }),
        await sep(),
        await PredefinedMenuItem.new({ item: "CloseWindow" }),
      ],
    }));

    this.menu = await Menu.new({ items: subs });
    const win = getCurrentWindow();
    const show = async () => {
      await this.menu?.setAsAppMenu();
      menuUp = true;
    };
    await show();
    await win.onFocusChanged(({ payload: focused }) => { if (focused) void show(); });
  }

  applyTranslations(t: Translations): void {
    void this.ready.then(async () => {
      for (const { item, def } of this.entries) await item.setText(t[def.label] ?? String(def.label));
      for (const [sub, label] of this.submenus) await sub.setText(t[label] ?? String(label));
    });
  }

  setLoaded(loaded: boolean): void {
    this.loaded = loaded;
    void this.ready.then(async () => {
      for (const { item, def } of this.entries) {
        if (def.requiresDoc) await item.setEnabled(this.loaded);
      }
    });
  }

  setMark(id: string, on: boolean): void {
    void this.ready.then(() => this.marks.get(id)?.setChecked(on));
  }
}
