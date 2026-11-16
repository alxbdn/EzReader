// End-to-end tests: the real EzReader (Rust backend + webview) driven through
// WebDriver, as a user would: open a PDF, annotate it, save, use the menus,
// the launcher and the settings.
//
// Needs a built app and tauri-driver (https://v2.tauri.app/develop/tests/webdriver/):
//
//   npx tauri build --debug --no-bundle
//   cargo install tauri-driver --locked
//   npm run test:e2e            (Linux: inside xvfb-run, with webkit2gtk-driver)
//
// EZREADER_APP overrides the app's path. Each test starts the app afresh with
// its own profile (settings, signatures) and its own copy of the documents.

import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Builder, By, Key } from "selenium-webdriver";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const root = resolve(import.meta.dirname, "..");
const exe = process.platform === "win32" ? "ezreader-portable.exe" : "ezreader-portable";
const APP = process.env.EZREADER_APP ?? join(root, "src-tauri", "target", "debug", exe);
const CORPUS = join(root, "src-tauri", "tests", "corpus");
const SHOTS = join(root, "e2e", "results");

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

/**
 * tauri-driver, started for each test with a new profile: no settings,
 * language or signatures left by the test before. (On Windows the WebView2
 * profile lives in LOCALAPPDATA, on Linux in the XDG folders.)
 */
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
  // Its own process group, so stopping it also stops the native driver it runs.
  driverProc = spawn("tauri-driver", [], { env, stdio: "ignore", detached: process.platform !== "win32" });
  await waitForDriver();
}

afterEach(async (t) => {
  if (!driver) return;
  // A failed test leaves a screenshot of the window behind (uploaded by CI).
  if (t.passed === false || process.exitCode) {
    try {
      writeFileSync(join(SHOTS, `${t.name.replace(/[^\w-]+/g, "_")}.png`), await driver.takeScreenshot(), "base64");
    } catch { /* the app may already be gone */ }
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
  } catch { /* already gone */ }
  driverProc = undefined;
}

async function waitForDriver() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch("http://127.0.0.1:4444/status");
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error("tauri-driver did not start");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Starts the app, opening `file` when given (as the command line does). */
async function launch(file) {
  if (!driverProc) await startDriver();
  driver = await new Builder()
    .usingServer("http://127.0.0.1:4444/")
    .withCapabilities({ browserName: "wry", "tauri:options": { application: APP, args: file ? [file] : [] } })
    .build();
  await waitFor("the page to load", () => document.readyState === "complete" && !!document.querySelector(".menubar-item"));
  return driver;
}

/** A fresh copy of a corpus file, safe to save over. */
function copyOf(name) {
  const path = join(work, `${Date.now()}-${name}`);
  copyFileSync(join(CORPUS, name), path);
  return path;
}

/** Polls `fn` (run in the page) until it returns something truthy. */
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

/** Runs a Rust command through the app's own IPC. */
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

/** Waits until every page of the document is listed and the first is drawn. */
async function waitForDocument(pages) {
  await waitFor("the launcher to close", () => document.getElementById("welcome-screen").classList.contains("hidden"));
  await waitFor(`${pages} pages`, (n) => document.querySelectorAll("#viewer-scroll .page-wrapper").length === n, 15000, pages);
  await waitFor("the first page to be drawn", () => {
    const c = document.querySelector("#viewer-scroll .page-canvas");
    if (!c || !c.width) return false;
    // Not blank: some dark pixels (the text) on the white page.
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

/** Draws a rectangle with the Shapes tool on the first page. */
async function drawRectangle() {
  await click("[data-mode=annotate]");
  await click("[data-group=shapes]");
  // The studio panel opens on the right in Annotate: the pages refit to the
  // narrower viewer first, so the drag must wait for them to stand still.
  await waitForStillPage();
  const page = await driver.findElement(By.css("#viewer-scroll .page-wrapper"));
  await driver.actions({ async: true })
    // Inside the page even in a small window, next to the studio panel.
    .move({ origin: page, x: -100, y: -50 }).press()
    .move({ origin: page, x: -20, y: 30, duration: 250 })
    .release().perform();
}

/** Waits until the first page keeps the same place and size for half a second. */
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

describe("launcher", () => {
  test("starts on the launcher with an Open button and the menus", async () => {
    await launch();
    assert.equal(await waitFor("the launcher", () => !document.getElementById("welcome-screen").classList.contains("hidden")), true);
    assert.equal(await driver.findElement(By.css("#welcome-open-btn")).isDisplayed(), true);
    const menus = await driver.executeScript(() => [...document.querySelectorAll(".menubar-item")].map((b) => b.dataset.menuId));
    assert.deepEqual(menus, ["file", "edit", "view", "tools"]);
    // Nothing open: the document commands are greyed out.
    const save = await driver.executeScript(() =>
      [...document.querySelectorAll(".menu-entry")].find((e) => e.textContent.includes("Ctrl+S")).disabled);
    assert.equal(save, true);
  });

  test("switching the language to French translates the launcher and the menus", async () => {
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
    // Still a sound PDF for another reader, with its text.
    const info = await pdfInfo(file);
    assert.equal(info.pages, 4);
    assert.match(info.text, /Page 1/);
    const stored = await invoke("read_annotations", { filePath: file });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].kind, "rect");
    assert.equal(stored[0].page, 1);

    // Reopened: the rectangle is editable again, not just burned in.
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
    // Nothing to save: the file is untouched.
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
      assert.ok(entries >= 4, `${id}: ${entries} enabled entries`);
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
