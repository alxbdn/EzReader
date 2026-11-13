import { SignatureStore } from "./signature-store";
import type { InkVector } from "./models";
import { drawVector, fitVector, strokeSegments, vectorToPng } from "./signature-ink";

/** `imageData` is base64 PNG; `vector` is set for a drawn signature. */
type SignatureReadyHandler = (imageData: string, vector?: InkVector) => void;

/** Pixels per pad unit of the PNG kept beside a vector signature (thumbnails, preview). */
const THUMB_SCALE = 3;
/** Longest side of an imported signature picture, in pixels. */
const MAX_PICTURE_SIDE = 1200;

// ── SignatureModal ────────────────────────────────────────────────────────────

export class SignatureModal {
  private backdrop: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  private isDrawing = false;
  private hasContent = false;

  /** All strokes collected so far — each stroke is a list of [x,y] pairs. */
  private strokes: [number, number][][] = [];

  private store: SignatureStore;
  private savedSectionEl: HTMLElement;
  private savedListEl: HTMLElement;
  private selectedSavedId: string | null = null;
  /** The picture shown on the pad (imported or saved), as a data URL; null when the pad has only strokes. */
  private picture: string | null = null;
  private pictureImg: HTMLImageElement | null = null;

  private handlers: SignatureReadyHandler[] = [];

  constructor(store: SignatureStore) {
    this.store = store;
    this.backdrop = document.getElementById("signature-modal")!;
    this.canvas = document.getElementById("signature-canvas") as HTMLCanvasElement;
    this.ctx = this.canvas.getContext("2d")!;
    this.savedSectionEl = document.getElementById("sig-saved-section")!;
    this.savedListEl = document.getElementById("sig-saved-list")!;

    this.migrateOldStrokes();
    this.initDrawing();
    this.bindButtons();
  }

  /** Migrate old localStorage strokes key into the new store. */
  private migrateOldStrokes(): void {
    const oldStrokes = this.store.consumeOldStrokes();
    if (!oldStrokes || oldStrokes.length === 0) return;

    const vector = fitVector(strokeSegments(oldStrokes));
    if (vector) this.store.add(vectorToPng(vector, THUMB_SCALE), vector);
  }

  onSignatureReady(handler: SignatureReadyHandler): void {
    this.handlers.push(handler);
  }

  private emit(imageData: string, vector?: InkVector): void {
    this.handlers.forEach((h) => h(imageData, vector));
  }

  open(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.strokes = [];
    this.hasContent = false;
    this.selectedSavedId = null;
    this.picture = null;
    this.pictureImg = null;
    this.renderSavedList();
    this.backdrop.classList.remove("hidden");
    this.canvas.focus();
  }

  close(): void {
    this.backdrop.classList.add("hidden");
  }

  private clearCanvas(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.strokes = [];
    this.hasContent = false;
    this.selectedSavedId = null;
    this.picture = null;
    this.pictureImg = null;
    this.updateSelectedCard();
  }

  // ── Saved signatures list ───────────────────────────────────────────────

  private renderSavedList(): void {
    const sigs = this.store.getAll();
    this.savedListEl.innerHTML = "";

    if (sigs.length === 0) {
      this.savedSectionEl.classList.add("hidden");
      return;
    }

    this.savedSectionEl.classList.remove("hidden");

    for (const sig of sigs) {
      const card = document.createElement("div");
      card.className = "sig-saved-card";
      card.dataset.sigId = sig.id;

      const thumb = document.createElement("img");
      thumb.className = "sig-saved-thumb";
      thumb.src = sig.imageDataUrl;
      thumb.draggable = false;
      card.appendChild(thumb);

      const delBtn = document.createElement("button");
      delBtn.className = "sig-saved-delete";
      delBtn.title = "Delete";
      delBtn.dataset.i18nTitle = "sigDelete";
      delBtn.textContent = "\u2715";
      card.appendChild(delBtn);

      card.addEventListener("click", () => this.onSavedCardClick(sig.id, sig.imageDataUrl));
      delBtn.addEventListener("click", (e) => this.onDeleteSavedClick(sig.id, e));

      this.savedListEl.appendChild(card);
    }

    this.updateSelectedCard();
  }

  private onSavedCardClick(id: string, imageDataUrl: string): void {
    this.selectedSavedId = id;
    this.strokes = [];
    this.picture = imageDataUrl;
    this.updateSelectedCard();

    // Draw the saved image on the canvas
    const img = new Image();
    img.onload = () => {
      if (this.picture !== imageDataUrl) return; // another card was picked meanwhile
      this.pictureImg = img;
      this.redrawPad();
      this.hasContent = true;
    };
    img.src = imageDataUrl;
  }

  private onDeleteSavedClick(id: string, e: MouseEvent): void {
    e.stopPropagation();
    this.store.delete(id);
    if (this.selectedSavedId === id) {
      this.clearCanvas();
    }
    this.renderSavedList();
  }

