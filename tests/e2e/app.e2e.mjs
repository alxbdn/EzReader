import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import { Builder, By, Key } from "selenium-webdriver";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const root = resolve(import.meta.dirname, "..", "..");
const exe = process.platform === "win32" ? "ezreader-portable.exe" : "ezreader-portable";
const APP = process.env.EZREADER_APP ?? join(root, "src-tauri", "target", "debug", exe);
const CORPUS = join(root, "src-tauri", "tests", "corpus");
const SHOTS = join(root, "tests", "e2e", "results");

let driverProc;
let work;
let driver;
let profiles = 0;

before(() => {
  work = mkdtempSync(join(tmpdir(), "ezreader-e2e-"));
  mkdirSync(SHOTS, { recursive: true });
});

after(() => {
  stopDriver();
  if (work) rmSync(work, { recursive: true, force: true });
});

async function startDriver() {
  const profile = join(work, `profile-${++profiles}`);
  const env = {
    ...process.env,
    LANG: "C.UTF-8",
    LANGUAGE: "en",
    XDG_DATA_HOME: join(profile, "data"),
    XDG_CONFIG_HOME: join(profile, "config"),
    XDG_CACHE_HOME: join(profile, "cache"),
    LOCALAPPDATA: join(profile, "local"),
  };
  driverProc = spawn("tauri-driver", [], { env, stdio: "ignore", detached: process.platform !== "win32" });
  await waitForDriver();
}

afterEach(async (t) => {
  if (!driver) return;
  if (t.passed === false || process.exitCode) {
    try {
      writeFileSync(join(SHOTS, `${t.name.replace(/[^\w-]+/g, "_")}.png`), await driver.takeScreenshot(), "base64");
    } catch {}
  }
  await driver.quit().catch(() => {});
  driver = undefined;
  stopDriver();
  await sleep(300);
});

function stopDriver() {
  if (!driverProc) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(driverProc.pid), "/t", "/f"], { stdio: "ignore" });
    else process.kill(-driverProc.pid, "SIGTERM");
  } catch {}
  driverProc = undefined;
}

