import { Modal, type Key } from "./modal";
import { ICON_IMAGE_SMALL, ICON_STAMP } from "./icons";
import { hexToRgb, STAMP_PRESETS, type RgbColor } from "./models";
import { DEFAULT_CUTOUT, hasTransparency, makeStamp, type Pixels } from "./stamp-maker";
import { STAMP_NAME_MAX } from "./stamp-store";

/** A picture picked for a stamp. `data` is base64. */
export interface StampSource {
  name: string;
  kind: "png" | "jpeg" | "svg";
  data: string;
}

export interface NewStamp { name: string; dataUrl: string; ratio: number }

const MIME: Record<StampSource["kind"], string> = { png: "image/png", jpeg: "image/jpeg", svg: "image/svg+xml" };
/** Size used for an SVG that gives none. */
const SVG_SIDE = 600;

/** The kind of a raster picture, from the first bytes of its base64. */
export function pictureKind(b64: string): "png" | "jpeg" {
  return b64.startsWith("/9j/") ? "jpeg" : "png";
}

/** The file name without its folder and extension, for the stamp's name. */
export function stampName(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? "";
  return file.replace(/\.[^.]+$/, "").slice(0, STAMP_NAME_MAX);
}

export class StampMakerModal extends Modal {
  private fileName: HTMLElement;
  private fileMeta: HTMLElement;
  private before: HTMLImageElement;
  private after: HTMLCanvasElement;
  private strength: HTMLInputElement;
  private strengthVal: HTMLElement;
  private strengthNote: HTMLElement;
  private colorBtns = new Map<"original" | "recolor", HTMLButtonElement>();
  private swatches: HTMLElement;
  private swatchBtns: HTMLButtonElement[] = [];
  private nameInput: HTMLInputElement;
  private error: HTMLElement;

  private img: HTMLImageElement | null = null;
  private source: StampSource | null = null;
  private recolorOn = false;
  private color: RgbColor = hexToRgb(STAMP_PRESETS[1]![0]);
  private result: HTMLCanvasElement | null = null;
  private frame = 0;
  private handlers: ((s: NewStamp) => void)[] = [];

  constructor(private pick: () => Promise<StampSource | null>) {
    super("stamp-maker-box", "stmTitle", "Create a stamp", "stmOk", "Add to my stamps", ICON_STAMP);

    const file = this.el("div", "stm-file");
    const fileIcon = this.el("span", "stm-file-icon");
    fileIcon.innerHTML = ICON_IMAGE_SMALL;
    this.fileName = this.el("span", "stm-file-name");
    this.fileMeta = this.el("span", "stm-file-meta");
    const change = this.el("button", "btn", "stmChange", "Change…");
    change.type = "button";
    change.addEventListener("click", () => void this.choose());
    const fileBox = this.el("div", "stm-file-box");
    fileBox.append(fileIcon, this.fileName, this.fileMeta);
    file.append(fileBox, change);

    const pics = this.el("div", "stm-pics");
    this.before = this.el("img");
    this.before.alt = "";
    this.after = this.el("canvas");
    const arrow = this.el("span", "stm-arrow");
    arrow.textContent = "›";
    pics.append(
      this.figure(this.before, "stm-pic", "stmBefore", "Imported picture"),
      arrow,
      this.figure(this.after, "stm-pic stm-checker", "stmAfter", "Cut-out stamp"),
    );

    const cut = this.el("div", "ez-field");
    const cutHead = this.el("div", "stm-row");
    this.strengthVal = this.el("b", "stm-value");
    cutHead.append(this.el("span", "ez-label", "stmCutout", "Cut-out"), this.strengthVal);
    this.strength = this.el("input", "wm-range");
    this.strength.type = "range";
    this.strength.min = "0";
    this.strength.max = "100";
    this.strength.step = "5";
    this.strength.addEventListener("input", () => this.changed());
    this.strengthNote = this.el("span", "wm-hint");
    cut.append(cutHead, this.strength, this.strengthNote);

    const col = this.el("div", "ez-field");
    const seg = this.el("div", "toolbar-segment opt-seg stm-seg");
    for (const [id, key, fb] of [["original", "stmOriginal", "Original"], ["recolor", "stmRecolor", "Recolor"]] as const) {
      const b = this.el("button", "opt-btn", key, fb);
      b.type = "button";
      b.addEventListener("click", () => { this.recolorOn = id === "recolor"; this.changed(); });
      this.colorBtns.set(id, b);
      seg.append(b);
    }
    this.swatches = this.el("div", "color-row-swatches stm-swatches");
    for (const [hex, name] of STAMP_PRESETS) {
      const b = this.el("button", "color-swatch");
      b.type = "button";
      b.style.background = hex;
      b.dataset["hex"] = hex;
      b.title = name;
      b.setAttribute("aria-label", name);
      b.addEventListener("click", () => { this.color = hexToRgb(hex); this.changed(); });
      this.swatchBtns.push(b);
      this.swatches.append(b);
    }
    col.append(this.el("span", "ez-label", "optColor", "Color"), seg, this.swatches);

    const settings = this.el("div", "stm-settings");
    settings.append(cut, col);

    const nameField = this.el("label", "ez-field");
    this.nameInput = this.el("input", "ez-input");
    this.nameInput.maxLength = STAMP_NAME_MAX;
    this.nameInput.addEventListener("input", () => this.syncOk());
    nameField.append(this.el("span", "ez-label", "stmName", "Name"), this.nameInput);

    this.error = this.el("span", "wm-hint stm-error");
    this.error.hidden = true;

    this.body.append(file, pics, settings, nameField,
      this.el("span", "wm-hint", "stmHint", "PNG and SVG keep their transparency. Photos and JPEG pictures are cut out automatically."),
      this.error);

    this.okBtn.addEventListener("click", () => {
      const r = this.result;
      if (!r || !this.nameInput.value.trim()) return;
      const stamp = { name: this.nameInput.value.trim(), dataUrl: r.toDataURL("image/png"), ratio: r.height / r.width };
      this.handlers.forEach((h) => h(stamp));
    });
  }

