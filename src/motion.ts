/** Replays a panel's short slide-in, so opening it reads as a move and not a jump. */
export function slideIn(el: HTMLElement): void {
  el.classList.remove("opening");
  void el.offsetWidth;
  el.classList.add("opening");
  el.addEventListener("animationend", () => el.classList.remove("opening"), { once: true });
}
