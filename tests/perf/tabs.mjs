import { createServer } from "node:http";
import { createReadStream, readFileSync, statSync, existsSync, readdirSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { extname, join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i === -1 ? def : args[i + 1]; };
const profileName = opt("--profile", "quick");
const outPath = opt("--out", "perf-tabs-results.json");
const workDir = resolve(opt("--dir", join(tmpdir(), "ezreader-perf-tabs")));
const profile = JSON.parse(readFileSync(join(here, "tabs-profiles.json"), "utf8"))[profileName];
if (!profile) throw new Error(`Unknown profile ${profileName}`);
const rounds = Number(opt("--rounds", profile.rounds));
const thresholds = JSON.parse(readFileSync(join(here, "tabs-thresholds.json"), "utf8"));
const dist = resolve(here, "..", "..", "dist");
if (!existsSync(join(dist, "index.html"))) throw new Error("dist/ is missing: run `npm run build` first");

mkdirSync(workDir, { recursive: true });
const docs = profile.docs.map((d, i) => {
  const path = join(workDir, `doc${i + 1}-${d.pages}p.pdf`);
  if (!existsSync(path)) execFileSync(process.execPath, [join(here, "make-big-pdf.mjs"), path, String(d.pages), String(d.scanEvery ?? 5)], { stdio: "inherit" });
  return { ...d, path, name: path.split("/").pop(), expected: d.pages * d.annotationsPerPage };
});
const byPath = new Map(docs.map((d) => [d.path, d]));

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".pdf": "application/pdf", ".woff2": "font/woff2" };
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const asked = url.pathname.startsWith("/file/") ? decodeURIComponent(url.pathname.slice(6)) : null;
  const file = asked ?? join(dist, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
  if (asked ? !byPath.has(asked) : !file.startsWith(dist)) { res.writeHead(403).end(); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  const size = statSync(file).size;
  const headers = { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*" };
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, "Content-Length": size });
    createReadStream(file).pipe(res);
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const tauriStub = ({ origin, specs }) => {
  let next = 1;
  const callbacks = new Map();
  const listeners = new Map();
  const SIG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const colors = [{ r: 229, g: 57, b: 53 }, { r: 30, g: 30, b: 200 }, { r: 255, g: 235, b: 59 }, { r: 20, g: 140, b: 60 }];
  const make = (spec) => {
    const out = [];
    let seed = spec.pages * 7919 + spec.annotationsPerPage;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const kinds = spec.inkHeavy ? ["ink", "ink", "ink", "highlight", "text", "rect"] : ["highlight", "ink", "text", "rect", "note", "stamp", "circle", "signature"];
    for (let page = 1; page <= spec.pages; page++) {
      for (let i = 0; i < spec.annotationsPerPage; i++) {
        const kind = kinds[(page + i) % kinds.length];
        const x = 40 + rnd() * 420, y = 60 + rnd() * 700, width = 40 + rnd() * 100, height = 14 + rnd() * 60;
        const color = colors[(page + i) % colors.length];
        const base = { page, x, y, width, height };
        if (kind === "highlight") out.push({ ...base, kind, height: 12, rects: [{ x, y, width, height: 12 }], color, opacity: 0.4 });
        else if (kind === "ink") {
          const n = 50 + Math.floor(rnd() * 150);
          out.push({ ...base, kind, color, strokeWidth: 2, points: Array.from({ length: n }, (_, k) => [k / (n - 1), 0.5 + 0.45 * Math.sin(k / 6 + page)]) });
        } else if (kind === "text") out.push({ page, x, y, kind, width: 180, content: `Note ${page}.${i} lorem ipsum dolor`, color, fontSize: 11, bold: false, italic: false, underline: false, alignment: "left" });
        else if (kind === "rect" || kind === "circle") out.push({ ...base, kind, color, strokeWidth: 2 });
        else if (kind === "note") out.push({ ...base, kind, width: 20, height: 20, content: `Comment ${page}.${i}`, color });
        else if (kind === "stamp") out.push({ ...base, kind, width: 24, height: 24, mark: i % 2 ? "cross" : "check", color });
        else out.push({ ...base, kind, imageData: SIG });
      }
    }
    return out;
  };
  window.__perfSaved = {};
  window.__perfUnknown = new Set();
  window.__perfOcr = 0;
  window.__perfEmit = (event, payload) => {
    for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, id, payload });
  };
  const ocrResult = {
    text: "", language: "en",
    lines: Array.from({ length: 40 }, (_, l) => ({
      text: "", words: Array.from({ length: 10 }, (_, w) => ({ text: `word${w}`, x: 0.08 + w * 0.085, y: 0.06 + l * 0.022, w: 0.07, h: 0.012 })),
    })),
  };
  const answers = {
    get_startup_args: { filePath: null, shouldPrint: false },
    read_annotations: [],
    temp_tag: "perf",
    "plugin:path|resolve_directory": "/tmp",
    "plugin:window|inner_size": { width: 1280, height: 800 },
    "plugin:window|outer_size": { width: 1280, height: 800 },
    "plugin:window|scale_factor": window.devicePixelRatio,
    "plugin:window|is_maximized": false,
    "plugin:window|is_fullscreen": false,
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    plugins: { path: { sep: "/", delimiter: ":" } },
    convertFileSrc: (p) => `${origin}/file/${encodeURIComponent(p)}`,
    transformCallback: (cb) => { const id = next++; callbacks.set(id, cb); return id; },
    unregisterCallback: (id) => callbacks.delete(id),
    invoke: async (cmd, a = {}) => {
      if (cmd === "ocr_image") { window.__perfOcr++; await new Promise((r) => setTimeout(r, 250)); return ocrResult; }
      if (cmd === "open_for_display") return { annotations: specs[a.filePath] ? make(specs[a.filePath]) : [], workingCopy: false };
      if (cmd === "save_annotated_pdf") { window.__perfSaved[a.inputPath] = a.annotations.length; return null; }
      if (cmd === "plugin:path|basename") return String(a.path ?? "").split("/").pop();
      if (cmd === "plugin:event|listen") {
        if (!listeners.has(a.event)) listeners.set(a.event, []);
        listeners.get(a.event).push(a.handler);
        return a.handler;
      }
      if (cmd in answers) return answers[cmd];
      window.__perfUnknown.add(cmd);
      return null;
    },
  };
};

