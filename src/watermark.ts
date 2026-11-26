export interface WatermarkOptions {
  text: string;
  date: string | null;
  code: string | null;
  opacity: number;
}

export const WATERMARK_MAX_CHARS = 100;

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function newCopyCode(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const n = CODE_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = "";
  while (out.length < 6) {
    for (const b of random(12)) {
      if (b < limit && out.length < 6) out += CODE_ALPHABET.charAt(b % n);
    }
  }
  return out;
}

export function watermarkPhrase(o: Pick<WatermarkOptions, "text" | "date" | "code">, copyLabel: string): string {
  const parts = [o.text.trim().replace(/\s+/g, " ")];
  if (o.code) parts.push(`${copyLabel} ${o.code}`);
  if (o.date) parts.push(o.date);
  return parts.filter((p) => p.length > 0).join(" :: ").toLocaleUpperCase() + " ::";
}

export function watermarkGeometry(width: number) {
  const fontSize = width / 46;
  const dotStep = fontSize / 8;
  return {
    fontSize,
    lineGap: fontSize * 1.5,
    amplitude: fontSize * 1.6,
    wavelength: fontSize * 30,
    angle: -Math.PI / 6,
    dotStep,
    dotRadius: dotStep * 0.45,
  };
}

const FONT = "ui-monospace, Consolas, Menlo, 'DejaVu Sans Mono', monospace";

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

function waveStrip(phrase: string, length: number, g: ReturnType<typeof watermarkGeometry>, shift: number): HTMLCanvasElement {
  const pad = g.amplitude + g.fontSize;
  const strip = canvas(length, pad * 2);
  const ctx = strip.getContext("2d")!;
  ctx.font = `700 ${g.fontSize}px ${FONT}`;
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "middle";
  const k = (2 * Math.PI) / g.wavelength;
  const chars = [...phrase, " "];
  let i = shift % chars.length;
  let x = 0;
  while (x < length) {
    const ch = chars[i];
    const w = ctx.measureText(ch).width + g.fontSize * 0.05;
    const mid = x + w / 2;
    const y = pad + g.amplitude * Math.sin(k * mid);
    const slope = Math.atan(g.amplitude * k * Math.cos(k * mid));
    ctx.save();
    ctx.translate(mid, y);
    ctx.rotate(slope);
    ctx.fillText(ch, -w / 2, 0);
    ctx.restore();
    x += w;
    i = (i + 1) % chars.length;
  }
  return strip;
}

export function drawWatermark(ctx: CanvasRenderingContext2D, w: number, h: number, o: WatermarkOptions, copyLabel: string): void {
  const phrase = watermarkPhrase(o, copyLabel);
  if (!phrase.replace(/[\s:]/g, "")) return;
  const g = watermarkGeometry(w);
  const diag = Math.hypot(w, h);

  const mask = canvas(w, h);
  const m = mask.getContext("2d")!;
  const strips = [0, 7, 15].map((shift) => waveStrip(phrase, diag * 1.2, g, shift));
  const pad = g.amplitude + g.fontSize;
  m.save();
  m.translate(w / 2, h / 2);
  m.rotate(g.angle);
  const lines = Math.ceil(diag / g.lineGap) + 2;
  for (let n = -Math.ceil(lines / 2); n <= Math.ceil(lines / 2); n++) {
    m.drawImage(strips[((n % 3) + 3) % 3], -diag * 0.6, n * g.lineGap - pad);
  }
  m.restore();

  const side = Math.max(8, Math.ceil(g.dotStep * 4));
  const k = side / g.dotStep;
  const tile = canvas(side, side);
  const t = tile.getContext("2d")!;
  t.fillStyle = "#fff";
  t.beginPath();
  t.arc(side / 2, side / 2, g.dotRadius * k, 0, Math.PI * 2);
  t.fill();
  m.globalCompositeOperation = "source-in";
  const dots = m.createPattern(tile, "repeat")!;
  dots.setTransform?.(new DOMMatrix().scale(1 / k));
  m.fillStyle = dots;
  m.fillRect(0, 0, w, h);

  const page = ctx.getImageData(0, 0, w, h);
  const under = m.getImageData(0, 0, w, h).data;
  negateUnder(page.data, under, Math.min(1, Math.max(0.1, o.opacity)));
  ctx.putImageData(page, 0, 0);
  mask.width = mask.height = 0;
}

export function dotColor(r: number, g: number, b: number): [number, number, number] {
  const light = 0.299 * r + 0.587 * g + 0.114 * b > 140;
  return light
    ? [r * 0.18, g * 0.18, b * 0.18]
    : [r + (255 - r) * 0.82, g + (255 - g) * 0.82, b + (255 - b) * 0.82];
}

export function negateUnder(page: Uint8ClampedArray, mask: Uint8ClampedArray, opacity: number): void {
  for (let i = 0; i < page.length; i += 4) {
    const a = (mask[i + 3] / 255) * opacity;
    if (a <= 0) continue;
    const [r, g, b] = dotColor(page[i], page[i + 1], page[i + 2]);
    page[i] += (r - page[i]) * a;
    page[i + 1] += (g - page[i + 1]) * a;
    page[i + 2] += (b - page[i + 2]) * a;
  }
}
