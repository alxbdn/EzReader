import type { PageSlot } from "./tauri-bridge";

/**
 * Moves the items at `indices` (any order, no duplicates) so that they sit,
 * in their current relative order, where the gap `insertAt` was before the
 * move. `insertAt` is a gap index: 0 is before the first item, `list.length`
 * after the last. Returns a new array.
 */
export function moveItems<T>(list: readonly T[], indices: readonly number[], insertAt: number): T[] {
  const moving = new Set(indices.filter((i) => i >= 0 && i < list.length));
  if (moving.size === 0) return [...list];
  const picked = list.filter((_, i) => moving.has(i));
  const rest = list.filter((_, i) => !moving.has(i));
  // Gaps before `insertAt` that belonged to moved items disappear.
  let at = insertAt;
  for (const i of moving) if (i < insertAt) at--;
  at = Math.max(0, Math.min(rest.length, at));
  return [...rest.slice(0, at), ...picked, ...rest.slice(at)];
}

/** True when `slots` describe the document's `pageCount` pages unchanged. */
export function isUnchangedLayout(slots: readonly PageSlot[], pageCount: number): boolean {
  return (
    slots.length === pageCount &&
    slots.every((s, i) => s.kind === "original" && s.page === i + 1 && s.rotation % 360 === 0)
  );
}