const TICK = 100;
const QUIET_BEFORE_IDLE_MS = 12000;
function descendants(root) {
  const kids = new Map();
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(Number(d));
    } catch {}
  }
  const out = [];
  const walk = (p) => { for (const k of kids.get(p) ?? []) { out.push(k); walk(k); } };
  walk(root);
  return out;
}
function treeUsage() {
  let pssKb = 0, ticks = 0;
  for (const pid of descendants(process.pid)) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
      ticks += Number(stat[11]) + Number(stat[12]);
      const m = /Pss:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"));
      if (m) pssKb += Number(m[1]);
    } catch {}
  }
  return { mb: pssKb / 1024, cpuSec: ticks / TICK, at: performance.now() };
}
const cpuPercent = (a, b) => (100 * (b.cpuSec - a.cpuSec)) / ((b.at - a.at) / 1000);

const specs = Object.fromEntries(docs.filter((d) => d.annotationsPerPage > 0).map((d) => [d.path, { pages: d.pages, annotationsPerPage: d.annotationsPerPage, inkHeavy: !!d.inkHeavy }]));
const browser = await chromium.launch({ args: ["--js-flags=--expose-gc"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5 });
await context.addInitScript(tauriStub, { origin, specs });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push((e.stack ?? String(e)).split("\n").slice(0, 4).join(" | ")));
page.on("crash", () => errors.push("renderer crashed"));
const cdp = await context.newCDPSession(page);
await cdp.send("Performance.enable");

const metrics = async () => {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  const canvasMb = await page.evaluate(() => {
    let px = 0;
    for (const c of document.querySelectorAll("#viewer-scroll canvas")) px += c.width * c.height;
    return (px * 4) / 1048576;
  });
  return { heapMb: m.JSHeapUsedSize / 1048576, nodes: m.Nodes, canvasMb, ...treeUsage() };
};
async function pdfWorkerHeapMb() {
  const bcdp = await browser.newBrowserCDPSession();
  const { targetInfos } = await bcdp.send("Target.getTargets");
  let total = 0;
  for (const t of targetInfos.filter((t) => t.type === "worker")) {
    const { sessionId } = await bcdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: false });
    const reply = new Promise((res) => bcdp.on("Target.receivedMessageFromTarget", (m) => {
      if (m.sessionId !== sessionId) return;
      const j = JSON.parse(m.message);
      if (j.id === 1) res(j.result);
    }));
    await bcdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id: 1, method: "Runtime.getHeapUsage" }) });
    total += (await reply).usedSize / 1048576;
  }
  await bcdp.detach();
  return total;
}
const gc = async () => { await cdp.send("HeapProfiler.collectGarbage"); await page.waitForTimeout(300); await cdp.send("HeapProfiler.collectGarbage"); };

