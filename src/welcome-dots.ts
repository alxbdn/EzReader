const SPACING   = 22;
const RADIUS    = 170;
const PUSH      = 14;
const SPRING    = 0.03;
const DAMPING   = 0.86;
const RETURN_EASE = 0.01;
const FOLLOW    = 0.08;
const PRESENCE_EASE = 0.025;
const PRESENCE_FADE = 0.008;
const GLOW_EASE = 0.04;
const GLOW_FADE = 0.012;
const BASE_SIZE = 1;
const RIPPLE_SPEED = 3.5;
const RIPPLE_WIDTH = 90;
const RIPPLE_REACH = 900;
const ACCENT = [229, 57, 53];
const GLOW_LEVELS = 12;
const FRAME_MS = 1000 / 60;
const MAX_STEPS = 4;

interface Dot { x: number; y: number; dx: number; dy: number; vx: number; vy: number; glow: number }
interface Ripple { x: number; y: number; r: number }

export function mountWelcomeDots(screen: HTMLElement): void {
  const canvas = document.createElement("canvas");
  canvas.className = "welcome-dots";
  canvas.setAttribute("aria-hidden", "true");
  screen.prepend(canvas);
  const ctx = canvas.getContext("2d")!;
  let dirty: [number, number, number, number] | null = null;
  let cols = 0, rows = 0, ox = 0, oy = 0;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let dots: Dot[] = [];
  let width = 0, height = 0, dpr = 1;
  let mouse: { x: number; y: number } | null = null;
  let focus: { x: number; y: number } | null = null;
  let presence = 0;
  let ripples: Ripple[] = [];
  let frame = 0;
  let last = 0;
  let base: number[] = [113, 113, 122];

  function readColors(): void {
    const css = getComputedStyle(document.documentElement);
    const c = css.getPropertyValue("--muted-foreground").trim();
    const m = /^#([0-9a-f]{6})$/i.exec(c);
    if (m) {
      const n = parseInt(m[1], 16);
      base = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    styles = [];
  }

  function layout(): void {
    dpr = window.devicePixelRatio || 1;
    canvas.style.width = "0px";
    canvas.style.height = "0px";
    width = screen.clientWidth;
    height = Math.max(screen.clientHeight, screen.scrollHeight);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    dirty = null;
    dots = [];
    ox = (width % SPACING) / 2;
    oy = (height % SPACING) / 2;
    cols = Math.ceil((width - ox) / SPACING);
    rows = Math.ceil((height - oy) / SPACING);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        dots.push({ x: ox + c * SPACING, y: oy + r * SPACING, dx: 0, dy: 0, vx: 0, vy: 0, glow: 0 });
      }
    }
    readColors();
    redraw();
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
    ripples = ripples.filter(r => r.r < RIPPLE_REACH);
    const field = focus && presence > 0 ? focus : null;
    const R2 = RADIUS * RADIUS;

    for (const d of dots) {
      if (d.glow === 0 && d.dx === 0 && d.dy === 0 && d.vx === 0 && d.vy === 0) {
        let near = false;
        if (field) {
          const ex = d.x - field.x, ey = d.y - field.y;
          near = ex * ex + ey * ey < R2;
        }
        for (let i = 0; !near && i < ripples.length; i++) {
          const r = ripples[i];
          const ex = d.x - r.x, ey = d.y - r.y;
          const d2 = ex * ex + ey * ey;
          const inner = Math.max(0, r.r - RIPPLE_WIDTH), outer = r.r + RIPPLE_WIDTH;
          near = d2 > inner * inner && d2 < outer * outer;
        }
        if (!near) continue;
      }
      let tx = 0, ty = 0, glow = 0, inField = false;
      if (focus && presence > 0) {
        const ex = d.x - focus.x, ey = d.y - focus.y;
        const dist = Math.hypot(ex, ey);
        if (dist < RADIUS && dist > 0.01) {
          inField = presence > 0.05;
          const u = dist / RADIUS;
          const push = (u * (1 - u) * (1 - u)) / (4 / 27) * presence;
          tx = (ex / dist) * PUSH * push;
          ty = (ey / dist) * PUSH * push;
          const t = 1 - u;
          glow = t * t * (3 - 2 * t) * presence;
        }
      }
      for (const r of ripples) {
        const ex = d.x - r.x, ey = d.y - r.y;
        const dist = Math.hypot(ex, ey);
        const band = 1 - Math.abs(dist - r.r) / RIPPLE_WIDTH;
        if (band > 0 && dist > 0.01) {
          const fade = Math.max(0, 1 - r.r / RIPPLE_REACH);
          tx += (ex / dist) * 12 * band * fade;
          ty += (ey / dist) * 12 * band * fade;
          glow = Math.max(glow, band * fade);
        }
      }
      if (inField || Math.hypot(tx, ty) >= Math.hypot(d.dx, d.dy)) {
        d.vx = (d.vx + (tx - d.dx) * SPRING) * DAMPING;
        d.vy = (d.vy + (ty - d.dy) * SPRING) * DAMPING;
        d.dx += d.vx;
        d.dy += d.vy;
      } else {
        d.vx *= 0.9;
        d.vy *= 0.9;
        d.dx += (tx - d.dx) * RETURN_EASE + d.vx * 0.1;
        d.dy += (ty - d.dy) * RETURN_EASE + d.vy * 0.1;
      }
      d.glow += (glow - d.glow) * (glow > d.glow ? GLOW_EASE : GLOW_FADE);
      if (Math.abs(d.vx) > 0.01 || Math.abs(d.vy) > 0.01 || Math.abs(d.dx) > 0.05 || Math.abs(d.dy) > 0.05 || Math.abs(glow - d.glow) > 0.01) {
        moving = true;
      } else if (glow === 0 && tx === 0 && ty === 0) {
        d.dx = d.dy = d.vx = d.vy = d.glow = 0;
      }
    }
    return moving || ripples.length > 0;
  }

  let styles: string[] = [];
  function buildStyles(): void {
    styles = [];
    for (let i = 0; i <= GLOW_LEVELS; i++) {
      const g = i / GLOW_LEVELS;
      const c = base.map((v, k) => (v + (ACCENT[k] - v) * g) | 0);
      styles.push(`rgba(${c[0]},${c[1]},${c[2]},${0.3 + 0.7 * g})`);
    }
  }
  const buckets: Dot[][] = Array.from({ length: GLOW_LEVELS + 1 }, () => []);

  const atRest = (d: Dot) => d.glow === 0 && d.dx === 0 && d.dy === 0;

  function circles(list: Dot[], size: number): void {
    for (const d of list) {
      const x = d.x + d.dx, y = d.y + d.dy;
      ctx.moveTo(x + size, y);
      ctx.arc(x, y, size, 0, Math.PI * 2);
    }
  }

  function fillBuckets(): void {
    for (let i = 0; i <= GLOW_LEVELS; i++) {
      if (buckets[i].length === 0) continue;
      ctx.fillStyle = styles[i];
      ctx.beginPath();
      circles(buckets[i], BASE_SIZE + 1.6 * (i / GLOW_LEVELS));
      ctx.fill();
    }
  }

  function redraw(): void {
    if (styles.length === 0) buildStyles();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    for (const b of buckets) b.length = 0;
    for (const d of dots) buckets[Math.round(d.glow * GLOW_LEVELS)].push(d);
    fillBuckets();
    dirty = activeBox();
  }

  type Box = [number, number, number, number];
  function activeBox(): Box | null {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const d of dots) {
      if (atRest(d)) continue;
      const ax = d.x + d.dx, ay = d.y + d.dy;
      x0 = Math.min(x0, d.x, ax); y0 = Math.min(y0, d.y, ay);
      x1 = Math.max(x1, d.x, ax); y1 = Math.max(y1, d.y, ay);
    }
    if (x0 === Infinity) return null;
    const pad = BASE_SIZE + 1.6 + 2;
    return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
  }

  function draw(): void {
    if (styles.length === 0) buildStyles();
    const now = activeBox();
    const area: Box | null = dirty && now
      ? [Math.min(dirty[0], now[0]), Math.min(dirty[1], now[1]), Math.max(dirty[2], now[2]), Math.max(dirty[3], now[3])]
      : dirty ?? now;
    dirty = now;
    if (!area) return;
    const [x0, y0, x1, y1] = area;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
    for (const b of buckets) b.length = 0;
    const c0 = Math.max(0, Math.floor((x0 - ox) / SPACING)), c1 = Math.min(cols - 1, Math.ceil((x1 - ox) / SPACING));
    const r0 = Math.max(0, Math.floor((y0 - oy) / SPACING)), r1 = Math.min(rows - 1, Math.ceil((y1 - oy) / SPACING));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const d = dots[r * cols + c];
        if (atRest(d)) buckets[0].push(d);
      }
    }
    for (const d of dots) if (!atRest(d)) buckets[Math.round(d.glow * GLOW_LEVELS)].push(d);
    fillBuckets();
    ctx.restore();
  }

  function tick(now: number): void {
    const steps = last ? Math.min(MAX_STEPS, Math.max(1, Math.round((now - last) / FRAME_MS))) : 1;
    last = now;
    let moving = false;
    for (let i = 0; i < steps; i++) moving = step() || moving;
    draw();
    if (moving) frame = requestAnimationFrame(tick);
    else { frame = 0; last = 0; }
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
  new MutationObserver(() => { readColors(); redraw(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { readColors(); redraw(); });
  // No layout() here: the observer's first call lays the dots out with the page's own layout,
  // where calling it now would force one more layout while the app is still being built.
}
