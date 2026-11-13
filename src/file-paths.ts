/** The file name at the end of `path` (either separator). */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** `path` with its file name replaced by `name` (same folder). */
export function withFileName(path: string, name: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(0, cut + 1) + name;
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
