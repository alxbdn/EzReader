import { statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { builtApp, checkThresholds, cliOptions, cpuPercent, openApp, percentile, readJson, seededRandom, serveApp, summarize, treeUsage } from "./harness.mjs";

const { opt, positional } = cliOptions();
const pdfPath = resolve(positional[0] ?? "big.pdf");
const outPath = opt("--out", "perf-results.json");
const rounds = Number(opt("--rounds", 3));
const thresholds = readJson("thresholds.json");
const server = await serveApp(builtApp(), (url) => (url.pathname === "/file" ? pdfPath : null));
const { origin } = server;

const tauriStub = ({ origin, pdfPath }) => {
  let next = 1;
  const callbacks = new Map();
  const answers = {
    get_startup_args: { filePath: pdfPath, shouldPrint: false },
    read_annotations: [],
    open_for_display: { annotations: [], workingCopy: false },
    temp_tag: "perf",
    "plugin:path|resolve_directory": "/tmp",
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

const app = await openApp(tauriStub, { origin, pdfPath });
const { page, errors, samples, sample, gc, settle, pageReady, goTo, pdfWorkerHeapMb } = app;

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
const rnd = seededRandom();

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

const unknown = await page.evaluate(() => [...window.__perfUnknown]);
const ocrPages = await page.evaluate(() => window.__perfOcr);
await app.close();
server.close();

const results = {
  pdf: { pages: pageCount, mb: statSync(pdfPath).size / 1e6 },
  open_ms: openMs,
  jump_p95_ms: percentile(jumpMs, 95),
  jump_median_ms: percentile(jumpMs, 50),
  zoom_p95_ms: percentile(zoomMs, 95),
  zoom_median_ms: percentile(zoomMs, 50),
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
  dom_nodes_growth_per_page: (end.nodes - baseline.nodes) / pageCount,
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

const { rows, failed } = checkThresholds(results, thresholds, 22);
if (errors.length) console.log("\nPage errors:\n  " + errors.join("\n  "));
if (unknown.length) console.log(`\nCommands answered with null: ${unknown.join(", ")}`);

writeFileSync(outPath, JSON.stringify({ results, thresholds, samples, jumpMs, zoomMs, errors, date: new Date().toISOString() }, null, 2));
summarize(`Load test: ${pageCount} pages, ${results.pdf.mb.toFixed(1)} MB`, rows);
process.exit(failed ? 1 : 0);