async function waitForDriver() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch("http://127.0.0.1:4444/status");
      if (r.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("tauri-driver did not start");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function launch(file) {
  if (!driverProc) await startDriver();
  driver = await new Builder()
    .usingServer("http://127.0.0.1:4444/")
    .withCapabilities({ browserName: "wry", "tauri:options": { application: APP, args: file ? [file] : [] } })
    .build();
  await waitFor("the page to load", () => document.readyState === "complete" && !!document.querySelector(".menubar-item"));
  return driver;
}

function copyOf(name) {
  const path = join(work, `${Date.now()}-${name}`);
  copyFileSync(join(CORPUS, name), path);
  return path;
}

async function waitFor(what, fn, timeout = 15000, ...args) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await driver.executeScript(fn, ...args);
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what} (last: ${last})`);
}

function invoke(cmd, args) {
  return driver.executeAsyncScript(
    (cmd, args, done) => window.__TAURI_INTERNALS__.invoke(cmd, args).then(done, (e) => done({ error: String(e) })),
    cmd, args,
  );
}

async function click(css) {
  const el = await driver.findElement(By.css(css));
  await driver.wait(async () => (await el.isDisplayed()) && (await el.isEnabled()), 5000);
  await el.click();
}

async function ctrl(key) {
  await driver.actions().keyDown(Key.CONTROL).sendKeys(key).keyUp(Key.CONTROL).perform();
}

async function waitForDocument(pages) {
  await waitFor("the opening screen to close", () => document.getElementById("welcome-screen").classList.contains("hidden"));
  await waitFor(`${pages} pages`, (n) => document.querySelectorAll("#viewer-scroll .page-wrapper").length === n, 15000, pages);
  await waitFor("the first page to be drawn", () => {
    const c = document.querySelector("#viewer-scroll .page-canvas");
    if (!c || !c.width) return false;
    const px = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < px.length; i += 4 * 7) if (px[i] < 100) return true;
    return false;
  });
}

async function toast() {
  return waitFor("a message", () => {
    const t = document.getElementById("toast");
    return !t.classList.contains("hidden") && t.textContent;
  });
}

async function drawRectangle() {
  await click("[data-mode=annotate]");
  await click("[data-group=shapes]");
  await waitForStillPage();
  const page = await driver.findElement(By.css("#viewer-scroll .page-wrapper"));
  await driver.actions({ async: true })
    .move({ origin: page, x: -100, y: -50 }).press()
    .move({ origin: page, x: -20, y: 30, duration: 250 })
    .release().perform();
}

async function waitForStillPage() {
  const rect = () => driver.executeScript(() => {
    const r = document.querySelector("#viewer-scroll .page-wrapper").getBoundingClientRect();
    return [r.x, r.y, r.width, r.height].map(Math.round).join(",");
  });
  let last = await rect();
  for (let i = 0; i < 50; i++) {
    await sleep(500);
    const now = await rect();
    if (now === last) return;
    last = now;
  }
}

async function pdfInfo(path) {
  const task = getDocument({ data: new Uint8Array(readFileSync(path)), isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const text = (await page.getTextContent()).items.map((i) => i.str).join(" ");
  const info = { pages: doc.numPages, text, rotate: page.rotate };
  await task.destroy();
  return info;
}

/** A small EPUB: three chapters, a table of contents with a section, a style sheet. */
function makeEpub() {
  const para = "Il était une fois, au bord d'une rivière tranquille, un petit voyageur qui rêvait de voir le monde. ".repeat(6);
  const chapter = (title, extra = "") =>
    `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><link rel="stylesheet" href="s.css"/></head>` +
    `<body><h1>${title}</h1>${`<p>${para}</p>`.repeat(8)}${extra}${`<p>${para}</p>`.repeat(4)}</body></html>`;
  const files = {
    mimetype: "application/epub+zip",
    "META-INF/container.xml": `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    "OEBPS/content.opf": `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Le Petit Voyageur</dc:title><dc:creator>Jeanne Martin</dc:creator><dc:language>fr</dc:language></metadata>` +
      `<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="s.css" media-type="text/css"/>` +
      `<item id="c0" href="c0.xhtml" media-type="application/xhtml+xml"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest>` +
      `<spine><itemref idref="c0"/><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
    "OEBPS/nav.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>` +
      `<li><a href="c0.xhtml">Le départ</a><ol><li><a href="c0.xhtml#port">Au port</a></li></ol></li><li><a href="c1.xhtml">La forêt</a></li><li><a href="c2.xhtml">Le retour</a></li></ol></nav></body></html>`,
    "OEBPS/s.css": "h1 { text-align: center } p { text-indent: 1.5em; margin: 0 }",
    "OEBPS/c0.xhtml": chapter("Le départ", `<h2 id="port">Au port</h2>`),
    "OEBPS/c1.xhtml": chapter("La forêt"),
    "OEBPS/c2.xhtml": chapter("Le retour"),
  };
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, "utf8");
    const stored = name === "mimetype";
    const packed = stored ? data : deflateRawSync(data);
    const n = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30 + n.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    n.copy(local, 30);
    const cd = Buffer.alloc(46 + n.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(stored ? 0 : 8, 10);
    cd.writeUInt32LE(packed.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(n.length, 28);
    cd.writeUInt32LE(offset, 42);
    n.copy(cd, 46);
    locals.push(local, packed);
    central.push(cd);
    offset += local.length + packed.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  const path = join(work, `${Date.now()}-book.epub`);
  writeFileSync(path, Buffer.concat([...locals, ...central, end]));
  return path;
}

describe("opening screen", () => {
  test("starts on the opening screen with an Open button and the menus", async () => {
    await launch();
    assert.equal(await waitFor("the opening screen", () => !document.getElementById("welcome-screen").classList.contains("hidden")), true);
    assert.equal(await driver.findElement(By.css("#welcome-open-btn")).isDisplayed(), true);
    const menus = await driver.executeScript(() => [...document.querySelectorAll(".menubar-item")].map((b) => b.dataset.menuId));
    assert.deepEqual(menus, ["file", "edit", "view", "tools"]);
    const save = await driver.executeScript(() =>
      [...document.querySelectorAll(".menu-entry")].find((e) => e.textContent.includes("Ctrl+S")).disabled);
    assert.equal(save, true);
  });

  test("switching the language to French translates the opening screen and the menus", async () => {
    await launch();
    await ctrl(",");
    await waitFor("the settings", () => !document.getElementById("settings-modal").classList.contains("hidden"));
    await driver.executeScript(() => {
      const s = document.getElementById("settings-lang");
      s.value = "fr";
      s.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor("French menus", () => document.querySelector("[data-menu-id=file]").textContent.trim() === "Fichier");
    const open = await driver.findElement(By.css("#welcome-open-btn")).getText();
    assert.match(open, /Ouvrir/);
  });
});

describe("documents", () => {
  test("opens a PDF given on the command line and shows every page", async () => {
    const file = copyOf("pdf14-mixed-sizes-rotated.pdf");
    await launch(file);
    await waitForDocument(4);
    const title = await driver.executeScript(() => document.getElementById("menubar-row").textContent);
    assert.match(title, /pdf14-mixed-sizes-rotated\.pdf/);
    assert.equal(await invoke("get_page_count", { filePath: file }), 4);
  });

  test("annotates, saves with Ctrl+S, and finds the annotation again after reopening", async () => {
    const file = copyOf("pdf14-mixed-sizes-rotated.pdf");
    const before = readFileSync(file);
    await launch(file);
    await waitForDocument(4);
    await drawRectangle();
    await ctrl("s");
    assert.match(await toast(), /Saved/);

    const after = readFileSync(file);
    assert.notDeepEqual(after, before, "the file on disk changed");
    const info = await pdfInfo(file);
    assert.equal(info.pages, 4);
    assert.match(info.text, /Page 1/);
    const stored = await invoke("read_annotations", { filePath: file });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].kind, "rect");
    assert.equal(stored[0].page, 1);

    await driver.quit();
    await launch(file);
    await waitForDocument(4);
    const again = await invoke("read_annotations", { filePath: file });
    assert.equal(again.length, 1);
  });

  test("undo removes the annotation before it is saved", async () => {
    const file = copyOf("pdf14-mixed-sizes-rotated.pdf");
    const before = readFileSync(file);
    await launch(file);
    await waitForDocument(4);
    await drawRectangle();
    await ctrl("z");
    await sleep(300);
    await ctrl("s");
    await sleep(1000);
    const stored = await invoke("read_annotations", { filePath: file });
    assert.equal(stored.length, 0);
    assert.deepEqual(readFileSync(file), before);
  });

  test("opens a form and keeps its fields", async () => {
    const file = copyOf("form-acroform.pdf");
    await launch(file);
    await waitForDocument(1);
    const fields = await waitFor("the form fields", () =>
      document.querySelectorAll("#viewer-scroll input, #viewer-scroll select, #viewer-scroll textarea").length);
    assert.ok(fields >= 4, `${fields} fields shown`);
  });

  test("asks for the password of an encrypted PDF", async () => {
    const file = copyOf("encrypted-aes-256.pdf");
    await launch(file);
    await waitFor("the password prompt", () =>
      [...document.querySelectorAll(".modal-backdrop")].some((m) => !m.classList.contains("hidden") && m.querySelector("input[type=password]")));
    await driver.executeScript(() => {
      const input = [...document.querySelectorAll(".modal-backdrop:not(.hidden) input[type=password]")][0];
      input.focus();
    });
    await driver.switchTo().activeElement().sendKeys("corpus", Key.ENTER);
    await waitForDocument(2);
  });
});

describe("menus", () => {
  test("each menu opens, lists its commands and closes with Escape", async () => {
    await launch(copyOf("pdf14-mixed-sizes-rotated.pdf"));
    await waitForDocument(4);
    for (const id of ["file", "edit", "view", "tools"]) {
      await click(`[data-menu-id=${id}]`);
      const entries = await waitFor(`the ${id} menu`, (id) => {
        const btn = document.querySelector(`[data-menu-id=${id}]`);
        const menu = btn.nextElementSibling;
        if (getComputedStyle(menu).display === "none" || menu.getBoundingClientRect().height === 0) return 0;
        return [...menu.querySelectorAll(".menu-entry")].filter((e) => !e.disabled).length;
      }, 5000, id);
      assert.ok(entries >= 3, `${id}: ${entries} enabled entries`);
      await driver.actions().sendKeys(Key.ESCAPE).perform();
      await waitFor(`the ${id} menu to close`, (id) => {
        const menu = document.querySelector(`[data-menu-id=${id}]`).nextElementSibling;
        return getComputedStyle(menu).display === "none" || menu.getBoundingClientRect().height === 0;
      }, 5000, id);
    }
  });

  test("View > Two pages per row puts two pages side by side", async () => {
    await launch(copyOf("pdf14-mixed-sizes-rotated.pdf"));
    await waitForDocument(4);
    await click("[data-menu-id=view]");
    await driver.executeScript(() => {
      const entry = document.querySelector("[data-menu-id=view]").nextElementSibling.querySelectorAll(".menu-radio")[1];
      entry.click();
    });
    await waitFor("two pages per row", () => document.querySelector("#viewer-scroll .page-row").querySelectorAll(".page-wrapper").length === 2);
  });

  test("Edit > Rotate turns the page and Save writes it", async () => {
    const file = copyOf("pdf14-mixed-sizes-rotated.pdf");
    const before = await pdfInfo(file);
    await launch(file);
    await waitForDocument(4);
    await click("[data-menu-id=edit]");
    const rotate = await driver.executeScript(() => {
      const entries = [...document.querySelector("[data-menu-id=edit]").nextElementSibling.querySelectorAll(".menu-entry")];
      const e = entries.find((x) => /rotate/i.test(x.textContent));
      e?.click();
      return !!e;
    });
    assert.ok(rotate, "a Rotate entry");
    await sleep(800);
    await ctrl("s");
    assert.match(await toast(), /Saved/);
    const info = await pdfInfo(file);
    assert.equal(info.pages, 4);
    assert.equal(info.rotate, (before.rotate + 90) % 360, "page 1 turned a quarter");
  });

  test("Settings > dark theme switches the whole window", async () => {
    await launch();
    await ctrl(",");
    await waitFor("the settings", () => !document.getElementById("settings-modal").classList.contains("hidden"));
    await driver.executeScript(() => {
      const s = document.getElementById("settings-theme");
      s.value = "dark";
      s.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor("the dark theme", () => document.documentElement.dataset.theme === "dark");
  });
});

describe("books", () => {
  test("opens an EPUB given on the command line and moves between chapters", async () => {
    await launch(makeEpub());
    await waitFor("the book", () => !document.getElementById("epub-reader").hidden);
    assert.ok(await driver.executeScript(() => document.getElementById("welcome-screen").classList.contains("hidden")));
    await waitFor("chapter 1", () => document.querySelector(".epub-frame").contentDocument?.querySelector("h1")?.textContent === "Le départ");
    assert.equal(await driver.executeScript(() => document.querySelector(".epub-position").textContent), "1 / 3");
    await click(".epub-nav .page-nav-step:last-child");
    await waitFor("chapter 2", () => document.querySelector(".epub-frame").contentDocument?.querySelector("h1")?.textContent === "La forêt");
    assert.match(await driver.executeScript(() => document.getElementById("menubar-row").textContent), /Le Petit Voyageur/);
  });

  test("prints chapters to PDF and puts them together with bookmarks", async (t) => {
    await launch();
    if (!(await invoke("can_print_html_to_pdf", {}))) return t.skip("no webview printing here");
    const page = (title) => `<!doctype html><html><head><meta charset="utf-8"></head><body><h1>${title}</h1>${"<p>Bonjour tout le monde.</p>".repeat(80)}</body></html>`;
    const parts = await driver.executeAsyncScript((pages, done) => {
      const id = window.__TAURI_INTERNALS__.transformCallback(() => {});
      window.__TAURI_INTERNALS__.invoke("print_html_pages", { pages, progress: `__CHANNEL__:${id}` }).then(done, (e) => done({ error: String(e) }));
    }, [page("Un"), page("Deux")]);
    assert.ok(Array.isArray(parts), JSON.stringify(parts));
    assert.equal(parts.length, 2);
    const counts = [];
    for (const p of parts) counts.push(await invoke("get_page_count", { filePath: p }));
    assert.ok(counts.every((n) => n >= 2), `pages per chapter: ${counts}`);
    const merged = join(tmpdir(), `ezreader-e2e-${Date.now()}-merged.pdf`);
    const slots = [
      ...Array.from({ length: counts[0] }, (_, k) => ({ kind: "original", page: k + 1, rotation: 0 })),
      ...Array.from({ length: counts[1] }, (_, k) => ({ kind: "imported", path: parts[1], page: k + 1, rotation: 0 })),
    ];
    assert.equal(await invoke("rearrange_pages", { inputPath: parts[0], outputPath: merged, slots }), null);
    const out = join(tmpdir(), `ezreader-e2e-${Date.now()}-book.pdf`);
    const bookmarks = [{ title: "Un", page: 1, depth: 0 }, { title: "Deux", page: counts[0] + 1, depth: 0 }];
    assert.equal(await invoke("finish_book_pdf", { input: merged, output: out, bookmarks, title: "Livre", author: "Moi" }), null);
    const task = getDocument({ data: new Uint8Array(readFileSync(out)), isEvalSupported: false, verbosity: 0 });
    const doc = await task.promise;
    try {
      assert.equal(doc.numPages, counts[0] + counts[1]);
      assert.deepEqual((await doc.getOutline()).map((o) => o.title), ["Un", "Deux"]);
      const text = (await (await doc.getPage(counts[0] + 1)).getTextContent()).items.map((i) => i.str).join(" ");
      assert.match(text, /Deux/);
      assert.equal((await doc.getMetadata()).info.Title, "Livre");
    } finally {
      await task.destroy();
      rmSync(merged, { force: true });
      rmSync(out, { force: true });
    }
  });
});