const settle = (quiet = 250, timeout = 15000) => page.evaluate(([quiet, timeout]) => new Promise((done) => {
  const root = document.getElementById("viewer-scroll");
  const t0 = performance.now();
  let last = t0, timer;
  const finish = () => { obs.disconnect(); clearTimeout(cap); done(last - t0); };
  const obs = new MutationObserver(() => { last = performance.now(); clearTimeout(timer); timer = setTimeout(finish, quiet); });
  obs.observe(root, { subtree: true, childList: true, attributes: true });
  timer = setTimeout(finish, quiet);
  const cap = setTimeout(() => { obs.disconnect(); done(timeout); }, timeout);
}), [quiet, timeout]);

const pageReady = (n, timeout = 15000) => page.evaluate(([n, timeout]) => new Promise((done) => {
  const t0 = performance.now();
  const check = () => {
    const c = document.querySelector(`.page-wrapper[data-page="${n}"] .page-canvas`);
    if (c && c.width > 0) return done(performance.now() - t0);
    if (performance.now() - t0 > timeout) return done(timeout);
    requestAnimationFrame(check);
  };
  check();
}), [n, timeout]);

const shown = () => page.evaluate(() => ({
  tab: document.querySelector(".side-tab.active .side-tab-name")?.textContent ?? "",
  pages: document.querySelectorAll(".page-wrapper").length,
  tabs: document.querySelectorAll(".side-tab[data-tab]").length,
  dirty: [...document.querySelectorAll(".side-tab.dirty .side-tab-name")].map((e) => e.textContent),
}));

const samples = [];
const sample = async (phase) => {
  const m = await metrics();
  samples.push({ phase, t: Math.round(m.at), ...m });
  console.log(`  [${phase}] ${m.mb.toFixed(0)} MB, heap ${m.heapMb.toFixed(0)} MB, canvases ${m.canvasMb.toFixed(0)} MB, ${m.nodes} nodes`);
  return m;
};

const visiblePage = () => page.evaluate(() => {
  const root = document.getElementById("viewer-scroll").getBoundingClientRect();
  for (const w of document.querySelectorAll(".page-wrapper")) {
    const r = w.getBoundingClientRect();
    if (r.bottom > root.top + 40 && r.top < root.bottom) return Number(w.dataset.page);
  }
  return 1;
});
const waitForDoc = (doc, timeout = 60000) => page.waitForFunction(([name, pages]) => {
  const tab = document.querySelector(".side-tab.active .side-tab-name")?.textContent;
  if (tab !== name || document.querySelectorAll(".page-wrapper").length !== pages) return false;
  return [...document.querySelectorAll(".page-wrapper .page-canvas")].some((c) => c.width > 0);
}, [doc.name, doc.pages], { timeout, polling: 16 });
const shownReady = async (doc, timeout = 30000) => {
  const t0 = performance.now();
  await waitForDoc(doc, timeout);
  await pageReady(await visiblePage(), timeout);
  return performance.now() - t0;
};

await page.goto(origin);
await page.waitForFunction(() => window.__TAURI_INTERNALS__ && !document.getElementById("app").classList.contains("booting"), null, { timeout: 30000 });
await page.waitForTimeout(500);
await gc();
const empty = await sample("empty");

