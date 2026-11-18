import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import convert from "ast-v8-to-istanbul";
import libCoverage from "istanbul-lib-coverage";
import { parseAstAsync } from "vitest/node";

const root = resolve(import.meta.dirname, "..", "..");
const [unitJson, out] = process.argv.slice(2);
const files = JSON.parse(readFileSync(unitJson, "utf8"));
const raw = join(import.meta.dirname, "raw");
const norm = (p) => p.replace(/\\/g, "/").toLowerCase();
const unitKey = new Map(Object.keys(files).map((k) => [norm(k), k]));

const col = (c) => (Number.isFinite(c) ? c : "end");
const loc = (l) => `${l.start.line}:${col(l.start.column)}-${l.end.line}:${col(l.end.column)}`;
const keys = {
  s: ["statementMap", (x) => loc(x)],
  f: ["fnMap", (x) => loc(x.loc)],
  b: ["branchMap", (x) => x.locations.map(loc).join("|")],
};

function add(target, extra) {
  if (!target || Object.keys(target.statementMap).length === 0) return extra;
  for (const [hits, [mapName, keyOf]] of Object.entries(keys)) {
    const index = new Map(Object.entries(target[mapName]).map(([k, v]) => [keyOf(v), k]));
    let next = Object.keys(target[mapName]).length;
    for (const [k, v] of Object.entries(extra[mapName])) {
      let id = index.get(keyOf(v));
      if (id === undefined) {
        id = String(next++);
        index.set(keyOf(v), id);
        target[mapName][id] = v;
        target[hits][id] = hits === "b" ? extra.b[k].map(() => 0) : 0;
      }
      target[hits][id] = hits === "b" ? target.b[id].map((n, i) => n + (extra.b[k][i] ?? 0)) : target[hits][id] + extra[hits][k];
    }
  }
  return target;
}

for (const name of existsSync(raw) ? readdirSync(raw) : []) {
  for (const entry of JSON.parse(readFileSync(join(raw, name), "utf8"))) {
    const file = join(root, decodeURIComponent(new URL(entry.url).pathname));
    if (!unitKey.has(norm(file))) continue;
    const inline = entry.source.match(/\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,(\S+)\s*$/);
    if (!inline) continue;
    const sourceMap = JSON.parse(Buffer.from(inline[1], "base64").toString("utf8"));
    sourceMap.sources = sourceMap.sources.map(() => file);
    const data = await convert({
      code: entry.source,
      sourceMap,
      coverage: { url: pathToFileURL(file).href, functions: entry.functions },
      ast: parseAstAsync(entry.source),
    });
    for (const [path, cov] of Object.entries(data)) {
      const key = unitKey.get(norm(path.startsWith("file:") ? fileURLToPath(path) : path));
      if (key) files[key] = add(files[key], { ...cov, path: key });
    }
  }
}

const map = libCoverage.createCoverageMap(files);
const total = map.getCoverageSummary().toJSON();
writeFileSync(out, JSON.stringify({ total }, null, 2));
const pct = (k) => `${total[k].pct}% (${total[k].covered}/${total[k].total})`;
console.log(`Statements: ${pct("statements")}\nLines: ${pct("lines")}\nBranches: ${pct("branches")}\nFunctions: ${pct("functions")}`);

if (process.env.COVERAGE_FILES) {
  const rows = map.files().map((f) => {
    const s = map.fileCoverageFor(f).toSummary().statements;
    return [s.total - s.covered, s.pct, s.total, norm(f).slice(norm(root).length + 1)];
  });
  rows.sort((a, b) => b[0] - a[0]);
  for (const r of rows.slice(0, Number(process.env.COVERAGE_FILES))) console.log(r.join("\t"));
}

if (process.env.COVERAGE_FUNCS) {
  const fc = map.fileCoverageFor(unitKey.get(norm(join(root, process.env.COVERAGE_FUNCS)))).toJSON();
  const rows = Object.entries(fc.fnMap)
    .filter(([k]) => fc.f[k] === 0)
    .map(([, fn]) => [Object.values(fc.statementMap).filter((s) => s.start.line >= fn.loc.start.line && s.end.line <= fn.loc.end.line).length, fn.loc.start.line, fn.name])
    .sort((a, b) => b[0] - a[0]);
  for (const r of rows.slice(0, 40)) console.log(r.join("\t"));
}
