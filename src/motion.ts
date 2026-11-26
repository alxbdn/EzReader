export function slideIn(el: HTMLElement): void {
  el.classList.remove("opening");
  void el.offsetWidth;
  el.classList.add("opening");
  el.addEventListener("animationend", () => el.classList.remove("opening"), { once: true });
}
