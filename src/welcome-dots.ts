/**
 * Interactive dot grid behind the welcome screen: dots are pushed away from
 * the cursor, light up and grow near it, spring back when it leaves, and a
 * click sends a ripple through the grid. Respects prefers-reduced-motion
 * (static grid) and stops animating once every dot has settled.
 */

const SPACING   = 22;   // px between dots
const RADIUS    = 170;  // cursor influence radius
const PUSH      = 24;   // max displacement under the cursor
// Heavy, slow dots: a soft spring with strong damping, so they drift into
// place and settle back over about a second instead of snapping.
const SPRING    = 0.02;
const DAMPING   = 0.88;
// Going back to rest is a slow glide with no spring and no bounce: each frame
// covers this fraction of the remaining distance (about 5 s to settle).
const RETURN_EASE = 0.01;
// The point the dots react to trails the real cursor, which gives the field weight.
const FOLLOW    = 0.045;
const PRESENCE_EASE = 0.025; // how fast the influence fades in
const PRESENCE_FADE = 0.008; // and out, once the cursor has left
const GLOW_EASE = 0.04;
const GLOW_FADE = 0.012;
const BASE_SIZE = 1;    // dot radius at rest
const RIPPLE_SPEED = 3.5; // px per frame
const RIPPLE_WIDTH = 90;
const ACCENT = [229, 57, 53]; // logo red

interface Dot { x: number; y: number; dx: number; dy: number; vx: number; vy: number; glow: number }
interface Ripple { x: number; y: number; r: number }

