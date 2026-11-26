import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const out = process.argv[2] ?? "big.pdf";
const pages = Number(process.argv[3] ?? 1500);
const scanEvery = Number(process.argv[4] ?? 5);

const objects = [];
const add = (body) => { objects.push(body); return objects.length; };
const stream = (dict, data) =>
  Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, Buffer.from("\nendstream")]);

const font = add(Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"));

const IW = 600, IH = 400;
const raw = Buffer.alloc((IW * 3 + 1) * IH);
for (let y = 0; y < IH; y++) {
  raw[y * (IW * 3 + 1)] = 0;
  for (let x = 0; x < IW; x++) {
    const o = y * (IW * 3 + 1) + 1 + x * 3;
    raw[o] = (x * 255 / IW) | 0;
    raw[o + 1] = (y * 255 / IH) | 0;
    raw[o + 2] = ((x ^ y) & 0xff);
  }
}
const image = add(stream(
  `/Type /XObject /Subtype /Image /Width ${IW} /Height ${IH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns ${IW} >>`,
  deflateSync(raw)));

const SW = 850, SH = 1200;
function scan(p) {
  const rows = Buffer.alloc((SW + 1) * SH, 0xf4);
  for (let y = 0; y < SH; y++) rows[y * (SW + 1)] = 0;
  for (let line = 0; line < 42; line++) {
    const top = 90 + line * 25;
    let x = 80;
    while (x < SW - 80) {
      const w = 20 + ((p * 31 + line * 17 + x) % 70);
      for (let y = top; y < top + 11; y++) rows.fill(0x30, y * (SW + 1) + 1 + x, y * (SW + 1) + 1 + Math.min(x + w, SW - 80));
      x += w + 9;
    }
  }
  return add(stream(`/Type /XObject /Subtype /Image /Width ${SW} /Height ${SH} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 1 /BitsPerComponent 8 /Columns ${SW} >>`, deflateSync(rows)));
}
const scans = new Map();
for (let p = 1; p <= pages; p++) if (p % scanEvery === 3 % scanEvery) scans.set(p, scan(p));

const pagesId = objects.length + 1 + pages * 2;
const kids = [];
const words = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua".split(" ");
for (let p = 1; p <= pages; p++) {
  if (scans.has(p)) {
    const contents = add(stream("", Buffer.from("q 595 0 0 842 0 0 cm /Scan Do Q\n")));
    const page = add(Buffer.from(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Contents ${contents} 0 R /Resources << /XObject << /Scan ${scans.get(p)} 0 R >> >> >>`));
    kids.push(`${page} 0 R`);
    continue;
  }
  let c = `BT /F1 20 Tf 56 790 Td (Page ${p} of ${pages}) Tj ET\n`;
  c += "BT /F1 10 Tf 56 760 Td 13 TL\n";
  for (let l = 0; l < 45; l++) {
    let line = "";
    for (let w = 0; w < 14; w++) line += words[(p * 7 + l * 3 + w) % words.length] + " ";
    c += `(${line}) '\n`;
  }
  c += "ET\n";
  c += "0.2 0.4 0.8 rg\n";
  for (let b = 0; b < 12; b++) c += `${60 + b * 40} 80 28 ${20 + ((p * 13 + b * 29) % 90)} re f\n`;
  c += "0.9 0.2 0.2 RG 1.5 w 60 140 m\n";
  for (let x = 1; x < 60; x++) c += `${60 + x * 8} ${140 + 30 * Math.sin((x + p) / 5)} l\n`;
  c += "S\n";
  if (p % 10 === 0) c += "q 300 0 0 200 260 160 cm /Im1 Do Q\n";
  const contents = add(stream("", Buffer.from(c)));
  const page = add(Buffer.from(
    `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Contents ${contents} 0 R ` +
    `/Resources << /Font << /F1 ${font} 0 R >> /XObject << /Im1 ${image} 0 R >> >> >>`));
  kids.push(`${page} 0 R`);
}
if (add(Buffer.from(`<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>`)) !== pagesId) throw new Error("ids");
const catalog = add(Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`));

const parts = [Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "latin1")];
let offset = parts[0].length;
const offsets = [];
objects.forEach((body, i) => {
  offsets.push(offset);
  const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from("\nendobj\n")]);
  parts.push(chunk);
  offset += chunk.length;
});
let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const o of offsets) xref += `${String(o).padStart(10, "0")} 00000 n \n`;
xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
parts.push(Buffer.from(xref));
writeFileSync(out, Buffer.concat(parts));
console.log(`${out}: ${pages} pages (${scans.size} scanned), ${(offset / 1e6).toFixed(1)} MB`);
