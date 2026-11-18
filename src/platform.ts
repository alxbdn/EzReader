export const isMac: boolean =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent || "");

export function macShortcuts(text: string): string {
  return text
    .replace(/Ctrl\+Y\b/g, "⇧⌘Z")
    .replace(/Ctrl\+(?:Shift|Maj)\+(?=\S)/g, "⇧⌘")
    .replace(/Ctrl\+(?=[\p{L}]{2,})/gu, "⌘-")
    .replace(/Ctrl\+(?=\S)/g, "⌘");
}
