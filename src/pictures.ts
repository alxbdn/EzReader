import { readImageFile } from "./tauri-bridge";

/** A picture ready to place on a page or to become one: base64 PNG or JPEG. */
export interface Picture {
  data: string;
  width: number;
  height: number;
}

/** Longest side kept for a picture; larger ones are scaled down. */
const MAX_SIDE = 4096;

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
 * Reads the picture at `path`. PNG and JPEG files are kept as they are;
 * other formats, and very large pictures, are redrawn as PNG (or JPEG for
 * photos), which the PDF writer understands.
 */
export async function loadPicture(path: string): Promise<Picture> {
  const ext = (path.match(IMAGE_EXT)?.[1] ?? "").toLowerCase();
  const jpeg = ext === "jpg" || ext === "jpeg";
  const b64 = await readImageFile(path);
  const img = new Image();
  img.src = `data:image/${jpeg ? "jpeg" : ext};base64,${b64}`;
  await img.decode();
  const w = img.naturalWidth, h = img.naturalHeight;
  if ((jpeg || ext === "png") && Math.max(w, h) <= MAX_SIDE) return { data: b64, width: w, height: h };

  const size = fitWithin(w, h, MAX_SIDE, MAX_SIDE);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(size.width));
  canvas.height = Math.max(1, Math.round(size.height));
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  const url = jpeg ? canvas.toDataURL("image/jpeg", 0.92) : canvas.toDataURL("image/png");
  return { data: url.slice(url.indexOf(",") + 1), width: canvas.width, height: canvas.height };
}
