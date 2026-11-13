import type { PDFDocumentProxy } from "pdfjs-dist";
import type { Translations } from "./i18n";
import { contentBounds, type Point } from "./warp";
import { ICON_CHECK, ICON_CROP, ICON_DISCARD, ICON_FLIP_H, ICON_FLIP_V, ICON_STRAIGHTEN } from "./icons";

export type AdjustKind = "crop" | "straighten";

/** Fractions of the page as shown (0 = left / top, 1 = right / bottom). */
export interface CropRect { l: number; t: number; r: number; b: number }
export type Quad = [Point, Point, Point, Point];

/** How one page is set in the adjust view; coordinates are fractions of the page as shown. */
export interface PageSetting {
  page: number;
  mode: AdjustKind;
  /** Crop: the area kept, on the page as shown after the flips. */
  crop: CropRect;
  /** Mirror left to right / top to bottom, as seen on screen. */
  flipH: boolean;
  flipV: boolean;
  /** Straighten: the page's corners (top left, top right, bottom right, bottom left). */
  quad: Quad;
}

type Key = keyof Translations;
type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "move";

const FULL: CropRect = { l: 0, t: 0, r: 1, b: 1 };
const CORNERS: Quad = [[0, 0], [1, 0], [1, 1], [0, 1]];
const MIN_SIZE = 0.04;
const LOUPE = 132;
const ZOOM = 4;
/** Biggest bitmap rendered for a page (the loupe reads it ×4). */
const MAX_PIXELS = 12e6;

/** True when `s` changes its page. */
export function changesPage(s: PageSetting): boolean {
  if (s.mode === "crop") {
    return s.flipH || s.flipV || s.crop.l > 1e-4 || s.crop.t > 1e-4 || s.crop.r < 1 - 1e-4 || s.crop.b < 1 - 1e-4;
  }
  return s.quad.some(([x, y], i) => Math.abs(x - CORNERS[i][0]) > 1e-4 || Math.abs(y - CORNERS[i][1]) > 1e-4);
}

/** A box seen through a flip: the same area once the page is mirrored. */
export function mirrorRect(c: CropRect, flipH: boolean, flipV: boolean): CropRect {
  return {
    l: flipH ? 1 - c.r : c.l, r: flipH ? 1 - c.l : c.r,
    t: flipV ? 1 - c.b : c.t, b: flipV ? 1 - c.t : c.b,
  };
}

interface Rendered {
  canvas: HTMLCanvasElement;
  /** Page size as shown, in points. */
  widthPt: number;
  heightPt: number;
}

/**
 * Crop / Straighten, page by page: replaces the viewer until ✓ or ✕.
 * Each selected page gets its own setting; ✓ hands them all to `onApply`.
 */
export class AdjustView {
  readonly el: HTMLElement;
  private header: HTMLElement;
  private titleEl: HTMLElement;
  private modeBtns = new Map<AdjustKind, HTMLButtonElement>();
  private cropTools: HTMLElement;
  private flipVBtn: HTMLButtonElement;
  private flipHBtn: HTMLButtonElement;
  private autoBtn: HTMLButtonElement;
  private warpHint: HTMLElement;
  private validate: HTMLElement;
  private list: HTMLElement;
  private listNote: HTMLElement;
  private stage: HTMLElement;

  private doc: PDFDocumentProxy | null = null;
  private rotation = 0;
  private settings: PageSetting[] = [];
  private index = 0;
  private corner = -1;
  private busy = false;
  private renders = new Map<number, Promise<Rendered>>();
  private thumbs = new Map<number, HTMLElement>();
  /** Bumped by every page shown: a slow render does not replace a newer one. */
  private token = 0;
  /** Bumped by every open / close: thumbnails of a closed view are dropped. */
  private opened = 0;
  private t: Translations = {} as Translations;
  private texts: [HTMLElement, Key, string][] = [];
  private titles: [HTMLElement, Key, string][] = [];
  private onKey = (e: KeyboardEvent) => this.handleKey(e);
  private onResize = () => { if (this.doc) void this.showPage(); };

