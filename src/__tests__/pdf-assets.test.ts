import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist";
import { SAFE_PDF } from "../pdf-options";
import { PDFJS_ASSETS, PDFJS_ASSETS_DIR, shippedFiles, type PdfjsAssetDir } from "../pdf-assets";

const DIST = Object.keys(
  import.meta.glob("../../node_modules/pdfjs-dist/{wasm,cmaps,standard_fonts,iccs}/*", { query: "?url" }),
);
const available = (dir: string) => DIST.filter((p) => p.includes(`/pdfjs-dist/${dir}/`)).map((p) => p.split("/").pop()!);
/** A path, not a file: URL: pdf.js reads these with fs in Node. */
const url = (dir: PdfjsAssetDir) => decodeURIComponent(new URL(`../../node_modules/pdfjs-dist/${dir}/`, import.meta.url).pathname);
const WASM_URL = url("wasm");

/** A one-page PDF holding a 32×32 red square encoded as JPEG 2000 (JPXDecode). */
const JPX_PDF = "JVBERi0xLjUKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMiAzMl0gL1Jlc291cmNlcyA8PCAvWE9iamVjdCA8PCAvSW0wIDUgMCBSID4+ID4+IC9Db250ZW50cyA0IDAgUiA+PgplbmRvYmoKNCAwIG9iago8PCAvTGVuZ3RoIDI4ID4+CnN0cmVhbQpxIDMyIDAgMCAzMiAwIDAgY20gL0ltMCBEbyBRCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvWE9iamVjdCAvU3VidHlwZSAvSW1hZ2UgL1dpZHRoIDMyIC9IZWlnaHQgMzIgL0ZpbHRlciAvSlBYRGVjb2RlIC9MZW5ndGggMjU2ID4+CnN0cmVhbQoAAAAMalAgIA0KhwoAAAAUZnR5cGpwMiAAAAAAanAyIAAAAC1qcDJoAAAAFmloZHIAAAAgAAAAIAADBwcAAAAAAA9jb2xyAQAAAAAAEAAAALNqcDJj/0//UQAvAAAAAAAgAAAAIAAAAAAAAAAAAAAAIAAAACAAAAAAAAAAAAADBwEBBwEBBwEB/1IADAAAAAEABQQEAAH/XAATQEBISFBISFBISFBISFBISFD/ZAAlAAFDcmVhdGVkIGJ5IE9wZW5KUEVHIHZlcnNpb24gMi41LjT/kAAKAAAAAAAsAAH/k8+0CAMzz7QICB/PtAgIH4CAgICAgICAgICAgICAgP/ZCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQzIDAwMDAwIG4gCjAwMDAwMDAzMjEgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo2OTkKJSVFT0YK";

/** Renders the fixture and returns its centre pixel. */
async function centrePixel(wasmUrl: string): Promise<number[]> {
  const data = Uint8Array.from(atob(JPX_PDF), (c) => c.charCodeAt(0));
  const task = getDocument({ ...SAFE_PDF, data, verbosity: 0, wasmUrl });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const factory = doc.canvasFactory as {
      create(w: number, h: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D };
    };
    const { canvas, context } = factory.create(viewport.width, viewport.height);
    context.fillStyle = "#fff";
    context.fillRect(0, 0, viewport.width, viewport.height);
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    return Array.from(context.getImageData(16, 16, 1, 1).data.slice(0, 3));
  } finally {
    await task.destroy();
  }
}

/**
 * A one-page PDF writing "日本" with a non-embedded Japanese font, whose encoding pdf.js only
 * understands once it has loaded the UniJIS-UCS2-H CMap.
 */
const CJK_PDF = "JVBERi0xLjUKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAxMDAgNTBdIC9SZXNvdXJjZXMgPDwgL0ZvbnQgPDwgL0YxIDUgMCBSID4+ID4+IC9Db250ZW50cyA0IDAgUiA+PgplbmRvYmoKNCAwIG9iago8PCAvTGVuZ3RoIDM4ID4+CnN0cmVhbQpCVCAvRjEgMjQgVGYgMTAgMTAgVGQgPDY1RTU2NzJDPiBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUwIC9CYXNlRm9udCAvS296TWluUHI2Ti1SZWd1bGFyIC9FbmNvZGluZyAvVW5pSklTLVVDUzItSCAvRGVzY2VuZGFudEZvbnRzIFs2IDAgUl0gPj4KZW5kb2JqCjYgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL0NJREZvbnRUeXBlMCAvQmFzZUZvbnQgL0tvek1pblByNk4tUmVndWxhciAvQ0lEU3lzdGVtSW5mbyA8PCAvUmVnaXN0cnkgKEFkb2JlKSAvT3JkZXJpbmcgKEphcGFuMSkgL1N1cHBsZW1lbnQgNiA+PiAvRm9udERlc2NyaXB0b3IgNyAwIFIgPj4KZW5kb2JqCjcgMCBvYmoKPDwgL1R5cGUgL0ZvbnREZXNjcmlwdG9yIC9Gb250TmFtZSAvS296TWluUHI2Ti1SZWd1bGFyIC9GbGFncyA0IC9Gb250QkJveCBbMCAtMTIwIDEwMDAgODgwXSAvSXRhbGljQW5nbGUgMCAvQXNjZW50IDg4MCAvRGVzY2VudCAtMTIwIC9DYXBIZWlnaHQgNzAwIC9TdGVtViA4MCA+PgplbmRvYmoKeHJlZgowIDgKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQwIDAwMDAwIG4gCjAwMDAwMDAzMjggMDAwMDAgbiAKMDAwMDAwMDQ1NyAwMDAwMCBuIAowMDAwMDAwNjM3IDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgOCAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKODEzCiUlRU9GCg==";

describe("pdf.js run-time data", () => {
  it("ships every file pdf.js looks for, and never the scripting engine", () => {
    expect(PDFJS_ASSETS_DIR.endsWith("/")).toBe(true);
    for (const dir of Object.keys(PDFJS_ASSETS) as PdfjsAssetDir[]) {
      const files = shippedFiles(dir, available(dir));
      expect(files.length, dir).toBeGreaterThan(0);
      if (Array.isArray(PDFJS_ASSETS[dir])) expect(files, dir).toEqual(PDFJS_ASSETS[dir]);
    }
    expect(shippedFiles("cmaps", available("cmaps"))).toContain("UniJIS-UCS2-H.bcmap");
    expect(shippedFiles("standard_fonts", available("standard_fonts"))).toContain("FoxitSerif.pfb");
    expect(shippedFiles("wasm", available("wasm")).some((name) => name.includes("quickjs"))).toBe(false);
  });

  it("reads CJK text from a non-embedded font once the CMaps are reachable", async () => {
    const data = Uint8Array.from(atob(CJK_PDF), (c) => c.charCodeAt(0));
    const task = getDocument({ ...SAFE_PDF, data, verbosity: 0, cMapUrl: url("cmaps"), cMapPacked: true });
    try {
      const page = await (await task.promise).getPage(1);
      const text = (await page.getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join("");
      expect(text).toBe("日本");
    } finally {
      await task.destroy();
    }
  });

  it("renders a JPEG 2000 image once the decoders are reachable", async () => {
    const [r, g, b] = await centrePixel(WASM_URL);
    expect(r).toBeGreaterThan(180);
    expect(g).toBeLessThan(80);
    expect(b).toBeLessThan(80);
  });
});
