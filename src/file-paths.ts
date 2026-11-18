export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function withFileName(path: string, name: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(0, cut + 1) + name;
}

export function splitFileName(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

export function isValidFileStem(stem: string): boolean {
  if (!stem.trim() || stem !== stem.trimEnd() || stem.endsWith(".")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(stem)) return false;
  return !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem);
}