console.log(`Opening ${docs.length} documents in tabs`);
const tOpen = performance.now();
await page.evaluate((paths) => window.__perfEmit("open-files", paths), docs.map((d) => d.path));
await page.waitForFunction((n) => document.querySelectorAll(".side-tab[data-tab]").length === n, docs.length, { timeout: 120000, polling: 50 });
const openFailed = await shownReady(docs[docs.length - 1], 120000).then(() => false, () => true);
const openAllMs = performance.now() - tOpen;
const mismatches = [];
if (openFailed) mismatches.push(`the last tab opened (${docs[docs.length - 1].name}) was not drawn within 2 minutes`);
await settle();
await gc();
const opened = await sample("all opened");
console.log(`  ${docs.length} tabs open in ${openAllMs.toFixed(0)} ms`);

const scroller = page.locator("#viewer-scroll");
const box = await scroller.boundingBox();
const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
await page.mouse.move(centre.x, centre.y);

const rnd = (() => { let s = 42; return () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31; })();
const goTo = (n) => page.evaluate((n) => document.querySelector(`.page-wrapper[data-page="${n}"]`)?.scrollIntoView({ block: "start" }), n);

const switchMs = [];
const jumpMs = [];
const added = new Map(docs.map((d) => [d.path, 0]));

async function drawRect() {
  const annotate = page.locator('.mode-btn[data-mode="annotate"]');
  if ((await page.evaluate(() => document.body.dataset.mode)) !== "annotate") await annotate.first().click();
  const shapes = page.locator('.tool-btn[data-group="shapes"]');
  if (!(await shapes.first().isVisible())) return false;
  if ((await shapes.first().getAttribute("aria-pressed")) !== "true") await shapes.first().click();
  await page.mouse.move(centre.x - 120, centre.y - 60);
  await page.mouse.down();
  await page.mouse.move(centre.x - 40, centre.y, { steps: 4 });
  await page.mouse.move(centre.x + 40, centre.y + 40, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press("Escape");
  await page.mouse.move(centre.x, centre.y);
  return true;
}

async function visit(doc, r) {
  const t0 = performance.now();
  await page.keyboard.press("Control+Tab");
  await waitForDoc(doc, 30000).catch(() => {});
  await settle(300, 30000);
  const vp = await visiblePage();
  await pageReady(vp, 30000);
  switchMs.push(performance.now() - t0 - 300);
  console.log(`  ${doc.name}: shown in ${switchMs[switchMs.length - 1].toFixed(0)} ms`);
  const now = await shown();
  if (now.tab !== doc.name) mismatches.push(`round ${r}: expected tab ${doc.name}, got ${now.tab}`);
  if (now.pages !== doc.pages) mismatches.push(`round ${r}: ${doc.name} shows ${now.pages} pages instead of ${doc.pages}`);
  for (let i = 0; i < 8; i++) {
    const target = 1 + Math.floor(rnd() * doc.pages);
    await goTo(target);
    jumpMs.push(await pageReady(target));
  }
  for (let i = 0; i < 40; i++) {
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(16);
  }
  await settle();
  if (await drawRect()) added.set(doc.path, added.get(doc.path) + 1);
  await settle();
}

const order = (start) => docs.map((_, i) => docs[(start + i + 1) % docs.length]);
const busyStart = treeUsage();
let afterFirst = opened;
const ranRounds = openFailed ? 0 : rounds;
for (let r = 1; r <= ranRounds; r++) {
  for (const doc of order(docs.length - 1)) await visit(doc, r);
  await gc();
  const m = await sample(`after round ${r}`);
  if (r === 1) afterFirst = m;
}
const busyEnd = treeUsage();

const before = await shown();
const lostDirty = docs.filter((d) => added.get(d.path) > 0 && !before.dirty.includes(d.name)).map((d) => d.name);

for (const doc of openFailed ? [] : order(docs.length - 1)) {
  await page.keyboard.press("Control+Tab");
  await waitForDoc(doc, 30000).catch(() => {});
  await page.keyboard.press("Control+s");
  await page.waitForFunction((p) => p in window.__perfSaved, doc.path, { timeout: 30000 }).catch(() => {});
}
const saved = await page.evaluate(() => window.__perfSaved);
let lost = 0;
const perDoc = docs.map((d) => {
  const want = d.expected + added.get(d.path);
  const got = saved[d.path] ?? 0;
  if (!openFailed) lost += Math.max(0, want - got);
  return { name: d.name, pages: d.pages, annotations_expected: want, annotations_saved: got, drawn: added.get(d.path) };
});
const drawn = [...added.values()].reduce((a, b) => a + b, 0);

await gc();
const end = await sample("end");
const workerHeapMb = await pdfWorkerHeapMb();
await page.waitForTimeout(QUIET_BEFORE_IDLE_MS);
const idleA = treeUsage();
await page.waitForTimeout(5000);
const idleB = treeUsage();
const unknown = await page.evaluate(() => [...window.__perfUnknown]);
await browser.close();
server.close();

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0; };
const totalPages = docs.reduce((a, d) => a + d.pages, 0);
const totalAnnotations = docs.reduce((a, d) => a + d.expected, 0);
const results = {
  tabs: docs.length,
  pages: totalPages,
  annotations: totalAnnotations,
  rounds: ranRounds,
  open_all_ms: openAllMs,
  switch_p95_ms: pct(switchMs, 95),
  switch_median_ms: pct(switchMs, 50),
  jump_p95_ms: pct(jumpMs, 95),
  memory_empty_mb: empty.mb,
  memory_opened_mb: opened.mb,
  memory_peak_mb: Math.max(...samples.map((s) => s.mb)),
  memory_end_mb: end.mb,
  memory_leak_per_round_mb: ranRounds > 1 ? (end.mb - afterFirst.mb) / (ranRounds - 1) : 0,
  heap_opened_mb: opened.heapMb,
  heap_end_mb: end.heapMb,
  heap_leak_per_round_mb: ranRounds > 1 ? (end.heapMb - afterFirst.heapMb) / (ranRounds - 1) : 0,
  dom_nodes_end: end.nodes,
  dom_nodes_growth_after_round_1: end.nodes - afterFirst.nodes,
  pdf_worker_heap_end_mb: workerHeapMb,
  canvas_peak_mb: Math.max(...samples.map((s) => s.canvasMb)),
  cpu_busy_percent: cpuPercent(busyStart, busyEnd),
  cpu_idle_percent: cpuPercent(idleA, idleB),
  annotations_drawn: drawn,
  annotations_lost: lost,
  dirty_tabs_lost: lostDirty.length,
  wrong_document_shown: mismatches.length,
  page_errors: errors.length,
  test_seconds: (busyEnd.at - busyStart.at) / 1000,
};
if (drawn === 0 && !openFailed) mismatches.push("no annotation could be drawn");
results.wrong_document_shown = mismatches.length;

