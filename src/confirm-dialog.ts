/**
 * A yes / no question in the app's own style, with **No** chosen by default:
 * Enter or Escape right away answers no, so a stray key never throws work
 * away. Resolves true only when Yes is clicked (or chosen with Tab, then Enter).
 */
export function confirmDialog(opts: { title: string; text: string; yes: string; no: string }): Promise<boolean> {
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
    const yes = document.createElement("button");
    yes.className = "btn";
    yes.textContent = opts.yes;
    const no = document.createElement("button");
    no.className = "btn btn-primary";
    no.textContent = opts.no;
    footer.append(yes, no);
    box.append(header, text, footer);
    backdrop.append(box);

    const previous = document.activeElement as HTMLElement | null;
    const done = (answer: boolean): void => {
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      previous?.focus?.();
      resolve(answer);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); return; }
      if (e.key === "Tab") {
        // Focus stays on the two buttons.
        e.preventDefault();
        (document.activeElement === no ? yes : no).focus();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        done(document.activeElement === yes);
        return;
      }
      e.stopPropagation(); // no app shortcuts while the question is open
    };
    yes.addEventListener("click", () => done(true));
    no.addEventListener("click", () => done(false));
    document.addEventListener("keydown", onKey, true);
    document.body.append(backdrop);
    no.focus();
  });
}
