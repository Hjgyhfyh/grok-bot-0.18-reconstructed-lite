import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const dir = await mkdtemp(path.join(os.tmpdir(), "dbg-"));
const out = path.join(dir, "p.mjs");
await build({ entryPoints: ["source/host/extensions/attachments/document/pdf.ts"], outfile: out, bundle: true, format: "esm", platform: "node", target: "node22" });
const m = await import(pathToFileURL(out).href);

const L = (t) => Buffer.from(t, "latin1");
const STREAM = (b, f = "") => `<< /Length ${b.length}${f} >>\nstream\n${b}\nendstream`;
const HELVETICA = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
function assemble(objects) {
  let s = "%PDF-1.7\n";
  for (const [n, b] of objects) s += `${n} 0 obj\n${b}\nendobj\n`;
  s += `trailer\n<< /Size ${objects.length + 2} /Root 1 0 R >>\n%%EOF\n`;
  return new Uint8Array(L(s));
}

const texts = ["BT /F1 12 Tf (PAGE-ONE) Tj ET", "BT /F1 12 Tf (PAGE-TWO) Tj ET", "BT /F1 12 Tf (PAGE-THREE) Tj ET"];
const pageNums = [3, 4, 5];
const streamBase = 6;
const fontNum = 9;
const objects = [
  [1, "<< /Type /Catalog /Pages 2 0 R >>"],
  [2, "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>"],
  ...texts.map((t, i) => [pageNums[i], `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${streamBase + i} 0 R >>`]),
  ...texts.map((t, i) => [streamBase + i, STREAM(t)]),
  [fontNum, HELVETICA],
];
console.log("as listed:", JSON.stringify(m.pdfBytesToText(assemble(objects))));
const byNum = new Map(objects);
const order = [1, 2, 5, 4, 3, 6, 7, 8, 9];
const reordered = assemble(order.map((n) => byNum.get(n)));
console.log(Buffer.from(reordered).toString("latin1"));
console.log("reordered:", JSON.stringify(m.pdfBytesToText(reordered)));
await rm(dir, { recursive: true, force: true });