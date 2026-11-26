import { test as base, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const stub = readFileSync(join(root, "tests", "visual", "tauri-stub.js"), "utf8");
export const DOC = "pdf14-mixed-sizes-rotated.pdf";
const RAW = join(import.meta.dirname, "raw");
const CORPUS = join(root, "src-tauri", "tests", "corpus");

export const test = base.extend<{ coverage: void }>({
  coverage: [
    async ({ page }, use, info) => {
      await page.coverage.startJSCoverage({ resetOnNavigation: false });
      await use();
      const entries = (await page.coverage.stopJSCoverage()).filter((e) => new URL(e.url).pathname.startsWith("/src/"));
      mkdirSync(RAW, { recursive: true });
      writeFileSync(join(RAW, `${info.testId}.json`), JSON.stringify(entries));
    },
    { auto: true },
  ],
});
export { expect };

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR4nGP4z8DwHxkzkC4AADxAH+HggXe0AAAAAElFTkSuQmCC";

function answers(png: string) {
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
  const base = internals.invoke.bind(internals);
  let opened = 0;
  const docs = ["unicode-links-outlines.pdf", "form-acroform.pdf", "encrypted-aes-256.pdf", "foreign-annotations.pdf", "scanned-jpeg.pdf"];
  const next = () => `/docs/${docs[opened++ % docs.length]}`;
  const extra: Record<string, () => unknown> = {
    open_pages_dialog: () => [next()],
    open_document_dialog: next,
    open_documents_dialog: () => [next()],
    open_image_dialog: () => "/pics/stamp.png",
    open_stamp_dialog: () => "/pics/recu.svg",
    load_svg: () => btoa('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><circle cx="100" cy="100" r="80" fill="none" stroke="#1d4ed8" stroke-width="12"/></svg>'),
    open_images_dialog: () => ["/pics/a.png", "/pics/b.png"],
    load_picture: () => ({ data: png, width: 4, height: 4 }),
    save_pdf_dialog: () => "/docs/saved.pdf",
    save_as_dialog: () => "/docs/saved.pdf",
    pick_directory_dialog: () => "/out",
    list_printers: () => ({ printers: ["Office printer"], default_printer: "Office printer" }),
    estimate_compression: () => ({ original: 100000, estimates: { low: 90000, medium: 60000, high: 30000 } }),
    compress_pdf: () => ({ original: 100000, compressed: 50000 }),
    ocr_image: () => ({ lines: [{ text: "Hello", x: 0, y: 0, width: 10, height: 2 }] }),
    convert_text: () => null,
    extract_pages_to_temp: () => "/tmp/doc (page 1).pdf",
  };
  internals.invoke = async (cmd, args) => {
    (window as unknown as { __EZ_CALLS__: string[] }).__EZ_CALLS__.push(cmd);
    return cmd in extra ? extra[cmd]!() : base(cmd, args);
  };
}

export async function start(page: Page, { doc = false, stub: extra = {} }: { doc?: boolean; stub?: object } = {}) {
  await page.route("**/__fixtures__/*", (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() ?? "");
    const file = existsSync(join(CORPUS, name)) ? name : DOC;
    return route.fulfill({ body: readFileSync(join(CORPUS, file)), contentType: "application/pdf" });
  });
  const opts = { ...(doc ? { startupFile: `/docs/${DOC}`, pages: 4 } : {}), ...extra };
  await page.addInitScript(`window.__EZ_STUB__ = ${JSON.stringify(opts)};`);
  await page.addInitScript(stub);
  await page.addInitScript(`(${answers.toString()})(${JSON.stringify(PNG)})`);
  await page.goto("/");
  await expect(page.locator(".menubar-item").first()).toBeVisible();
  if (doc) await expect(page.locator("#viewer-scroll .page-wrapper")).toHaveCount(4);
}
