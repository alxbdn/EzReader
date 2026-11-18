import { createServer } from "node:http";
import { createReadStream, readFileSync, statSync, existsSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i === -1 ? def : args[i + 1]; };
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const pdfPath = resolve(positional[0] ?? "big.pdf");
const outPath = opt("--out", "perf-results.json");
const rounds = Number(opt("--rounds", 3));
const thresholds = JSON.parse(readFileSync(join(here, "thresholds.json"), "utf8"));
const dist = resolve(here, "..", "..", "dist");
if (!existsSync(join(dist, "index.html"))) throw new Error("dist/ is missing: run `npm run build` first");

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".pdf": "application/pdf", ".woff2": "font/woff2" };
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const file = url.pathname === "/file" ? pdfPath : join(dist, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
  if (!file.startsWith(dist) && file !== pdfPath) { res.writeHead(403).end(); return; }
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

const tauriStub = ({ origin, pdfPath }) => {
  let next = 1;
  const callbacks = new Map();
  const answers = {
    get_startup_args: { filePath: pdfPath, shouldPrint: false },
    read_annotations: [],
    "plugin:window|inner_size": { width: 1280, height: 800 },
    "plugin:window|outer_size": { width: 1280, height: 800 },
    "plugin:window|scale_factor": window.devicePixelRatio,
    "plugin:window|is_maximized": false,
    "plugin:window|is_fullscreen": false,
    "plugin:path|basename": "big.pdf",
  };
  window.__perfUnknown = new Set();
  window.__perfOcr = 0;
  const ocrResult = {
    text: "", language: "en",
    lines: Array.from({ length: 40 }, (_, l) => ({
      text: "", words: Array.from({ length: 10 }, (_, w) => ({ text: `word${w}`, x: 0.08 + w * 0.085, y: 0.06 + l * 0.022, w: 0.07, h: 0.012 })),
    })),
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    plugins: { path: { sep: "/", delimiter: ":" } },
    convertFileSrc: () => `${origin}/file`,
    transformCallback: (cb) => { const id = next++; callbacks.set(id, cb); return id; },
    unregisterCallback: (id) => callbacks.delete(id),
    invoke: async (cmd) => {
      if (cmd === "ocr_image") { window.__perfOcr++; await new Promise((r) => setTimeout(r, 250)); return ocrResult; }
      if (cmd in answers) return answers[cmd];
      window.__perfUnknown.add(cmd);
      return null;
    },
  };
};

const TICK = 100;
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
function treeUsage(detail = false) {
  let pssKb = 0, ticks = 0;
  const parts = [];
  for (const pid of descendants(process.pid)) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8").slice(0).split(") ")[1].split(" ");
      ticks += Number(stat[11]) + Number(stat[12]);
      const m = /Pss:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"));
      if (m) pssKb += Number(m[1]);
      if (detail && m) parts.push(`${(/--type=([\w-]+)/.exec(readFileSync(`/proc/${pid}/cmdline`, "utf8")) ?? [, "main"])[1]}:${(Number(m[1]) / 1024).toFixed(0)}`);
    } catch {}
  }
  if (detail) console.log("    processes (MB): " + parts.join(" "));
  return { mb: pssKb / 1024, cpuSec: ticks / TICK, at: performance.now() };
}
const cpuPercent = (a, b) => (100 * (b.cpuSec - a.cpuSec)) / ((b.at - a.at) / 1000);

const browser = await chromium.launch({ args: ["--js-flags=--expose-gc"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5 });
await context.addInitScript(tauriStub, { origin, pdfPath });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
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
  return { heapMb: m.JSHeapUsedSize / 1048576, nodes: m.Nodes, listeners: m.JSEventListeners, canvasMb, ...treeUsage() };
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

const samples = [];
const sample = async (phase) => {
  const m = await metrics();
  samples.push({ phase, t: Math.round(m.at), ...m });
  console.log(`  [${phase}] ${m.mb.toFixed(0)} MB, heap ${m.heapMb.toFixed(0)} MB, canvases ${m.canvasMb.toFixed(0)} MB, ${m.nodes} nodes`);
  return m;
};

console.log(`Opening ${pdfPath}`);
const tOpen = performance.now();
await page.goto(origin);
const pageCount = await page.waitForFunction(() => {
  const c = document.querySelector('.page-wrapper[data-page="1"] .page-canvas');
  return c && c.width > 0 && document.querySelectorAll(".page-wrapper").length;
}, null, { timeout: 60000, polling: 16 }).then((h) => h.jsonValue());
const openMs = performance.now() - tOpen;
await settle();
await gc();
const baseline = await sample("opened");
console.log(`  first page shown in ${openMs.toFixed(0)} ms, ${pageCount} pages laid out, ${baseline.mb.toFixed(0)} MB`);

const scroller = page.locator("#viewer-scroll");
const box = await scroller.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

const jumpMs = [];
const zoomMs = [];
const rnd = (() => { let s = 42; return () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31; })();
const goTo = (n) => page.evaluate((n) => document.querySelector(`.page-wrapper[data-page="${n}"]`).scrollIntoView({ block: "start" }), n);

async function round(r) {
  await goTo(1 + Math.floor(rnd() * (pageCount - 200)));
  for (let i = 0; i < 250; i++) {
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(16);
    if (i % 50 === 0) await sample(`r${r} scroll`);
  }
  await settle();
  for (let i = 0; i < 30; i++) {
    const target = 1 + Math.floor(rnd() * pageCount);
    await goTo(target);
    jumpMs.push(await pageReady(target));
    if (i % 10 === 0) await sample(`r${r} jump`);
  }
  await settle();
  await goTo(Math.floor(pageCount / 2));
  await settle();
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const key of ["Equal", "Equal", "Equal", "Equal", "Minus", "Minus", "Minus", "Minus", "Minus", "Minus", "Equal", "Equal"]) {
      await page.keyboard.press(`Control+${key}`);
      zoomMs.push(await settle(200));
    }
    await sample(`r${r} zoom`);
  }
  for (let i = 0; i < 120; i++) {
    await page.mouse.wheel(0, -700);
    await page.waitForTimeout(16);
    if (i % 40 === 0) await sample(`r${r} scroll-up`);
  }
  await settle();
}

