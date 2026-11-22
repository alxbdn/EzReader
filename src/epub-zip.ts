/** A small, read-only ZIP reader for EPUB files: stored and deflated entries, no encryption, no ZIP64. */

export class ZipError extends Error {}

interface Entry {
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  encrypted: boolean;
}

/** Upper bound for one unpacked entry, so a hostile file can't fill the memory. */
export const MAX_ENTRY_SIZE = 64 * 1024 * 1024;

export class ZipArchive {
  private readonly entries = new Map<string, Entry>();

  private constructor(private readonly bytes: Uint8Array) {}

  static open(bytes: Uint8Array): ZipArchive {
    const zip = new ZipArchive(bytes);
    zip.readDirectory();
    return zip;
  }

  get names(): string[] { return [...this.entries.keys()]; }

  has(name: string): boolean { return this.entries.has(name); }

  async read(name: string): Promise<Uint8Array> {
    const e = this.entries.get(name);
    if (!e) throw new ZipError(`missing entry: ${name}`);
    if (e.encrypted) throw new ZipError("encrypted entry");
    if (e.size > MAX_ENTRY_SIZE) throw new ZipError("entry too large");
    const view = this.view();
    const at = e.localOffset;
    if (at + 30 > this.bytes.length || view.getUint32(at, true) !== 0x04034b50) throw new ZipError("bad local header");
    const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
    const raw = this.bytes.subarray(start, start + e.compressedSize);
    if (raw.length < e.compressedSize) throw new ZipError("truncated entry");
    if (e.method === 0) return raw;
    if (e.method === 8) return inflate(raw, Math.max(e.size, 0));
    throw new ZipError(`unsupported compression: ${e.method}`);
  }

  async text(name: string): Promise<string> {
    return new TextDecoder("utf-8").decode(await this.read(name));
  }

  private view(): DataView {
    return new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
  }

  private readDirectory(): void {
    const b = this.bytes;
    const view = this.view();
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new ZipError("not a zip file");
    const count = view.getUint16(eocd + 10, true);
    let p = view.getUint32(eocd + 16, true);
    const names = new TextDecoder("utf-8");
    for (let n = 0; n < count; n++) {
      if (p + 46 > b.length || view.getUint32(p, true) !== 0x02014b50) throw new ZipError("bad central directory");
      const flags = view.getUint16(p + 8, true);
      const nameLen = view.getUint16(p + 28, true);
      const name = names.decode(b.subarray(p + 46, p + 46 + nameLen));
      if (!name.endsWith("/")) {
        this.entries.set(name, {
          method: view.getUint16(p + 10, true),
          compressedSize: view.getUint32(p + 20, true),
          size: view.getUint32(p + 24, true),
          localOffset: view.getUint32(p + 42, true),
          encrypted: (flags & 1) !== 0,
        });
      }
      p += 46 + nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
    }
  }
}

type Inflater = (raw: Uint8Array) => Promise<Uint8Array>;
let fallback: Inflater | null = null;

/** Unpacks deflated entries where the webview has no `DecompressionStream` (older macOS WebKit). */
export function setInflateFallback(f: Inflater): void { fallback = f; }

async function inflate(raw: Uint8Array, expected: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    if (!fallback) throw new ZipError("no decompressor");
    return fallback(raw);
  }
  const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(raw); c.close(); } });
  const stream = source.pipeThrough(new DecompressionStream("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const limit = Math.min(MAX_ENTRY_SIZE, expected + 1024);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) { void reader.cancel(); throw new ZipError("entry larger than announced"); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** Resolves `href` (URL-encoded, maybe with a #fragment) against the folder of `from`, inside the archive. */
export function resolveHref(from: string, href: string): { path: string; fragment: string } {
  const hash = href.indexOf("#");
  const fragment = hash >= 0 ? href.slice(hash + 1) : "";
  let rel = hash >= 0 ? href.slice(0, hash) : href;
  const q = rel.indexOf("?");
  if (q >= 0) rel = rel.slice(0, q);
  try { rel = decodeURIComponent(rel); } catch { /* keep as written */ }
  if (rel === "") return { path: from, fragment };
  const parts = rel.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return { path: parts.join("/"), fragment };
}
