import type { PageSlot } from "./tauri-bridge";

export function moveItems<T>(list: readonly T[], indices: readonly number[], insertAt: number): T[] {
  const moving = new Set(indices.filter((i) => i >= 0 && i < list.length));
  if (moving.size === 0) return [...list];
  const picked = list.filter((_, i) => moving.has(i));
  const rest = list.filter((_, i) => !moving.has(i));
  let at = insertAt;
  for (const i of moving) if (i < insertAt) at--;
  at = Math.max(0, Math.min(rest.length, at));
  return [...rest.slice(0, at), ...picked, ...rest.slice(at)];
}

export interface PagePlan {
  slots: PageSlot[];
  keepPage: number | null;
  select: number[];
}

export function currentSlots(pageCount: number): PageSlot[] {
  return Array.from({ length: pageCount }, (_, i): PageSlot => ({ kind: "original", page: i + 1, rotation: 0 }));
}

export function planDelete(pageCount: number, pages: readonly number[], current: number): PagePlan | null {
  const doomed = new Set(pages);
  if (doomed.size >= pageCount) return null;
  const slots = currentSlots(pageCount).filter((s) => s.kind === "original" && !doomed.has(s.page));
  const before = pages.filter((p) => p < current).length;
  return { slots, keepPage: Math.max(1, Math.min(current - before, slots.length)), select: [] };
}

export function planRotate(pageCount: number, pages: readonly number[], quarterTurns: number): PagePlan {
  const turn = new Set(pages);
  const rotation = (((quarterTurns * 90) % 360) + 360) % 360;
  const slots = currentSlots(pageCount).map((s) => (s.kind === "original" && turn.has(s.page) ? { ...s, rotation } : s));
  return { slots, keepPage: null, select: [...pages] };
}

export function planMove(pageCount: number, pages: readonly number[], insertAt: number, current: number): PagePlan {
  const order = moveItems(
    Array.from({ length: pageCount }, (_, i) => i + 1),
    pages.map((p) => p - 1),
    insertAt,
  );
  const moved = new Set(pages);
  return {
    slots: order.map((page): PageSlot => ({ kind: "original", page, rotation: 0 })),
    keepPage: order.indexOf(current) + 1,
    select: order.flatMap((p, i) => (moved.has(p) ? [i + 1] : [])),
  };
}

export function planInsert(pageCount: number, after: number, inserted: readonly PageSlot[]): PagePlan {
  const slots = currentSlots(pageCount);
  slots.splice(after, 0, ...inserted);
  const first = after + 1;
  return { slots, keepPage: first, select: inserted.map((_, i) => first + i) };
}
