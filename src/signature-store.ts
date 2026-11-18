import type { InkVector } from "./models";

export interface SavedSignature {
  id: string;
  imageDataUrl: string;
  vector?: InkVector;
  lastUsedAt: number;
}

export class SignatureStore {
  private static STORAGE_KEY = "pdf-rider-saved-signatures";
  static OLD_STROKES_KEY = "pdf-rider-last-signature";

  private signatures: SavedSignature[] = [];

  constructor() {
    this.load();
  }

  getAll(): SavedSignature[] {
    return this.signatures.slice().sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  static readonly MAX = 3;

  add(imageDataUrl: string, vector?: InkVector): SavedSignature | null {
    while (this.signatures.length >= SignatureStore.MAX) {
      const oldest = this.signatures.reduce((a, b) => (a.lastUsedAt <= b.lastUsedAt ? a : b));
      this.signatures = this.signatures.filter((s) => s !== oldest);
    }
    const sig: SavedSignature = {
      id: crypto.randomUUID(),
      imageDataUrl,
      ...(vector ? { vector } : {}),
      lastUsedAt: Date.now(),
    };
    this.signatures.push(sig);
    if (!this.save()) {
      this.signatures.pop();
      return null;
    }
    return sig;
  }

  delete(id: string): void {
    this.signatures = this.signatures.filter((s) => s.id !== id);
    this.save();
  }

  touch(id: string): void {
    const sig = this.signatures.find((s) => s.id === id);
    if (sig) {
      sig.lastUsedAt = Date.now();
      this.save();
    }
  }

  hasOldStrokesKey(): boolean {
    return localStorage.getItem(SignatureStore.OLD_STROKES_KEY) !== null;
  }

  consumeOldStrokes(): [number, number][][] | null {
    try {
      const raw = localStorage.getItem(SignatureStore.OLD_STROKES_KEY);
      if (!raw) return null;
      const strokes = JSON.parse(raw) as [number, number][][];
      localStorage.removeItem(SignatureStore.OLD_STROKES_KEY);
      if (Array.isArray(strokes) && strokes.length > 0) return strokes;
    } catch {}
    return null;
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(SignatureStore.STORAGE_KEY);
      if (raw) this.signatures = JSON.parse(raw) as SavedSignature[];
    } catch {}
  }

  private save(): boolean {
    try {
      localStorage.setItem(
        SignatureStore.STORAGE_KEY,
        JSON.stringify(this.signatures),
      );
      return true;
    } catch {
      return false;
    }
  }
}