  private updateSelectedCard(): void {
    for (const card of this.savedListEl.children) {
      const el = card as HTMLElement;
      el.classList.toggle("selected", el.dataset.sigId === this.selectedSavedId);
    }
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  /** The pad: the picture (fitted, centred), then the strokes. */
  private redrawPad(): void {
    const { width, height } = this.canvas;
    this.ctx.clearRect(0, 0, width, height);
    const img = this.picture ? this.pictureImg : null;
    if (img && img.width > 0) {
      const s = Math.min(width / img.width, height / img.height, 1);
      const dx = (width - img.width * s) / 2;
      const dy = (height - img.height * s) / 2;
      this.ctx.drawImage(img, dx, dy, img.width * s, img.height * s);
    }
    drawVector(this.ctx, { w: width, h: height, segs: strokeSegments(this.strokes) });
  }

  private initDrawing(): void {
    this.canvas.style.touchAction = "none";

    this.canvas.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      // If a saved signature was selected, starting to draw means a new signature
      if (this.selectedSavedId) {
        this.selectedSavedId = null;
        this.updateSelectedCard();
      }
      this.isDrawing = true;
      this.canvas.setPointerCapture(e.pointerId);
      this.strokes.push([[e.offsetX, e.offsetY]]);

      // Start rough preview path
      this.ctx.beginPath();
      this.ctx.moveTo(e.offsetX, e.offsetY);
      this.ctx.strokeStyle = "#000";
      this.ctx.lineWidth = 2;
      this.ctx.lineCap = "round";
      this.ctx.lineJoin = "round";
    });

    this.canvas.addEventListener("pointermove", (e) => {
      if (!this.isDrawing) return;
      e.preventDefault();
      const current = this.strokes[this.strokes.length - 1];
      current.push([e.offsetX, e.offsetY]);

      // Rough preview
      this.ctx.lineTo(e.offsetX, e.offsetY);
      this.ctx.stroke();
      this.ctx.beginPath();
      this.ctx.moveTo(e.offsetX, e.offsetY);
      this.hasContent = true;
    });

    const stopDrawing = (): void => {
      if (!this.isDrawing) return;
      this.isDrawing = false;
      // Re-render all strokes with smooth curves (over the picture, if any)
      this.redrawPad();
    };
    this.canvas.addEventListener("pointerup", stopDrawing);
    this.canvas.addEventListener("pointercancel", stopDrawing);
  }

  // ── Buttons ──────────────────────────────────────────────────────────────

  private bindButtons(): void {
    document
      .getElementById("sig-close-btn")!
      .addEventListener("click", () => this.close());

    document.getElementById("sig-clear-btn")!.addEventListener("click", () => {
      this.clearCanvas();
    });

    document.getElementById("sig-place-btn")!.addEventListener("click", () => {
      if (!this.hasContent) return;

      const saved = this.selectedSavedId
        ? this.store.getAll().find((x) => x.id === this.selectedSavedId)
        : undefined;
      let dataUrl: string;
      let vector: InkVector | undefined;
      if (saved) {
        // Re-using an existing saved signature — update its last-used time
        this.store.touch(saved.id);
        dataUrl = saved.imageDataUrl;
        vector = saved.vector;
      } else {
        // New signature — save it. Pen strokes alone stay vectors (sharp at
        // any size); a picture keeps its own resolution; strokes over a
        // picture are kept as the pad shows them.
        vector = this.picture ? undefined : fitVector(strokeSegments(this.strokes)) ?? undefined;
        dataUrl = vector
          ? vectorToPng(vector, THUMB_SCALE)
          : this.picture && this.strokes.length === 0
            ? this.picture
            : this.canvas.toDataURL("image/png");
        this.store.add(dataUrl, vector);
      }

      this.close();
      this.emit(dataUrl.split(",")[1] ?? dataUrl, vector); // strip data:image/png;base64,
    });

    document
      .getElementById("sig-image-btn")!
      .addEventListener("click", () => this.loadImageFile());
  }

  private loadImageFile(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg";
    input.style.display = "none";

    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string;
        if (!dataUrl) return;

        const img = new Image();
        img.onload = () => {
          this.clearCanvas();
          // The picture keeps its own resolution (at most MAX_PICTURE_SIDE);
          // the pad only shows it.
          const k = Math.min(1, MAX_PICTURE_SIDE / Math.max(img.width, img.height));
          const c = document.createElement("canvas");
          c.width = Math.max(1, Math.round(img.width * k));
          c.height = Math.max(1, Math.round(img.height * k));
          c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
          this.picture = c.toDataURL("image/png");
          this.pictureImg = img;
          this.redrawPad();
          this.hasContent = true;
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
      input.remove();
    });

    document.body.appendChild(input);
    input.click();
  }
}