  // The stage of the page shown
  private frame: HTMLElement | null = null;
  private page: Rendered | null = null;
  private cropEls: { dim: HTMLElement; box: HTMLElement; caption: HTMLElement } | null = null;
  private warpEls: { svg: SVGSVGElement; dim: SVGPathElement; poly: SVGPathElement; link: SVGPathElement; corners: HTMLButtonElement[]; loupe: HTMLCanvasElement; label: HTMLElement } | null = null;

  constructor(
    host: HTMLElement,
    private onApply: (settings: PageSetting[]) => Promise<boolean>,
    private onClose: () => void,
  ) {
    this.el = document.createElement("div");
    this.el.id = "adjust-view";
    this.el.hidden = true;

    this.header = document.createElement("div");
    this.header.className = "adj-header";
    this.titleEl = document.createElement("span");
    this.titleEl.className = "adj-title";

    const seg = document.createElement("div");
    seg.className = "toolbar-segment adj-seg";
    for (const [kind, icon, key, fb] of [
      ["crop", ICON_CROP, "toolCrop", "Crop"], ["straighten", ICON_STRAIGHTEN, "toolStraighten", "Straighten"],
    ] as [AdjustKind, string, Key, string][]) {
      const b = this.button("tool-btn", icon, key, fb);
      b.addEventListener("click", () => this.setMode(kind));
      this.modeBtns.set(kind, b);
      seg.append(b);
    }

    this.cropTools = document.createElement("div");
    this.cropTools.className = "adj-tools";
    const div = document.createElement("span");
    div.className = "opt-divider";
    this.flipVBtn = this.button("btn adj-btn", ICON_FLIP_V, "adjFlipV", "Flip vertical", "ttFlipV", "Flip the page upside down");
    this.flipVBtn.addEventListener("click", () => this.flip("v"));
    this.flipHBtn = this.button("btn adj-btn", ICON_FLIP_H, "adjFlipH", "Flip horizontal", "ttFlipH", "Mirror the page left to right");
    this.flipHBtn.addEventListener("click", () => this.flip("h"));
    this.autoBtn = this.button("btn adj-btn", "", "adjAuto", "Auto margins", "ttAuto", "Snap the crop to the content margins");
    this.autoBtn.addEventListener("click", () => void this.autoMargins());
    this.cropTools.append(div, this.flipVBtn, this.flipHBtn, this.autoBtn);

    this.warpHint = document.createElement("span");
    this.warpHint.className = "adj-hint";
    this.text(this.warpHint, "adjWarpHint", "Click a corner: an offset loupe opens so you can place it to the pixel. Arrow keys nudge it.");

    const right = document.createElement("div");
    right.className = "adj-right";
    const vh = document.createElement("span");
    vh.className = "adj-hint";
    this.text(vh, "adjValidateHint", "Validate or discard");
    this.validate = document.createElement("div");
    this.validate.className = "tb-validate on";
    const ok = this.button("validate-btn", ICON_CHECK, null, "", "ttValidate", "Validate (Enter)");
    ok.addEventListener("click", () => void this.apply());
    const no = this.button("discard-btn", ICON_DISCARD, null, "", "ttDiscard", "Discard (Esc)");
    no.addEventListener("click", () => this.close());
    this.validate.append(ok, no);
    this.validate.addEventListener("animationend", () => this.validate.classList.remove("shake"));
    right.append(vh, this.validate);

    this.header.append(this.titleEl, seg, this.cropTools, this.warpHint, right);

    const body = document.createElement("div");
    body.className = "adj-body";
    this.list = document.createElement("div");
    this.list.className = "adj-list";
    this.listNote = document.createElement("span");
    this.listNote.className = "adj-list-note";
    this.text(this.listNote, "adjEach", "Each page is set on its own");
    this.stage = document.createElement("div");
    this.stage.className = "adj-stage";
    this.stage.addEventListener("pointerdown", (e) => {
      if (e.target === this.stage && this.corner >= 0) { this.corner = -1; this.syncWarp(); }
    });
    body.append(this.list, this.stage);
    this.el.append(this.header, body);
    host.append(this.el);
  }

  get isOpen(): boolean { return this.doc !== null; }

