export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Glyph {
  text: string;
  box: Box;
}

const inside = (x: number, y: number, boxes: Box[]) =>
  boxes.some((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom);

export function joinGlyphs(glyphs: Glyph[], boxes: Box[]): string {
  let out = "";
  let prev: Box | null = null;
  for (const g of glyphs) {
    const { box } = g;
    if (!inside((box.left + box.right) / 2, (box.top + box.bottom) / 2, boxes)) continue;
    if (prev) {
      const h = Math.max(1, Math.min(box.bottom - box.top, prev.bottom - prev.top));
      const sameLine = Math.abs((box.top + box.bottom) / 2 - (prev.top + prev.bottom) / 2) < h / 2;
      if (!sameLine) out = out.replace(/ +$/, "") + "\n";
      else if (box.left - prev.right > h * 0.25 && !/\s$/.test(out) && !/^\s/.test(g.text)) out += " ";
    }
    out += g.text;
    prev = box;
  }
  return out.replace(/ +$/gm, "").trim();
}

function glyphsOf(span: HTMLElement): Glyph[] {
  const node = span.firstChild;
  const whole = span.getBoundingClientRect();
  const box = { left: whole.left, top: whole.top, right: whole.right, bottom: whole.bottom };
  if (!(node instanceof Text) || typeof document.createRange !== "function") return [{ text: span.textContent ?? "", box }];
  const range = document.createRange();
  if (typeof range.getBoundingClientRect !== "function") return [{ text: node.data, box }];
  const out: Glyph[] = [];
  for (let i = 0; i < node.data.length; i++) {
    range.setStart(node, i);
    range.setEnd(node, i + 1);
    const r = range.getBoundingClientRect();
    out.push({ text: node.data[i]!, box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } });
  }
  return out;
}

const overlaps = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

export function textUnder(layer: HTMLElement, boxes: Box[]): string {
  const glyphs: Glyph[] = [];
  for (const span of Array.from(layer.querySelectorAll<HTMLElement>("span"))) {
    const r = span.getBoundingClientRect();
    if (!boxes.some((b) => overlaps({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }, b))) continue;
    glyphs.push(...glyphsOf(span));
  }
  return joinGlyphs(glyphs, boxes);
}
