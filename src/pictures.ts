/** A picture ready to place on a page or to become one: base64 PNG or JPEG. */
export interface Picture {
  data: string;
  width: number;
  height: number;
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;

export function isImagePath(path: string): boolean {
  return IMAGE_EXT.test(path);
}

/** What the launcher does with a file it is asked to open. */
export function openKind(path: string): "pdf" | "pictures" | null {
  if (/\.pdf$/i.test(path)) return "pdf";
  return isImagePath(path) ? "pictures" : null;
}

/**
 * Pictures opened as a new document: its file name ("Scan.pdf" for
 * "C:\Photos\Scan.jpg") and where its first Save suggests putting it
 * (next to the first picture).
 */
export function picturesDocument(paths: string[]): { name: string; suggested: string } {
  const first = paths[0] ?? "";
  const cut = Math.max(first.lastIndexOf("/"), first.lastIndexOf("\\"));
  const file = first.slice(cut + 1);
  const dot = file.lastIndexOf(".");
  const name = `${(dot > 0 ? file.slice(0, dot) : file) || "Pictures"}.pdf`;
  return { name, suggested: first.slice(0, cut + 1) + name };
}

/** `w` × `h` scaled down (never up) to fit in `maxW` × `maxH`. */
export function fitWithin(w: number, h: number, maxW: number, maxH: number): { width: number; height: number } {
  const k = Math.min(1, maxW / Math.max(w, 1e-6), maxH / Math.max(h, 1e-6));
  return { width: w * k, height: h * k };
}