export function mountWelcomeDots(screen: HTMLElement): void {
  const canvas = document.createElement("canvas");
  canvas.className = "welcome-dots";
  canvas.setAttribute("aria-hidden", "true");
  screen.prepend(canvas);
  const ctx = canvas.getContext("2d")!;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let dots: Dot[] = [];
  let width = 0, height = 0, dpr = 1;
  let mouse: { x: number; y: number } | null = null;
  // Lagging copy of the cursor and how strongly it currently acts (0..1).
  let focus: { x: number; y: number } | null = null;
  let presence = 0;
  let ripples: Ripple[] = [];
  let frame = 0;
  let base: number[] = [113, 113, 122];

  function readColors(): void {
    const c = getComputedStyle(document.documentElement).getPropertyValue("--muted-foreground").trim();
    const m = /^#([0-9a-f]{6})$/i.exec(c);
    if (m) {
      const n = parseInt(m[1], 16);
      base = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
  }

  function layout(): void {
    dpr = window.devicePixelRatio || 1;
    width = screen.clientWidth;
    height = Math.max(screen.clientHeight, screen.scrollHeight);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    dots = [];
    const ox = (width % SPACING) / 2, oy = (height % SPACING) / 2;
    for (let y = oy; y < height; y += SPACING) {
      for (let x = ox; x < width; x += SPACING) {
        dots.push({ x, y, dx: 0, dy: 0, vx: 0, vy: 0, glow: 0 });
      }
    }
    readColors();
    draw();
  }

  function step(): boolean {
    let moving = false;
    if (mouse) {
      if (!focus) focus = { ...mouse };
      focus.x += (mouse.x - focus.x) * FOLLOW;
      focus.y += (mouse.y - focus.y) * FOLLOW;
    }
    presence += ((mouse ? 1 : 0) - presence) * (mouse ? PRESENCE_EASE : PRESENCE_FADE);
    if (!mouse && presence < 0.005) { presence = 0; focus = null; }
    if (mouse && (Math.abs(mouse.x - focus!.x) > 0.3 || Math.abs(mouse.y - focus!.y) > 0.3)) moving = true;
    if (presence > 0.005 && presence < 0.995) moving = true;
    for (const r of ripples) r.r += RIPPLE_SPEED;
    ripples = ripples.filter(r => r.r < Math.hypot(width, height));

    for (const d of dots) {
      let tx = 0, ty = 0, glow = 0;
      if (focus && presence > 0) {
        const ex = d.x - focus.x, ey = d.y - focus.y;
        const dist = Math.hypot(ex, ey);
        if (dist < RADIUS && dist > 0.01) {
          // Smooth falloff so the edge of the field moves gently too.
          const t = 1 - dist / RADIUS;
          const f = t * t * (3 - 2 * t) * presence;
          tx = (ex / dist) * PUSH * f;
          ty = (ey / dist) * PUSH * f;
          glow = f;
        }
      }
      for (const r of ripples) {
        const ex = d.x - r.x, ey = d.y - r.y;
        const dist = Math.hypot(ex, ey);
        const band = 1 - Math.abs(dist - r.r) / RIPPLE_WIDTH;
        if (band > 0 && dist > 0.01) {
          const fade = Math.max(0, 1 - r.r / 900);
          tx += (ex / dist) * 12 * band * fade;
          ty += (ey / dist) * 12 * band * fade;
          glow = Math.max(glow, band * fade);
        }
      }
      if (Math.hypot(tx, ty) >= Math.hypot(d.dx, d.dy)) {
        // Pushed outwards: a soft, heavy spring.
        d.vx = (d.vx + (tx - d.dx) * SPRING) * DAMPING;
        d.vy = (d.vy + (ty - d.dy) * SPRING) * DAMPING;
        d.dx += d.vx;
        d.dy += d.vy;
      } else {
        // Coming back: glide slowly towards the target, carrying no momentum.
        d.vx *= 0.9;
        d.vy *= 0.9;
        d.dx += (tx - d.dx) * RETURN_EASE + d.vx * 0.1;
        d.dy += (ty - d.dy) * RETURN_EASE + d.vy * 0.1;
      }
      d.glow += (glow - d.glow) * (glow > d.glow ? GLOW_EASE : GLOW_FADE);
      if (Math.abs(d.vx) > 0.01 || Math.abs(d.vy) > 0.01 || Math.abs(d.dx) > 0.05 || Math.abs(d.dy) > 0.05 || d.glow > 0.01) {
        moving = true;
      }
    }
    return moving || ripples.length > 0;
  }

  function draw(): void {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    for (const d of dots) {
      const g = d.glow;
      const r = base[0] + (ACCENT[0] - base[0]) * g;
      const gr = base[1] + (ACCENT[1] - base[1]) * g;
      const b = base[2] + (ACCENT[2] - base[2]) * g;
      ctx.fillStyle = `rgba(${r | 0},${gr | 0},${b | 0},${0.3 + 0.7 * g})`;
      ctx.beginPath();
      ctx.arc(d.x + d.dx, d.y + d.dy, BASE_SIZE + 1.6 * g, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function tick(): void {
    const moving = step();
    draw();
    frame = moving ? requestAnimationFrame(tick) : 0;
  }

  function wake(): void {
    if (reduceMotion.matches || screen.classList.contains("hidden")) return;
    if (!frame) frame = requestAnimationFrame(tick);
  }

  screen.addEventListener("pointermove", (e) => {
    const rect = screen.getBoundingClientRect();
    mouse = { x: e.clientX - rect.left + screen.scrollLeft, y: e.clientY - rect.top + screen.scrollTop };
    wake();
  });
  screen.addEventListener("pointerleave", () => { mouse = null; wake(); });
  screen.addEventListener("pointerdown", (e) => {
    const rect = screen.getBoundingClientRect();
    ripples.push({ x: e.clientX - rect.left + screen.scrollLeft, y: e.clientY - rect.top + screen.scrollTop, r: 0 });
    wake();
  });

  new ResizeObserver(() => { if (!screen.classList.contains("hidden")) layout(); }).observe(screen);
  // Theme changes (Settings or system) recolour the dots.
  new MutationObserver(() => { readColors(); draw(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { readColors(); draw(); });

  layout();
}