  /** Opens on `pages` of `doc` (as shown: `rotation` is the view rotation). */
  open(doc: PDFDocumentProxy, pages: number[], kind: AdjustKind, rotation: number): void {
    this.doc = doc;
    this.opened++;
    this.rotation = rotation;
    this.settings = pages.map((page) => ({ page, mode: kind, crop: { ...FULL }, flipH: false, flipV: false, quad: CORNERS.map((p) => [...p]) as Quad }));
    this.index = 0;
    this.corner = -1;
    this.busy = false;
    this.renders.clear();
    this.el.hidden = false;
    this.el.classList.remove("busy");
    this.buildList();
    this.syncHeader();
    void this.showPage();
    window.addEventListener("keydown", this.onKey, true);
    window.addEventListener("resize", this.onResize);
  }

  close(): void {
    if (!this.doc || this.busy) return;
    this.doc = null;
    this.token++;
    this.opened++;
    this.el.hidden = true;
    this.stage.replaceChildren();
    this.list.replaceChildren();
    this.thumbs.clear();
    for (const r of this.renders.values()) void r.then((x) => { x.canvas.width = x.canvas.height = 0; }, () => {});
    this.renders.clear();
    this.frame = this.page = this.cropEls = this.warpEls = null;
    window.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("resize", this.onResize);
    this.onClose();
  }

  /** Shakes ✓ / ✕: validate or discard before doing anything else. */
  shake(): void {
    this.validate.classList.remove("shake");
    void this.validate.offsetWidth;
    this.validate.classList.add("shake");
  }

  applyTranslations(t: Translations): void {
    this.t = t;
    for (const [el, key, fb] of this.texts) el.textContent = this.tr(key, fb);
    for (const [el, key, fb] of this.titles) { el.title = this.tr(key, fb); el.setAttribute("aria-label", el.title); }
    if (this.doc) { this.syncHeader(); this.syncLabels(); this.syncCrop(); this.syncWarp(); }
  }

  // ── Settings ────────────────────────────────────────────────────────────────

  private get current(): PageSetting { return this.settings[this.index]; }

  private setMode(kind: AdjustKind): void {
    if (this.current.mode === kind) return;
    this.current.mode = kind;
    this.corner = -1;
    this.syncHeader();
    this.syncLabels();
    void this.showPage();
  }

  private flip(axis: "h" | "v"): void {
    const s = this.current;
    if (axis === "h") s.flipH = !s.flipH; else s.flipV = !s.flipV;
    this.syncHeader();
    this.syncCrop();
  }

  /** Snaps the crop to what is drawn on the page. */
  private async autoMargins(): Promise<void> {
    const s = this.current;
    const r = await this.render(s.page);
    if (s !== this.current) return;
    const { canvas } = r;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    // Read a smaller copy: the bounds need no more than ~1 px per point.
    const k = Math.min(1, 1000 / Math.max(canvas.width, canvas.height));
    const w = Math.max(1, Math.round(canvas.width * k)), h = Math.max(1, Math.round(canvas.height * k));
    let data: ImageData;
    if (k < 1) {
      const small = document.createElement("canvas");
      small.width = w; small.height = h;
      const sc = small.getContext("2d", { willReadFrequently: true })!;
      sc.drawImage(canvas, 0, 0, w, h);
      data = sc.getImageData(0, 0, w, h);
      small.width = small.height = 0;
    } else {
      data = ctx.getImageData(0, 0, w, h);
    }
    const box = contentBounds(data);
    if (!box) return;
    s.crop = mirrorRect(box, s.flipH, s.flipV);
    this.syncCrop();
    this.syncLabels();
  }

  private async apply(): Promise<void> {
    if (this.busy || !this.doc) return;
    this.busy = true;
    this.el.classList.add("busy");
    let ok = false;
    try {
      ok = await this.onApply(this.settings.filter(changesPage));
    } finally {
      this.busy = false;
      this.el.classList.remove("busy");
    }
    if (ok) this.close();
  }

  // ── Keyboard ────────────────────────────────────────────────────────────────

