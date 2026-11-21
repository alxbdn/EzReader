import type { Annotation } from "./models";

/**
 * Whether `ann` can be copied, pasted and duplicated. Highlights follow the page's text and
 * redactions hide what is under them, so they stay where they were made; a text box that replaces
 * the page's own text (it has a cover) belongs to that spot too.
 */
export function copyable(ann: Annotation): boolean {
  if (ann.kind === "highlight" || ann.kind === "redact") return false;
  return !(ann.kind === "text" && ann.cover);
}

/** The text an annotation leaves on the system clipboard: what it says, if it says anything. */
export function clipboardText(ann: Annotation): string {
  return ann.kind === "text" || ann.kind === "note" ? ann.content : "";
}

/**
 * The annotation last copied, kept apart from the document so later edits don't change it.
 *
 * The system clipboard only receives `clipboardText`. A paste takes the annotation when the
 * clipboard still holds that text, so text copied elsewhere since then pastes as nothing here.
 * Each paste on a page lands a little further down and right, so copies don't hide each other.
 */
export class AnnotationClipboard {
  private held: { ann: Annotation; text: string; pastes: Map<number, number> } | null = null;

  /** Keeps a copy of `ann` and returns the text to put on the system clipboard. */
  copy(ann: Annotation): string {
    const text = clipboardText(ann);
    this.held = { ann: structuredClone(ann), text, pastes: new Map() };
    return text;
  }

  /** Whether the system clipboard, holding `text`, still holds the annotation copied last. */
  holds(text: string): boolean {
    return this.held !== null && plain(this.held.text) === plain(text);
  }

  /**
   * A fresh copy of the held annotation for `page`, and how many steps to nudge it: on the page it
   * came from the first paste moves one step, elsewhere it keeps its place, then each paste one more.
   */
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

/** Clipboard text as written, whatever line endings the system gave it back with. */
function plain(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\0+$/, "");
}
