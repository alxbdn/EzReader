import type { Annotation } from "./models";

export function copyable(ann: Annotation): boolean {
  if (ann.kind === "highlight" || ann.kind === "redact") return false;
  return !(ann.kind === "text" && ann.cover);
}

export function clipboardText(ann: Annotation): string {
  return ann.kind === "text" || ann.kind === "note" ? ann.content : "";
}

export class AnnotationClipboard {
  private held: { ann: Annotation; text: string; pastes: Map<number, number> } | null = null;

  copy(ann: Annotation): string {
    const text = clipboardText(ann);
    this.held = { ann: structuredClone(ann), text, pastes: new Map() };
    return text;
  }

  holds(text: string): boolean {
    return this.held !== null && plain(this.held.text) === plain(text);
  }

  next(page: number): { ann: Annotation; steps: number } | null {
    const h = this.held;
    if (!h) return null;
    const done = h.pastes.get(page) ?? 0;
    h.pastes.set(page, done + 1);
    const ann = structuredClone(h.ann);
    const steps = done + (h.ann.page === page ? 1 : 0);
    ann.page = page;
    return { ann, steps };
  }
}

function plain(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\0+$/, "");
}
