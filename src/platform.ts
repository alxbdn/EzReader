/** True in the macOS app: menus at the top of the screen, ⌘ instead of Ctrl. */
export const isMac: boolean =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent || "");

/**
 * A shortcut written the Windows way ("Ctrl+Shift+S", "Ctrl+click") the way
 * macOS writes it ("⇧⌘S", "⌘-click"). Redo is ⇧⌘Z there, not Ctrl+Y.
 */
export function macShortcuts(text: string): string {
  return text
    .replace(/Ctrl\+Y\b/g, "⇧⌘Z")
    .replace(/Ctrl\+(?:Shift|Maj)\+(?=\S)/g, "⇧⌘")
    .replace(/Ctrl\+(?=[\p{L}]{2,})/gu, "⌘-")
    .replace(/Ctrl\+(?=\S)/g, "⌘");
}
