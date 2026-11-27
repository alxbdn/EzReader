import { createServer } from "node:http";
import { createReadStream, readFileSync, statSync, existsSync, readdirSync, appendFileSync } from "node:fs";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

export const here = dirname(fileURLToPath(import.meta.url));

export function cliOptions(argv = process.argv.slice(2)) {
  const opt = (name, def) => { const i = argv.indexOf(name); return i === -1 ? def : argv[i + 1]; };
  const positional = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
  return { opt, positional };
}

export const readJson = (name) => JSON.parse(readFileSync(join(here, name), "utf8"));

export function builtApp() {
  const dist = resolve(here, "..", "..", "dist");
  if (!existsSync(join(dist, "index.html"))) throw new Error("dist/ is missing: run `npm run build` first");
  return dist;
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".pdf": "application/pdf", ".woff2": "font/woff2" };

export async function serveApp(dist, documentFor) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const document = documentFor(url);
    if (document === false) { res.writeHead(403).end(); return; }
    const file = document ?? join(dist, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
    if (document == null && !file.startsWith(dist)) { res.writeHead(403).end(); return; }
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
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

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

export function treeUsage(detail = false) {
  let pssKb = 0, ticks = 0;
  const parts = [];
  for (const pid of descendants(process.pid)) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
      ticks += Number(stat[11]) + Number(stat[12]);
      const m = /Pss:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"));
      if (m) pssKb += Number(m[1]);
      if (detail && m) parts.push(`${(/--type=([\w-]+)/.exec(readFileSync(`/proc/${pid}/cmdline`, "utf8")) ?? [, "main"])[1]}:${(Number(m[1]) / 1024).toFixed(0)}`);
    } catch {}
  }
  if (detail) console.log("    processes (MB): " + parts.join(" "));
  return { mb: pssKb / 1024, cpuSec: ticks / TICK, at: performance.now() };
}

export const cpuPercent = (a, b) => (100 * (b.cpuSec - a.cpuSec)) / ((b.at - a.at) / 1000);

export const percentile = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0;
};

export async function openApp(stub, stubArgs) {
  const browser = await chromium.launch({ args: ["--js-flags=--expose-gc"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5 });
  await context.addInitScript(stub, stubArgs);
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
    return { heapMb: m.JSHeapUsedSize / 1048576, nodes: m.Nodes, listeners: m.JSEventListeners, canvasMb, ...treeUsage() };
  };

  const samples = [];
  const sample = async (phase) => {
    const m = await metrics();
    samples.push({ phase, t: Math.round(m.at), ...m });
    console.log(`  [${phase}] ${m.mb.toFixed(0)} MB, heap ${m.heapMb.toFixed(0)} MB, canvases ${m.canvasMb.toFixed(0)} MB, ${m.nodes} nodes`);
    return m;
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

  const goTo = (n) => page.evaluate((n) => document.querySelector(`.page-wrapper[data-page="${n}"]`)?.scrollIntoView({ block: "start" }), n);

  return { browser, page, errors, samples, sample, pdfWorkerHeapMb, gc, settle, pageReady, goTo, close: () => browser.close() };
}

export function seededRandom(seed = 42) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
}

export function checkThresholds(results, thresholds, labelWidth) {
  const rows = [];
  for (const [key, value] of Object.entries(results)) {
    if (typeof value !== "number") continue;
    const max = thresholds[key];
    rows.push({ key, value, max, ok: max === undefined || value <= max });
  }
  console.log(`\n${"Result".padEnd(labelWidth + 2)}    Value      Limit`);
  for (const r of rows) console.log(`${r.ok ? " " : "✗"} ${r.key.padEnd(labelWidth)} ${r.value.toFixed(1).padStart(9)}  ${r.max ?? ""}`);
  return { rows, failed: rows.some((r) => !r.ok) };
}

export function summarize(title, rows, extra = "") {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  let md = `### ${title}\n\n| | Measure | Value | Limit |\n|---|---|---:|---:|\n`;
  for (const r of rows) md += `| ${r.ok ? "✅" : "❌"} | ${r.key} | ${r.value.toFixed(1)} | ${r.max ?? "–"} |\n`;
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + extra);
}
