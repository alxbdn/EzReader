export function mountWelcomeFit(screen: HTMLElement): void {
  const inner = screen.querySelector<HTMLElement>(".welcome-inner");
  if (!inner) return;

  function fit(): void {
    if (screen.classList.contains("hidden")) return;
    const style = getComputedStyle(screen);
    const room = screen.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    inner!.style.zoom = "";
    const needed = inner!.offsetHeight;
    const next = needed > room && room > 0 ? Math.floor((room / needed) * 1000) / 1000 : 1;
    if (next !== 1) inner!.style.zoom = String(next);
  }

  const observer = new ResizeObserver(fit);
  observer.observe(screen);
  observer.observe(inner);
}
