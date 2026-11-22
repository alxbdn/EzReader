import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist";
import { SAFE_PDF } from "../pdf-options";
import { PDFJS_WASM_DIR, PDFJS_WASM_FILES } from "../pdf-wasm";

const SHIPPED = Object.keys(import.meta.glob("../../node_modules/pdfjs-dist/wasm/*", { query: "?url" })).map((path) =>
  path.split("/").pop(),
);
const WASM_URL = new URL("../../node_modules/pdfjs-dist/wasm/", import.meta.url).href;

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

describe("pdf.js image decoders", () => {
  it("ships the decoders pdf.js looks for, and never the scripting engine", () => {
    expect(PDFJS_WASM_DIR.endsWith("/")).toBe(true);
    for (const name of PDFJS_WASM_FILES) expect(SHIPPED, name).toContain(name);
    expect(PDFJS_WASM_FILES.some((name) => name.includes("quickjs"))).toBe(false);
  });

  it("renders a JPEG 2000 image once the decoders are reachable", async () => {
    const [r, g, b] = await centrePixel(WASM_URL);
    expect(r).toBeGreaterThan(180);
    expect(g).toBeLessThan(80);
    expect(b).toBeLessThan(80);
  });
});