const busyStart = treeUsage();
await round(1);
await gc();
const afterFirst = await sample("after round 1");
for (let r = 2; r <= rounds; r++) await round(r);
const busyEnd = treeUsage();
const peakMb = Math.max(...samples.map((s) => s.mb));
const peakCanvasMb = Math.max(...samples.map((s) => s.canvasMb));

await gc();
const end = await sample("end");
if (process.env.PERF_VERBOSE) treeUsage(true);
const workerHeapMb = await pdfWorkerHeapMb();
const idleA = treeUsage();
await page.waitForTimeout(5000);
const idleB = treeUsage();

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const unknown = await page.evaluate(() => [...window.__perfUnknown]);
const ocrPages = await page.evaluate(() => window.__perfOcr);
await browser.close();
server.close();

const results = {
  pdf: { pages: pageCount, mb: statSync(pdfPath).size / 1e6 },
  open_ms: openMs,
  jump_p95_ms: pct(jumpMs, 95),
  jump_median_ms: pct(jumpMs, 50),
  zoom_p95_ms: pct(zoomMs, 95),
  zoom_median_ms: pct(zoomMs, 50),
  memory_opened_mb: baseline.mb,
  memory_peak_mb: peakMb,
  memory_end_mb: end.mb,
  memory_growth_mb: end.mb - baseline.mb,
  memory_leak_per_round_mb: rounds > 1 ? (end.mb - afterFirst.mb) / (rounds - 1) : 0,
  heap_opened_mb: baseline.heapMb,
  heap_end_mb: end.heapMb,
  heap_growth_mb: end.heapMb - baseline.heapMb,
  heap_leak_per_round_mb: rounds > 1 ? (end.heapMb - afterFirst.heapMb) / (rounds - 1) : 0,
  dom_nodes_growth: end.nodes - baseline.nodes,
  pdf_worker_heap_end_mb: workerHeapMb,
  canvas_peak_mb: peakCanvasMb,
  canvas_end_mb: end.canvasMb,
  dom_nodes_end: end.nodes,
  cpu_busy_percent: cpuPercent(busyStart, busyEnd),
  cpu_idle_percent: cpuPercent(idleA, idleB),
  page_errors: errors.length,
  ocr_pages_read: ocrPages,
  test_seconds: (busyEnd.at - busyStart.at) / 1000,
};

const rows = [];
let failed = false;
for (const [key, value] of Object.entries(results)) {
  if (typeof value !== "number") continue;
  const max = thresholds[key];
  const ok = max === undefined || value <= max;
  if (!ok) failed = true;
  rows.push({ key, value, max, ok });
}
console.log("\nResult                    Value      Limit");
for (const r of rows) console.log(`${r.ok ? " " : "✗"} ${r.key.padEnd(22)} ${r.value.toFixed(1).padStart(9)}  ${r.max ?? ""}`);
if (errors.length) console.log("\nPage errors:\n  " + errors.join("\n  "));
if (unknown.length) console.log(`\nCommands answered with null: ${unknown.join(", ")}`);

writeFileSync(outPath, JSON.stringify({ results, thresholds, samples, jumpMs, zoomMs, errors, date: new Date().toISOString() }, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  let md = `### Load test: ${pageCount} pages, ${results.pdf.mb.toFixed(1)} MB\n\n| | Measure | Value | Limit |\n|---|---|---:|---:|\n`;
  for (const r of rows) md += `| ${r.ok ? "✅" : "❌"} | ${r.key} | ${r.value.toFixed(1)} | ${r.max ?? "–"} |\n`;
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}
process.exit(failed ? 1 : 0);
