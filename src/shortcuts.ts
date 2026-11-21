/** The parts of a key press a shortcut looks at. */
export interface KeyPress {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Whether `e` is the shortcut written as in the menus ("Ctrl+Shift+S", "Ctrl++", "F5").
 * Ctrl stands for Cmd on macOS, so either key counts. Shift must match. "+" also matches "=",
 * the same key without Shift on most layouts.
 */
export function matchesShortcut(shortcut: string, e: KeyPress): boolean {
  const parts = shortcut.endsWith("++") ? [...shortcut.slice(0, -2).split("+"), "+"] : shortcut.split("+");
  const key = parts.pop()!;
  const ctrl = parts.includes("Ctrl");
  const shift = parts.includes("Shift");
  if (e.altKey || ctrl !== (e.ctrlKey || e.metaKey)) return false;
  if (key === "+") return e.key === "+" || e.key === "=";
  if (shift !== e.shiftKey) return false;
  return e.key.toLowerCase() === key.toLowerCase();
}
