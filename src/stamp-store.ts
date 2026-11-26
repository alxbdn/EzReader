/** A stamp the user made from a picture, kept on this computer. */
export interface SavedStamp {
  id: string;
  name: string;
  /** PNG with transparency, as a data: URL. */
  dataUrl: string;
  /** Height divided by width. */
  ratio: number;
}

export const STAMP_NAME_MAX = 40;

export class StampStore {
  static readonly KEY = "ezreader-stamps";
  static readonly MAX = 8;

  private stamps: SavedStamp[] = [];

  constructor(private storage: Pick<Storage, "getItem" | "setItem"> = localStorage) {
    try {
      const raw = this.storage.getItem(StampStore.KEY);
      const list = raw ? JSON.parse(raw) as unknown : [];
      if (Array.isArray(list)) this.stamps = list.filter(isStamp);
    } catch {}
  }

  getAll(): SavedStamp[] { return this.stamps.slice(); }

  get(id: string): SavedStamp | undefined { return this.stamps.find((s) => s.id === id); }

  get full(): boolean { return this.stamps.length >= StampStore.MAX; }

  /** Adds a stamp first in the list. Returns null when the list is full or storage refuses it. */
  add(name: string, dataUrl: string, ratio: number): SavedStamp | null {
    if (this.full) return null;
    const stamp: SavedStamp = { id: crypto.randomUUID(), name: name.trim().slice(0, STAMP_NAME_MAX), dataUrl, ratio };
    this.stamps.unshift(stamp);
    if (!this.save()) {
      this.stamps.shift();
      return null;
    }
    return stamp;
  }

  delete(id: string): void {
    this.stamps = this.stamps.filter((s) => s.id !== id);
    this.save();
  }

  private save(): boolean {
    try {
      this.storage.setItem(StampStore.KEY, JSON.stringify(this.stamps));
      return true;
    } catch {
      return false;
    }
  }
}

function isStamp(s: unknown): s is SavedStamp {
  const o = s as SavedStamp;
  return !!o && typeof o.id === "string" && typeof o.name === "string" && typeof o.ratio === "number"
    && typeof o.dataUrl === "string" && o.dataUrl.startsWith("data:image/png;base64,");
}
