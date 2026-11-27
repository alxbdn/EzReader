import type { InkVector } from "./models";

export interface SignatureTarget {
  placeSignature(x: number, y: number, imageData: string, width: number, height: number, vector?: InkVector): void;
}

export interface SignaturePlacementDeps {
  scrollEl: HTMLElement;
  overlayOf(page: number): SignatureTarget | null;
  started(): void;
  ended(): void;
  placed(): void;
}

const FALLBACK_RATIO = 0.4;

export function signatureSize(ratio: number): { width: number; height: number } {
  const r = ratio > 0 ? ratio : FALLBACK_RATIO;
  const height = Math.min(75, 150 * r);
  return { width: height / r, height };
}

export class SignaturePlacement {
  private imageData: string | null = null;
  private vector: InkVector | undefined;
  private ratio = 0;
  private readonly preview: HTMLImageElement;

  constructor(private readonly deps: SignaturePlacementDeps, doc: Document = document) {
    this.preview = doc.createElement("img");
    this.preview.className = "sig-preview";
    doc.body.appendChild(this.preview);
    doc.addEventListener("mousemove", (e) => this.follow(e));
    deps.scrollEl.addEventListener("click", (e) => this.place(e));
  }

  get active(): boolean {
    return this.imageData !== null;
  }

  start(imageData: string, vector?: InkVector): void {
    this.imageData = imageData;
    this.vector = vector;
    this.ratio = vector && vector.w > 0 ? vector.h / vector.w : 0;
    const probe = new Image();
    probe.onload = () => {
      if (this.imageData === imageData && probe.naturalWidth > 0) this.ratio = probe.naturalHeight / probe.naturalWidth;
    };
    probe.src = `data:image/png;base64,${imageData}`;
    this.preview.src = `data:image/png;base64,${imageData}`;
    this.preview.style.display = "block";
    this.deps.scrollEl.style.cursor = "none";
    this.deps.started();
  }

  cancel(): boolean {
    if (!this.imageData) return false;
    this.imageData = null;
    this.vector = undefined;
    this.preview.style.display = "none";
    this.preview.src = "";
    this.deps.scrollEl.style.cursor = "";
    this.deps.ended();
    return true;
  }

  private follow(e: MouseEvent): void {
    if (!this.imageData) return;
    this.preview.style.left = `${e.clientX}px`;
    this.preview.style.top = `${e.clientY}px`;
  }

  private place(e: MouseEvent): void {
    if (!this.imageData) return;
    const wrapper = (e.target as HTMLElement).closest<HTMLElement>(".page-wrapper");
    if (!wrapper) return;
    const target = this.deps.overlayOf(parseInt(wrapper.dataset.page ?? "0"));
    if (!target) return;
    const rect = wrapper.getBoundingClientRect();
    const { width, height } = signatureSize(this.ratio);
    target.placeSignature(e.clientX - rect.left, e.clientY - rect.top, this.imageData, width, height, this.vector);
    this.cancel();
    this.deps.placed();
  }
}
