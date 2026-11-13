/** The file name at the end of `path` (either separator). */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** `path` with its file name replaced by `name` (same folder). */
export function withFileName(path: string, name: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(0, cut + 1) + name;
}