const rows = [];
let failed = false;
for (const [key, value] of Object.entries(results)) {
  const max = thresholds[key];
  const ok = max === undefined || value <= max;
  if (!ok) failed = true;
  rows.push({ key, value, max, ok });
}
console.log("\nResult                          Value      Limit");
for (const r of rows) console.log(`${r.ok ? " " : "✗"} ${r.key.padEnd(30)} ${r.value.toFixed(1).padStart(9)}  ${r.max ?? ""}`);
console.log("\nDocuments");
for (const d of perDoc) console.log(`  ${d.name.padEnd(22)} ${String(d.annotations_saved).padStart(6)} / ${d.annotations_expected} annotations saved`);
if (mismatches.length) console.log("\nProblems:\n  " + mismatches.join("\n  "));
if (lostDirty.length) console.log(`\nTabs no longer marked as changed: ${lostDirty.join(", ")}`);
if (errors.length) console.log("\nPage errors:\n  " + errors.join("\n  "));
if (unknown.length) console.log(`\nCommands answered with null: ${unknown.join(", ")}`);

writeFileSync(outPath, JSON.stringify({ profile: profileName, results, thresholds, documents: perDoc, samples, switchMs, jumpMs, mismatches, errors, date: new Date().toISOString() }, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  let md = `### Tabs test (${profileName}): ${docs.length} tabs, ${totalPages} pages, ${totalAnnotations} annotations\n\n| | Measure | Value | Limit |\n|---|---|---:|---:|\n`;
  for (const r of rows) md += `| ${r.ok ? "✅" : "❌"} | ${r.key} | ${r.value.toFixed(1)} | ${r.max ?? "–"} |\n`;
  md += `\n| Document | Pages | Annotations saved |\n|---|---:|---:|\n`;
  for (const d of perDoc) md += `| ${d.name} | ${d.pages} | ${d.annotations_saved} / ${d.annotations_expected} |\n`;
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}
process.exit(failed ? 1 : 0);
