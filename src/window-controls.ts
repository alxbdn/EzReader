import { getCurrentWindow } from "@tauri-apps/api/window";

// The native title bar is turned off (decorations: false), so the menu row
// doubles as the title bar: empty space drags the window, a double click
// maximises it, and the three buttons below replace the system ones.

const ICON_MIN = `<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5h10" stroke="currentColor" stroke-width="1"/></svg>`;
const ICON_MAX = `<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>`;
const ICON_RESTORE = `<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/><path d="M2.5 2.5V0.5h7v7h-2" fill="none" stroke="currentColor" stroke-width="1"/></svg>`;
const ICON_CLOSE = `<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" stroke-width="1"/></svg>`;

export interface WindowControlLabels {
  minimize: string;
  maximize: string;
  restore: string;
  close: string;
}

/** `labels` is read on every state change so a language switch is picked up. */
export function mountWindowControls(row: HTMLElement, getLabels: () => WindowControlLabels): void {
  if (!("__TAURI_INTERNALS__" in window)) return;

  const win = getCurrentWindow();
  row.setAttribute("data-tauri-drag-region", "");
  document.body.classList.add("custom-titlebar");

  const group = document.createElement("div");
  group.className = "window-controls";

  const labels = getLabels();
  const make = (cls: string, icon: string, title: string, onClick: () => void, i18nKey?: string) => {
    const btn = document.createElement("button");
    btn.className = `window-control ${cls}`;
    btn.innerHTML = icon;
    btn.title = title;
    btn.setAttribute("aria-label", title);
    if (i18nKey) btn.dataset["i18nTitle"] = i18nKey;
    btn.tabIndex = -1;
    btn.addEventListener("click", onClick);
    btn.addEventListener("dblclick", (e) => e.stopPropagation());
    group.append(btn);
    return btn;
  };

  make("wc-min", ICON_MIN, labels.minimize, () => { void win.minimize(); }, "wcMinimize");
  const maxBtn = make("wc-max", ICON_MAX, labels.maximize, () => { void win.toggleMaximize(); });
  make("wc-close", ICON_CLOSE, labels.close, () => { void win.close(); }, "wcClose");

  row.append(group);

  const syncMax = async () => {
    try {
      const maximized = await win.isMaximized();
      maxBtn.innerHTML = maximized ? ICON_RESTORE : ICON_MAX;
      const l = getLabels();
      const t = maximized ? l.restore : l.maximize;
      maxBtn.title = t;
      maxBtn.setAttribute("aria-label", t);
      document.body.classList.toggle("window-maximized", maximized);
    } catch { /* not available in tests */ }
  };
  void syncMax();
  void win.onResized(() => { void syncMax(); }).catch(() => {});
}
