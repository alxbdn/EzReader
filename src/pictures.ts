export interface Picture {
  data: string;
  width: number;
  height: number;
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;

export function isImagePath(path: string): boolean {
  return IMAGE_EXT.test(path);
}

export function openKind(path: string): "pdf" | "pictures" | null {
  if (/\.pdf$/i.test(path)) return "pdf";
  return isImagePath(path) ? "pictures" : null;
}

export function picturesDocument(paths: string[]): { name: string; suggested: string } {
  const first = paths[0] ?? "";
  const cut = Math.max(first.lastIndexOf("/"), first.lastIndexOf("\\"));
  const file = first.slice(cut + 1);
  const dot = file.lastIndexOf(".");
  const name = `${(dot > 0 ? file.slice(0, dot) : file) || "Pictures"}.pdf`;
  return { name, suggested: first.slice(0, cut + 1) + name };
}

export function fitWithin(w: number, h: number, maxW: number, maxH: number): { width: number; height: number } {
  const k = Math.min(1, maxW / Math.max(w, 1e-6), maxH / Math.max(h, 1e-6));
  return { width: w * k, height: h * k };
}