  private handleKey(e: KeyboardEvent): void {
    const a = document.activeElement as HTMLElement | null;
    if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable)) return;
    const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (e.key === "Enter") { stop(); void this.apply(); return; }
    if (e.key === "Escape") {
      stop();
      if (this.corner >= 0) { this.corner = -1; this.syncWarp(); } else this.close();
      return;
    }
    if (this.corner >= 0 && e.key.startsWith("Arrow")) {
      stop();
      // A quarter of a screen pixel: one pixel in the ×4 loupe.
      const step = (e.shiftKey ? 2.5 : 0.25);
      const fr = this.frame?.getBoundingClientRect();
      if (!fr) return;
      const q = this.current.quad[this.corner];
      if (e.key === "ArrowLeft") q[0] -= step / fr.width;
      if (e.key === "ArrowRight") q[0] += step / fr.width;
      if (e.key === "ArrowUp") q[1] -= step / fr.height;
      if (e.key === "ArrowDown") q[1] += step / fr.height;
      q[0] = clamp01(q[0]); q[1] = clamp01(q[1]);
      this.syncWarp();
      this.syncLabels();
      return;
    }
    // Shortcuts of the viewer (save, undo, print…) wait for ✓ or ✕.
    if (e.ctrlKey || e.metaKey) { stop(); this.shake(); }
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  /** The page as shown, rendered big enough for the ×4 loupe. */
  private render(pageNum: number): Promise<Rendered> {
    let r = this.renders.get(pageNum);
    if (!r) {
      const doc = this.doc!;
      r = (async () => {
        const page = await doc.getPage(pageNum);
        const rotation = (page.rotate + this.rotation) % 360;
        const unit = page.getViewport({ scale: 1, rotation });
        const fit = this.fitSize(unit.width, unit.height);
        const scale = Math.min(ZOOM * fit.w / unit.width * Math.min(window.devicePixelRatio || 1, 2), Math.sqrt(MAX_PIXELS / (unit.width * unit.height)));
        const viewport = page.getViewport({ scale, rotation });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        page.cleanup();
        return { canvas, widthPt: unit.width, heightPt: unit.height };
      })();
      this.renders.set(pageNum, r);
    }
    return r;
  }

  /** Display size of a page in the stage. */
  private fitSize(wPt: number, hPt: number): { w: number; h: number } {
    const crop = this.current?.mode !== "straighten";
    const availW = Math.max(120, this.stage.clientWidth - (crop ? 96 : 120));
    const availH = Math.max(120, this.stage.clientHeight - (crop ? 110 : 120));
    const k = Math.min(availW / wPt, availH / hPt);
    return { w: Math.round(wPt * k), h: Math.round(hPt * k) };
  }

  private buildList(): void {
    this.list.replaceChildren(this.listNote);
    this.thumbs.clear();
    const doc = this.doc!;
    this.settings.forEach((s, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "adj-thumb";
      const pic = document.createElement("span");
      pic.className = "adj-thumb-pic";
      const label = document.createElement("span");
      label.className = "adj-thumb-label";
      b.append(pic, label);
      b.addEventListener("click", () => {
        if (i === this.index) return;
        this.index = i;
        this.corner = -1;
        this.syncHeader();
        this.syncLabels();
        void this.showPage();
      });
      this.list.append(b);
      this.thumbs.set(i, b);
      const opened = this.opened;
      void (async () => {
        const page = await doc.getPage(s.page);
        if (opened !== this.opened) return;
        const rotation = (page.rotate + this.rotation) % 360;
        const unit = page.getViewport({ scale: 1, rotation });
        const scale = Math.min(156 / unit.width, 200 / unit.height);
        const viewport = page.getViewport({ scale, rotation });
        const c = document.createElement("canvas");
        c.width = Math.ceil(viewport.width);
        c.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: c.getContext("2d")!, viewport }).promise;
        if (opened !== this.opened) return;
        pic.style.aspectRatio = `${c.width} / ${c.height}`;
        pic.append(c);
      })().catch(() => {});
    });
    this.syncLabels();
  }

  private syncLabels(): void {
    this.settings.forEach((s, i) => {
      const b = this.thumbs.get(i);
      if (!b) return;
      b.classList.toggle("active", i === this.index);
      b.classList.toggle("changed", changesPage(s));
      const label = b.querySelector(".adj-thumb-label")!;
      label.textContent = s.mode === "straighten"
        ? this.tr("adjPageStraighten", "p. {n} · Straighten").replace("{n}", String(s.page))
        : this.tr("adjPageCrop", "p. {n} · Crop").replace("{n}", String(s.page));
    });
  }

  private syncHeader(): void {
    const n = this.settings.length;
    this.titleEl.textContent = n === 1 ? this.tr("adjTitleOne", "Adjust 1 page") : this.tr("adjTitleMany", "Adjust {n} pages").replace("{n}", String(n));
    const s = this.current;
    if (!s) return;
    for (const [k, b] of this.modeBtns) {
      b.classList.toggle("active", k === s.mode);
      b.setAttribute("aria-pressed", String(k === s.mode));
    }
    this.cropTools.hidden = s.mode !== "crop";
    this.warpHint.hidden = s.mode !== "straighten";
    this.flipVBtn.classList.toggle("active", s.flipV);
    this.flipHBtn.classList.toggle("active", s.flipH);
    this.flipVBtn.setAttribute("aria-pressed", String(s.flipV));
    this.flipHBtn.setAttribute("aria-pressed", String(s.flipH));
  }

  /** Builds the stage for the page shown. */
  private async showPage(): Promise<void> {
    const token = ++this.token;
    const s = this.current;
    const r = await this.render(s.page);
    if (token !== this.token || !this.doc) return;
    this.page = r;
    const { w, h } = this.fitSize(r.widthPt, r.heightPt);
    const frame = document.createElement("div");
    frame.className = `adj-frame adj-${s.mode}`;
    frame.style.width = `${w}px`;
    frame.style.height = `${h}px`;
    this.frame = frame;
    this.cropEls = this.warpEls = null;
    if (s.mode === "crop") this.buildCrop(frame, r);
    else this.buildWarp(frame, r);
    this.stage.replaceChildren(frame);
    this.syncCrop();
    this.syncWarp();
  }

  private pageCanvas(r: Rendered): HTMLCanvasElement {
    // The stage shows a copy: the full-size render stays the loupe's source.
    const c = document.createElement("canvas");
    const k = Math.min(1, 2400 / Math.max(r.canvas.width, r.canvas.height));
    c.width = Math.round(r.canvas.width * k);
    c.height = Math.round(r.canvas.height * k);
    c.getContext("2d")!.drawImage(r.canvas, 0, 0, c.width, c.height);
    c.className = "adj-page";
    return c;
  }

  // ── Crop ────────────────────────────────────────────────────────────────────

  private buildCrop(frame: HTMLElement, r: Rendered): void {
    const clip = document.createElement("div");
    clip.className = "adj-clip";
    const canvas = this.pageCanvas(r);
    const dim = document.createElement("div");
    dim.className = "adj-dim";
    clip.append(canvas, dim);

    const box = document.createElement("div");
    box.className = "adj-cropbox";
    for (const cls of ["v1", "v2", "h1", "h2"]) {
      const l = document.createElement("span");
      l.className = `adj-third ${cls}`;
      box.append(l);
    }
    for (const hd of ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as Handle[]) {
      const el = document.createElement("span");
      el.className = `adj-handle ${hd}`;
      el.dataset["h"] = hd;
      box.append(el);
    }
    box.addEventListener("pointerdown", (e) => {
      const hd = ((e.target as HTMLElement).dataset["h"] ?? "move") as Handle;
      this.dragCrop(e, hd);
    });
    const caption = document.createElement("span");
    caption.className = "adj-caption";
    frame.append(clip, box, caption);
    this.cropEls = { dim, box, caption };
  }

  private dragCrop(e: PointerEvent, hd: Handle): void {
    if (e.button !== 0 || !this.frame) return;
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const fr = this.frame.getBoundingClientRect();
    const start = { ...this.current.crop };
    const x0 = e.clientX, y0 = e.clientY;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / fr.width, dy = (ev.clientY - y0) / fr.height;
      const c = { ...start };
      if (hd === "move") {
        const w = start.r - start.l, h = start.b - start.t;
        c.l = Math.min(1 - w, Math.max(0, start.l + dx)); c.r = c.l + w;
        c.t = Math.min(1 - h, Math.max(0, start.t + dy)); c.b = c.t + h;
      } else {
        if (hd.includes("w")) c.l = Math.min(start.r - MIN_SIZE, Math.max(0, start.l + dx));
        if (hd.includes("e")) c.r = Math.max(start.l + MIN_SIZE, Math.min(1, start.r + dx));
        if (hd.includes("n")) c.t = Math.min(start.b - MIN_SIZE, Math.max(0, start.t + dy));
        if (hd.includes("s")) c.b = Math.max(start.t + MIN_SIZE, Math.min(1, start.b + dy));
      }
      this.current.crop = c;
      this.syncCrop();
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      this.syncLabels();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  private syncCrop(): void {
    const els = this.cropEls;
    const s = this.current;
    if (!els || !s || s.mode !== "crop" || !this.frame || !this.page) return;
    const canvas = this.frame.querySelector<HTMLElement>(".adj-page");
    if (canvas) canvas.style.transform = `scale(${s.flipH ? -1 : 1}, ${s.flipV ? -1 : 1})`;
    const { l, t, r, b } = s.crop;
    for (const el of [els.dim, els.box]) {
      el.style.left = `${l * 100}%`;
      el.style.top = `${t * 100}%`;
      el.style.right = `${(1 - r) * 100}%`;
      el.style.bottom = `${(1 - b) * 100}%`;
    }
    const cm = this.tr("adjUnit", "in") === "cm";
    const unit = (pt: number) => (cm ? (pt / 72 * 2.54).toFixed(1) : (pt / 72).toFixed(1));
    const size = `${unit((r - l) * this.page.widthPt)} × ${unit((b - t) * this.page.heightPt)} ${cm ? "cm" : "in"}`;
    els.caption.textContent = this.tr("adjCropCaption", "Drag the handles to crop · {size}").replace("{size}", size);
  }

  // ── Straighten ──────────────────────────────────────────────────────────────

  private buildWarp(frame: HTMLElement, r: Rendered): void {
    const canvas = this.pageCanvas(r);
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.classList.add("adj-svg");
    const path = (cls: string) => {
      const p = document.createElementNS(NS, "path");
      p.setAttribute("class", cls);
      svg.append(p);
      return p;
    };
    const dim = path("adj-warp-dim");
    const poly = path("adj-warp-poly");
    const link = path("adj-warp-link");
    const names: [Key, string][] = [["adjCornerTL", "Top left corner"], ["adjCornerTR", "Top right corner"], ["adjCornerBR", "Bottom right corner"], ["adjCornerBL", "Bottom left corner"]];
    const corners = names.map(([key, fb], i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "adj-corner";
      b.title = this.tr(key, fb);
      b.setAttribute("aria-label", b.title);
      b.addEventListener("pointerdown", (e) => this.dragCorner(e, i));
      return b;
    });
    const loupe = document.createElement("canvas");
    loupe.className = "adj-loupe";
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    loupe.width = loupe.height = LOUPE * dpr;
    const label = document.createElement("span");
    label.className = "adj-loupe-label";
    frame.append(canvas, svg, ...corners, loupe, label);
    this.warpEls = { svg, dim, poly, link, corners, loupe, label };
  }

  private dragCorner(e: PointerEvent, i: number): void {
    if (e.button !== 0 || !this.frame) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    target.focus();
    this.corner = i;
    const fr = this.frame.getBoundingClientRect();
    const q = this.current.quad[i];
    const start: Point = [q[0], q[1]];
    const x0 = e.clientX, y0 = e.clientY;
    this.syncWarp();
    const move = (ev: PointerEvent) => {
      q[0] = clamp01(start[0] + (ev.clientX - x0) / fr.width);
      q[1] = clamp01(start[1] + (ev.clientY - y0) / fr.height);
      this.syncWarp();
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      this.syncLabels();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  private syncWarp(): void {
    const els = this.warpEls;
    const s = this.current;
    if (!els || !s || s.mode !== "straighten" || !this.frame || !this.page) return;
    const w = this.frame.clientWidth, h = this.frame.clientHeight;
    els.svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    const pts = s.quad.map(([x, y]) => [x * w, y * h] as Point);
    const d = `M${pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" L")}Z`;
    els.poly.setAttribute("d", d);
    // Dim what falls outside the page's corners.
    els.dim.setAttribute("d", `M0 0H${w}V${h}H0Z ${d}`);
    pts.forEach(([x, y], i) => {
      const b = els.corners[i];
      b.style.left = `${x}px`;
      b.style.top = `${y}px`;
      b.classList.toggle("active", i === this.corner);
    });
    const on = this.corner >= 0;
    els.loupe.hidden = els.label.hidden = !on;
    if (!on) { els.link.setAttribute("d", ""); return; }

    const c = pts[this.corner];
    const left = this.corner === 0 || this.corner === 3, top = this.corner === 0 || this.corner === 1;
    // Offset toward the inside, so the loupe never sits under the pointer.
    const lx = Math.min(w + 40, Math.max(-40, c[0] + (left ? 120 : -120)));
    const ly = Math.min(h + 40, Math.max(-40, c[1] + (top ? 110 : -110)));
    els.loupe.style.left = `${lx}px`;
    els.loupe.style.top = `${ly}px`;
    els.label.style.left = `${lx}px`;
    els.label.style.top = `${ly + LOUPE / 2 + 8}px`;
    els.link.setAttribute("d", `M${c[0].toFixed(1)} ${c[1].toFixed(1)}L${lx.toFixed(1)} ${ly.toFixed(1)}`);
    const q = s.quad[this.corner];
    els.label.textContent = `x ${Math.round(q[0] * this.page.widthPt)} · y ${Math.round(q[1] * this.page.heightPt)} · ×${ZOOM}`;
    this.drawLoupe(els.loupe, pts, c, w);
  }

  private drawLoupe(loupe: HTMLCanvasElement, pts: Point[], c: Point, w: number): void {
    const src = this.page!.canvas;
    const ctx = loupe.getContext("2d")!;
    const dpr = loupe.width / LOUPE;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#3f3f46";
    ctx.fillRect(0, 0, LOUPE, LOUPE);
    // Display pixels → source pixels.
    const k = src.width / w;
    const span = LOUPE / ZOOM;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, (c[0] - span / 2) * k, (c[1] - span / 2) * k, span * k, span * k, 0, 0, LOUPE, LOUPE);
    const P = (p: Point): Point => [LOUPE / 2 + (p[0] - c[0]) * ZOOM, LOUPE / 2 + (p[1] - c[1]) * ZOOM];
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    pts.map(P).forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = "#E53935";
    ctx.beginPath();
    ctx.moveTo(LOUPE / 2, LOUPE / 2 - 16); ctx.lineTo(LOUPE / 2, LOUPE / 2 + 16);
    ctx.moveTo(LOUPE / 2 - 16, LOUPE / 2); ctx.lineTo(LOUPE / 2 + 16, LOUPE / 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(LOUPE / 2, LOUPE / 2, 5, 0, Math.PI * 2);
    ctx.stroke();
  }

  // ── DOM helpers ─────────────────────────────────────────────────────────────

  private tr(key: Key, fb: string): string {
    const v = this.t[key];
    return typeof v === "string" ? v : fb;
  }

  private text(el: HTMLElement, key: Key, fb: string): void {
    el.textContent = fb;
    this.texts.push([el, key, fb]);
  }

  private button(cls: string, icon: string, key: Key | null, fb: string, titleKey?: Key, titleFb?: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.innerHTML = icon;
    if (key) {
      const label = document.createElement("span");
      this.text(label, key, fb);
      b.append(label);
    }
    const tk = titleKey ?? key;
    const tf = titleFb ?? fb;
    if (tk) {
      b.title = tf;
      b.setAttribute("aria-label", tf);
      this.titles.push([b, tk, tf]);
    }
    return b;
  }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
