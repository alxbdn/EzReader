/** One button of a question: what it says and the answer it gives. */
export interface Choice<T> {
  label: string;
  value: T;
  /** Drawn as the main button. */
  primary?: boolean;
}

/**
 * A question in the app's own style. The button at `focus` starts focused,
 * so Enter right away gives its answer; Escape gives `cancel`. Tab moves
 * between the buttons only.
 */
export function choiceDialog<T>(opts: { title: string; text: string; choices: Choice<T>[]; focus: number; cancel: T }): Promise<T> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop confirm-dialog";
    backdrop.setAttribute("role", "alertdialog");
    backdrop.setAttribute("aria-modal", "true");

    const box = document.createElement("div");
    box.className = "modal-box confirm-box";
    const header = document.createElement("div");
    header.className = "modal-header";
    const title = document.createElement("span");
    title.textContent = opts.title;
    header.append(title);
    const text = document.createElement("p");
    text.className = "confirm-text";
    text.textContent = opts.text;
    const footer = document.createElement("div");
    footer.className = "modal-footer";
    const buttons = opts.choices.map((c) => {
      const b = document.createElement("button");
      b.className = c.primary ? "btn btn-primary" : "btn";
      b.textContent = c.label;
      b.addEventListener("click", () => done(c.value));
      return b;
    });
    footer.append(...buttons);
    box.append(header, text, footer);
    backdrop.append(box);

    const previous = document.activeElement as HTMLElement | null;
    const done = (answer: T): void => {
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      previous?.focus?.();
      resolve(answer);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(opts.cancel); return; }
      if (e.key === "Tab") {
        // Focus stays on the buttons.
        e.preventDefault();
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const n = buttons.length;
        buttons[((i < 0 ? opts.focus : i + (e.shiftKey ? -1 : 1)) + n) % n].focus();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        done(opts.choices[i < 0 ? opts.focus : i].value);
        return;
      }
      e.stopPropagation(); // no app shortcuts while the question is open
    };
    document.addEventListener("keydown", onKey, true);
    document.body.append(backdrop);
    buttons[opts.focus].focus();
  });
}

/**
 * A yes / no question with **No** chosen by default: Enter or Escape right
 * away answers no, so a stray key never throws work away. Resolves true only
 * when Yes is clicked (or chosen with Tab, then Enter).
 */
export function confirmDialog(opts: { title: string; text: string; yes: string; no: string }): Promise<boolean> {
  return choiceDialog({
    title: opts.title,
    text: opts.text,
    choices: [{ label: opts.yes, value: true }, { label: opts.no, value: false, primary: true }],
    focus: 1,
    cancel: false,
  });
}

export type SaveAnswer = "save" | "discard" | "cancel";

/**
 * "Save the changes before …?" Yes / No / Cancel. Yes is chosen by default
 * (Enter saves), Escape cancels: no key on its own throws the changes away.
 */
export function saveChangesDialog(opts: { title: string; text: string; yes: string; no: string; cancel: string }): Promise<SaveAnswer> {
  return choiceDialog<SaveAnswer>({
    title: opts.title,
    text: opts.text,
    choices: [
      { label: opts.yes, value: "save", primary: true },
      { label: opts.no, value: "discard" },
      { label: opts.cancel, value: "cancel" },
    ],
    focus: 0,
    cancel: "cancel",
  });
}
