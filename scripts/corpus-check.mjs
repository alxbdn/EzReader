// Second opinion on the files the PDF corpus test saved (src-tauri/src/corpus_tests.rs):
// lopdf wrote them and read them back, so a reader that shares its blind spots
// could miss damage. Each saved file must also pass `qpdf --check` and open in
// pdf.js (the engine that shows pages in EzReader) with every page parsed, and
// keep every word of the original page.
//
//   node scripts/corpus-check.mjs <EZREADER_CORPUS_OUT folder>

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: node scripts/corpus-check.mjs <folder>");
  process.exit(2);
}
const corpusDir = new URL("../src-tauri/tests/corpus/", import.meta.url).pathname;
const fixturesDir = new URL("../src-tauri/tests/fixtures/", import.meta.url).pathname;

/** Every saved file, with the file it was saved from. */
function savedFiles() {
  const found = [];
  for (const sub of readdirSync(outDir)) {
    const dir = join(outDir, sub);
    for (const name of readdirSync(dir)) {
      const m = /^(.*)\.(saved|resaved)\.pdf$/.exec(name);
      if (!m) continue;
      const stem = m[1];
      const original = [
        join(dir, `unlocked-${stem}.pdf`),
        join(dir, `${stem}.pdf`),
        join(corpusDir, `${stem}.pdf`),
        join(fixturesDir, `${stem}.pdf`),
      ].find(existsSync);
      found.push({ path: join(dir, name), original });
    }
  }
  return found;
}

function qpdfCheck(path) {
  try {
    execFileSync("qpdf", ["--check", path], { stdio: "pipe" });
    return null;
  } catch (e) {
    // Exit code 3: warnings only (qpdf fixed something while reading).
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
    return `qpdf --check failed (exit ${e.status}):\n${out.split("\n").slice(0, 8).join("\n")}`;
  }
}

/** The words of each page, or the error pdf.js stopped on. */
async function pageWords(path) {
  const task = getDocument({ data: new Uint8Array(readFileSync(path)), isEvalSupported: false, verbosity: 0, stopAtErrors: true });
  const doc = await task.promise;
  try {
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      await page.getOperatorList(); // parses the content streams, fonts and pictures
      const text = await page.getTextContent();
      pages.push(new Set(text.items.map((i) => i.str ?? "").join(" ").split(/\s+/).filter(Boolean)));
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

const files = savedFiles();
if (files.length === 0) {
  console.error(`no saved files in ${outDir}: did the corpus test run with EZREADER_CORPUS_OUT?`);
  process.exit(1);
}
const failures = [];
for (const { path, original } of files) {
  const name = basename(path);
  const qpdf = qpdfCheck(path);
  if (qpdf) failures.push(`${name}: ${qpdf}`);
  try {
    const saved = await pageWords(path);
    if (original) {
      const before = await pageWords(original);
      if (before.length !== saved.length) failures.push(`${name}: ${saved.length} pages in pdf.js, ${before.length} before`);
      before.forEach((words, i) => {
        const lost = [...words].filter((w) => !saved[i]?.has(w));
        if (lost.length) failures.push(`${name}: page ${i + 1} lost text: ${lost.slice(0, 5).join(" ")}`);
      });
    }
    console.log(`ok  ${name} (${saved.length} pages)`);
  } catch (e) {
    failures.push(`${name}: pdf.js cannot read it: ${e?.message ?? e}`);
  }
}
if (failures.length) {
  console.error(`\n${failures.length} problem(s):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`\n${files.length} saved files pass qpdf and pdf.js.`);
