import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const [kind, ...rest] = process.argv.slice(2);
const opt = (name, fallback = undefined) => {
  const i = rest.indexOf(name);
  return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[i + 1] : fallback;
};
const flag = (name) => rest.includes(name);

if (!["security", "performance"].includes(kind) || !opt("--out")) {
  console.error("Usage: release-report.mjs <security|performance> --out <file.pdf> [options]");
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = opt("--version", "dev");
const commit = (opt("--commit", "") || "").slice(0, 7);
const repo = opt("--repo", "alxbdn/EzReader");
const today = new Date().toISOString().slice(0, 10);

const readJson = (path) => {
  if (!path || !existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
};
const readJsonLines = (path) => {
  if (!path || !existsSync(path)) return null;
  return readFileSync(path, "utf8").split("\n").flatMap((line) => {
    try { return line.trim().startsWith("{") ? [JSON.parse(line)] : []; } catch { return []; }
  });
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const plural = (n, word) => `${n} ${n === 1 ? word : word.endsWith("y") ? word.slice(0, -1) + "ies" : word + "s"}`;

const OK = "ok", WARN = "warn", FAIL = "fail", NA = "na";
const badge = (status, text) => `<span class="st st-${status}"><i></i>${esc(text)}</span>`;

function npmSection() {
  const audit = readJson(opt("--npm"));
  if (!audit?.metadata) return { row: ["SCA · JavaScript dependencies", "npm audit", "Not available", NA], details: [] };
  const v = audit.metadata.vulnerabilities;
  const deps = audit.metadata.dependencies?.total ?? 0;
  const details = Object.values(audit.vulnerabilities ?? {}).map((x) => ({
    id: (x.via ?? []).map((via) => (typeof via === "object" ? via.url?.split("/").pop() || via.title : via)).filter(Boolean).join(", "),
    component: `${x.name} ${x.range ?? ""}`,
    description: (x.via ?? []).map((via) => (typeof via === "object" ? via.title : `via ${via}`)).join("; "),
    severity: x.severity,
  }));
  const total = v.total ?? 0;
  const serious = (v.high ?? 0) + (v.critical ?? 0);
  return {
    row: ["SCA · JavaScript dependencies", "npm audit", `${plural(total, "vulnerability")} in ${deps} packages`, total === 0 ? OK : serious ? FAIL : WARN],
    details,
  };
}

function denySection() {
  const lines = readJsonLines(opt("--deny"));
  const summaryLine = lines?.find((l) => l.type === "summary");
  if (!summaryLine) return { row: ["SCA · Rust dependencies", "cargo deny (RustSec)", "Not available", NA], details: [] };
  const count = (key) => Object.values(summaryLine.fields).reduce((n, c) => n + (c?.[key] ?? 0), 0);
  const errors = count("errors"), warnings = count("warnings");
  const diags = lines.filter((l) => l.type === "diagnostic" && l.fields);
  const reasons = new Map();
  for (const d of diags.filter((d) => d.fields.code === "advisory-ignored")) {
    const labels = d.fields.labels ?? [];
    const id = labels.find((l) => /ignored/.test(l.message))?.span;
    const reason = labels.find((l) => /reason/.test(l.message))?.span;
    if (id) reasons.set(id, reason ?? "");
  }
  const details = diags.filter((d) => d.fields.advisory).map((d) => {
    const a = d.fields.advisory;
    const pkg = d.fields.graphs?.[0]?.Krate ?? {};
    const reason = reasons.get(a.id);
    return {
      id: a.id,
      component: [pkg.name ?? a.package, pkg.version].filter(Boolean).join(" "),
      description: a.title ?? d.fields.message,
      severity: reason !== undefined ? `Accepted: ${reason}` : d.fields.severity,
    };
  });
  for (const d of diags) {
    const f = d.fields;
    if (f.advisory || !["error", "warning"].includes(f.severity)) continue;
    const krate = f.graphs?.[0]?.Krate ?? {};
    details.push({
      id: f.code ?? "",
      component: [krate.name, krate.version].filter(Boolean).join(" "),
      description: f.message ?? "",
      severity: f.severity,
    });
  }
  const accepted = details.filter((d) => d.severity.startsWith("Accepted")).length;
  const parts = [errors ? plural(errors, "error") : "No blocking finding"];
  if (warnings) parts.push(plural(warnings, "warning"));
  if (accepted) parts.push(`${accepted} accepted with a reason`);
  return {
    row: ["SCA · Rust dependencies", "cargo deny: advisories, licenses, bans, sources", parts.join(" · "), errors ? FAIL : warnings ? WARN : OK],
    details,
  };
}

function codeqlSection() {
  const alerts = readJson(opt("--codeql"));
  if (!Array.isArray(alerts)) return { row: ["SAST", "CodeQL security-extended (TypeScript, Rust, workflows)", "Not available", NA], details: [] };
  const details = alerts.map((a) => ({
    id: a.rule?.id ?? "",
    component: `${a.most_recent_instance?.location?.path ?? ""}${a.most_recent_instance?.location?.start_line ? ":" + a.most_recent_instance.location.start_line : ""}`,
    description: a.rule?.description ?? a.most_recent_instance?.message?.text ?? "",
    severity: a.rule?.security_severity_level ?? a.rule?.severity ?? "",
  }));
  const serious = details.filter((d) => ["high", "critical", "error"].includes(d.severity)).length;
  return {
    row: ["SAST", "CodeQL security-extended (TypeScript, Rust, workflows)", alerts.length ? `${plural(alerts.length, "open alert")}` : "0 open alerts", alerts.length === 0 ? OK : serious ? FAIL : WARN],
    details,
  };
}

function fuzzSection() {
  const run = readJson(opt("--runs"));
  const jobs = run?.jobs ?? [];
  const fuzz = jobs.filter((j) => /fuzz/i.test(j.name));
  if (!fuzz.length) return { row: ["Dynamic (fuzzing)", "cargo-fuzz (libFuzzer)", "Not available", NA], runUrl: run?.html_url };
  const failed = fuzz.filter((j) => j.conclusion !== "success");
  const targets = fuzz.map((j) => j.name.replace(/^.*fuzz\s*/i, "")).join(", ");
  return {
    row: ["Dynamic (fuzzing)", `cargo-fuzz (libFuzzer): ${targets}`, failed.length ? `${plural(failed.length, "target")} failed` : "No crash, hang or memory blow-up", failed.length ? FAIL : OK],
    runUrl: run?.html_url,
  };
}

function securityHtml() {
  const npm = npmSection(), deny = denySection(), codeql = codeqlSection(), fuzz = fuzzSection();
  const rows = [npm.row, deny.row, codeql.row, fuzz.row];
  const worst = rows.some((r) => r[3] === FAIL) ? FAIL : rows.some((r) => r[3] === WARN || r[3] === NA) ? WARN : OK;
  const verdict = {
    [OK]: ["No known vulnerability", "Every check below passed on the code of this release."],
    [WARN]: ["No blocking finding", "Some checks reported warnings or could not run. The details are below."],
    [FAIL]: ["Findings to review", "At least one check reported a finding. The details are below."],
  }[worst];
  const details = [...npm.details, ...deny.details, ...codeql.details];
  const label = { [OK]: "OK", [WARN]: "Warning", [FAIL]: "Finding", [NA]: "Not run" };
  return page("Security report", verdict, worst, `
    <h2>Summary</h2>
    <table>
      <thead><tr><th>Type</th><th>Tool</th><th>Result for v${esc(version)}</th><th>Status</th></tr></thead>
      <tbody>${rows.map(([t, tool, res, st]) => `<tr><td>${esc(t)}</td><td>${esc(tool)}</td><td>${esc(res)}</td><td>${badge(st, label[st])}</td></tr>`).join("")}</tbody>
    </table>
    ${details.length ? `
    <h2>Findings</h2>
    <table>
      <thead><tr><th>Identifier</th><th>Component</th><th>Description</th><th>Severity</th></tr></thead>
      <tbody>${details.map((d) => `<tr><td class="mono">${esc(d.id)}</td><td>${esc(d.component)}</td><td>${esc(d.description)}</td><td>${esc(d.severity)}</td></tr>`).join("")}</tbody>
    </table>` : ""}
    <h2>Why fuzzing rather than a web DAST</h2>
    <p>A DAST scanner attacks a running web server. EzReader is a desktop app with no server and no network surface: what it receives from the outside is the files it opens. Its dynamic testing therefore feeds malformed PDFs and pictures to the Rust code that parses them (cargo-fuzz with libFuzzer), on every push and for 15 minutes every week.</p>
    <h2>Protections against hostile PDFs</h2>
    <table>
      <thead><tr><th>Measure</th><th>Effect</th></tr></thead>
      <tbody>
        <tr><td>PDF JavaScript disabled</td><td>Scripts embedded in a document never run.</td></tr>
        <tr><td>Strict Content Security Policy</td><td>The viewer cannot reach the network or load remote content.</td></tr>
        <tr><td>File access limited to the user's choice</td><td>The backend only reads and writes files opened or picked in a dialog.</td></tr>
        <tr><td>Minimal decoders</td><td>Only PNG, JPEG, WebP, GIF and BMP decoders are built in.</td></tr>
        <tr><td>Temporary copies removed</td><td>Decrypted and temporary files are deleted on close, or on the next start after a crash.</td></tr>
      </tbody>
    </table>
    <h2>Pipeline</h2>
    <p>These checks run in GitHub Actions on every push, every pull request and every week: npm audit, cargo deny, CodeQL in three languages, and fuzzing of three targets. Dependabot proposes dependency updates every week, and every third-party action is pinned to a commit.
    ${fuzz.runUrl ? `Run used for this report: <a href="${esc(fuzz.runUrl)}">${esc(fuzz.runUrl)}</a>.` : ""}</p>
    <p>To report a vulnerability privately, see <a href="https://github.com/${esc(repo)}/security/policy">SECURITY.md</a>.</p>
  `);
}

const PERF_ROWS = [
  ["open_ms", "Opening, until the first page is shown", "ms"],
  ["jump_p95_ms", "Jump to a page, 95th percentile", "ms"],
  ["zoom_p95_ms", "Zoom step, 95th percentile", "ms"],
  ["memory_opened_mb", "Memory once opened, all processes", "MB"],
  ["memory_peak_mb", "Peak memory", "MB"],
  ["memory_leak_per_round_mb", "Memory growth per round", "MB"],
  ["heap_leak_per_round_mb", "JavaScript heap growth per round", "MB"],
  ["dom_nodes_growth", "DOM nodes growth", ""],
  ["pdf_worker_heap_end_mb", "PDF worker heap at the end", "MB"],
  ["canvas_peak_mb", "Canvas memory, peak", "MB"],
  ["cpu_idle_percent", "CPU when idle", "%"],
  ["page_errors", "Page errors", ""],
];

function fmt(value, unit) {
  if (typeof value !== "number") return "–";
  if (unit === "ms" && value >= 1000) return `${(value / 1000).toFixed(1)} s`;
  const n = Math.abs(value) >= 100 || Number.isInteger(value) ? Math.round(value).toString() : value.toFixed(1);
  return unit ? `${n} ${unit}` : n;
}

function performanceHtml() {
  const data = readJson(opt("--results"));
  if (!data?.results) return performanceFailedHtml();
  const { results, thresholds = {} } = data;
  const rows = PERF_ROWS.filter(([key]) => typeof results[key] === "number").map(([key, label, unit]) => {
    const max = thresholds[key];
    const ok = max === undefined || results[key] <= max;
    return { label, value: fmt(results[key], unit), max: max === undefined ? "–" : fmt(max, unit), ok };
  });
  const failed = rows.filter((r) => !r.ok).length;
  const verdict = failed
    ? [`${plural(failed, "measure")} above the limit`, "The rows marked below went past their threshold."]
    : ["Every measure under its limit", "The same test runs on every pull request and blocks it at the first threshold exceeded."];
  const pages = results.pdf?.pages ?? "?";
  const mb = typeof results.pdf?.mb === "number" ? results.pdf.mb.toFixed(1) : "?";
  return page("Performance report", verdict, failed ? FAIL : OK, `
    <h2>Summary</h2>
    <p class="muted">PDF of ${esc(pages)} pages (${esc(mb)} MB), part of them scanned and read by the background OCR, opened, scrolled, jumped through and zoomed in a loop${results.test_seconds ? ` for ${Math.round(results.test_seconds)} s` : ""}.</p>
    <table>
      <thead><tr><th>Measure</th><th class="num">Result</th><th class="num">Limit</th><th>Status</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${esc(r.label)}</td><td class="num">${esc(r.value)}</td><td class="num">${esc(r.max)}</td><td>${badge(r.ok ? OK : FAIL, r.ok ? "OK" : "Above")}</td></tr>`).join("")}</tbody>
    </table>
    <h2>Method</h2>
    <p>The test builds the front end, generates the PDF, and drives the viewer in Chromium through Playwright while it measures memory (all processes, JavaScript heap, canvases), CPU, DOM size and response times. The thresholds live in <span class="mono">tests/perf/thresholds.json</span>; the full measurements are in the <span class="mono">perf-results.json</span> file of <span class="mono">ezreader-reports.zip</span>, attached to this release.</p>
  `);
}

function performanceFailedHtml() {
  const logPath = opt("--log");
  const log = logPath && existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  if (!log.trim()) {
    return page("Performance report", ["Not available", "The load test did not produce results for this release."], WARN, "");
  }
  const lines = log.trim().split("\n");
  const mbs = [...log.matchAll(/\]\s+(\d+)\s+MB/g)].map((m) => Number(m[1]));
  const peak = mbs.length ? Math.max(...mbs) : null;
  const crashed = /Target crashed|out of memory|OOM/i.test(log);
  const headline = crashed ? "The viewer crashed during the load test" : "The load test did not finish";
  const sub = peak ? `Memory reached ${fmt(peak, "MB")} before it stopped.` : "See the end of its log below.";
  return page("Performance report", [headline, sub], FAIL, `
    <h2>End of the load test log</h2>
    <pre class="log">${esc(lines.slice(-18).join("\n"))}</pre>
    <h2>Method</h2>
    <p>The test opens a PDF of 1,500 pages, part of them scanned, and scrolls, jumps through and zooms it in a loop in Chromium through Playwright, while it measures memory, CPU and response times. The thresholds live in <span class="mono">tests/perf/thresholds.json</span>.</p>
  `);
}

function page(title, [headline, sub], status, body) {
  const iconPath = join(root, "src-tauri/icons/128x128.png");
  const icon = existsSync(iconPath) ? `<img class="logo" src="data:image/png;base64,${readFileSync(iconPath).toString("base64")}" alt="">` : "";
  const meta = [`EzReader v${version}`, commit && `commit ${commit}`, "Tauri desktop app (Rust + TypeScript)", "Windows, macOS and Linux"].filter(Boolean).join(" · ");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>EzReader ${esc(title)} v${esc(version)}</title>
<style>
  @page { size: A4; margin: 16mm 15mm 18mm; }
  * { box-sizing: border-box; }
  body { font: 9.5pt/1.45 "Segoe UI", "Inter", "Helvetica Neue", Arial, sans-serif; color: #1f2328; margin: 0; }
  header { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
  .logo { width: 40px; height: 40px; border-radius: 9px; }
  h1 { font-size: 20pt; margin: 0; letter-spacing: -0.01em; }
  .meta { color: #656d76; font-size: 8.5pt; }
  .verdict { border-radius: 10px; padding: 10px 14px; margin: 0 0 16px; background: #f6f8fa; border-left: 4px solid var(--c); }
  .verdict strong { font-size: 11pt; display: flex; align-items: center; gap: 8px; }
  .verdict strong::before { content: ""; width: 10px; height: 10px; border-radius: 50%; background: var(--c); }
  .verdict p { margin: 3px 0 0; color: #424a53; }
  .v-ok { --c: #1a7f37; } .v-warn { --c: #bf8700; } .v-fail { --c: #d1242f; }
  h2 { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.06em; color: #424a53; margin: 18px 0 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 8.5pt; page-break-inside: auto; }
  tr { page-break-inside: avoid; }
  th { text-align: left; color: #656d76; font-weight: 600; border-bottom: 1px solid #d0d7de; padding: 5px 6px; }
  td { border-bottom: 1px solid #eaeef2; padding: 5px 6px; vertical-align: top; }
  .num { text-align: right; white-space: nowrap; }
  .mono { font-family: "Cascadia Mono", Consolas, "SFMono-Regular", monospace; font-size: 8pt; }
  .muted { color: #656d76; }
  .log { font: 7.5pt/1.4 "Cascadia Mono", Consolas, monospace; background: #f6f8fa; border-radius: 8px; padding: 10px 12px; white-space: pre-wrap; word-break: break-all; margin: 0; }
  .st { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
  .st i { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
  .st-ok i { background: #1a7f37; } .st-warn i { background: #bf8700; } .st-fail i { background: #d1242f; } .st-na i { background: #8c959f; }
  a { color: #c4314b; text-decoration: none; }
  p { margin: 0 0 6px; }
</style></head><body>
<header>${icon}<div><h1>${esc(title)}</h1><div class="meta">${esc(meta)}</div></div></header>
<div class="verdict v-${status === NA ? WARN : status}"><strong>${esc(headline)}</strong><p>${esc(sub)}</p></div>
${body}
</body></html>`;
}

const html = kind === "security" ? securityHtml() : performanceHtml();
const reportTitle = kind === "security" ? "security report" : "performance report";
const out = opt("--out");
if (flag("--html")) {
  writeFileSync(out, html);
} else {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const pg = await browser.newPage();
  await pg.setContent(html, { waitUntil: "load" });
  await pg.pdf({
    path: out, format: "A4", printBackground: true, displayHeaderFooter: true,
    headerTemplate: "<span></span>",
    footerTemplate: `<div style="width:100%;margin:0 15mm;display:flex;justify-content:space-between;font:7pt Arial,sans-serif;color:#8c959f"><span>EzReader v${esc(version)} · ${reportTitle} · generated by the release workflow</span><span>${today} · <span class="pageNumber"></span>/<span class="totalPages"></span></span></div>`,
  });
  await browser.close();
}
console.log(`Wrote ${out}`);