  onCreate(h: (s: NewStamp) => void): void { this.handlers.push(h); }

  /** Asks for a picture, then opens on it. Nothing opens when none is picked. */
  async start(): Promise<void> {
    const src = await this.pick();
    if (!src) return;
    this.nameInput.value = "";
    if (await this.load(src)) this.show();
  }

  showError(text: string): void {
    this.error.textContent = text;
    this.error.hidden = false;
  }

  private async choose(): Promise<void> {
    const src = await this.pick();
    if (src) await this.load(src);
  }

  private async load(src: StampSource): Promise<boolean> {
    const img = new Image();
    img.decoding = "async";
    img.src = `data:${MIME[src.kind]};base64,${src.data}`;
    try {
      await img.decode();
    } catch {
      this.showError(this.tr("stmUnreadable", "This picture can't be read."));
      return false;
    }
    if (src.kind === "svg" && (!img.naturalWidth || !img.naturalHeight)) {
      img.width = img.height = SVG_SIDE;
    } else {
      img.width = img.naturalWidth;
      img.height = img.naturalHeight;
    }
    this.img = img;
    this.source = src;
    this.error.hidden = true;
    this.before.src = img.src;
    this.fileName.textContent = src.name;
    this.fileMeta.textContent = `${src.kind.toUpperCase()} · ${img.width} × ${img.height}`;
    if (!this.nameInput.value.trim()) this.nameInput.value = stampName(src.name);
    const clear = src.kind !== "jpeg" && sees(img);
    this.strength.value = String(clear ? 0 : DEFAULT_CUTOUT);
    this.changed();
    return true;
  }

  protected override refresh(): void {
    if (this.source) this.changed();
  }

  private changed(): void {
    const v = Number(this.strength.value);
    this.strengthVal.textContent = v === 0 ? this.tr("stmOff", "Off") : v === DEFAULT_CUTOUT ? this.tr("stmAuto", "Auto") : `${v} %`;
    this.strengthNote.textContent = v === 0
      ? this.tr("stmCutoutOff", "The picture is kept as it is.")
      : this.tr("stmCutoutOn", "The paper color is detected and made transparent.");
    for (const [id, b] of this.colorBtns) b.classList.toggle("active", (id === "recolor") === this.recolorOn);
    this.swatches.hidden = !this.recolorOn;
    const hex = `#${[this.color.r, this.color.g, this.color.b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
    for (const b of this.swatchBtns) b.classList.toggle("on", b.dataset["hex"] === hex);
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.render());
  }

  private render(): void {
    if (!this.img) return;
    const v = Number(this.strength.value);
    this.result = makeStamp(this.img, { cutout: v === 0 ? null : v, color: this.recolorOn ? this.color : null });
    const r = this.result;
    if (r) {
      this.after.width = r.width;
      this.after.height = r.height;
      this.after.getContext("2d")?.drawImage(r, 0, 0);
      this.after.dataset["ready"] = "true";
    }
    this.syncOk();
  }

  private syncOk(): void {
    this.okBtn.disabled = !this.result || !this.nameInput.value.trim();
  }

  private figure(pic: HTMLElement, cls: string, key: Key, fb: string): HTMLElement {
    const f = this.el("figure", "stm-figure");
    const frame = this.el("div", cls);
    frame.append(pic);
    f.append(frame, this.el("figcaption", "wm-hint", key, fb));
    return f;
  }
}

/** True when the picture already has see-through parts (a PNG or SVG without paper). */
function sees(img: HTMLImageElement): boolean {
  const k = Math.min(1, 200 / Math.max(img.width, img.height, 1));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.width * k));
  c.height = Math.max(1, Math.round(img.height * k));
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const px: Pixels = { data: ctx.getImageData(0, 0, c.width, c.height).data, width: c.width, height: c.height };
  return hasTransparency(px);
}
