import { loadPictureFile } from "./tauri-bridge";

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

/** `w` × `h` scaled down (never up) to fit in `maxW` × `maxH`. */
export function fitWithin(w: number, h: number, maxW: number, maxH: number): { width: number; height: number } {
  const k = Math.min(1, maxW / Math.max(w, 1e-6), maxH / Math.max(h, 1e-6));
  return { width: w * k, height: h * k };
}

/**
 * Reads the picture at `path`. The Rust side keeps PNG and JPEG files as
 * they are, and re-encodes other formats and very large pictures into what
 * the PDF writer understands.
 */
export async function loadPicture(path: string): Promise<Picture> {
  return loadPictureFile(path);
}
