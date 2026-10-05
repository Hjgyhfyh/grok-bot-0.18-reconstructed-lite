// Генератор тестового PDF для проверки просмотра PDF в живом приложении.
//
// Файл собирается здесь, а не хранится в репозитории бинарником: его структура
// видна целиком, и он не зависит от чужого источника. Проверяет ровно то, что
// проверяет просмотрщик, — pdf.js должен разобрать документ, назвать число
// страниц и отрисовать страницу на canvas.
//
// Запуск: node scripts/make-probe-pdf.mjs [путь]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { repoRoot } from "./lib/config.mjs";

// Текст только латиницей: Helvetica кодируется WinAnsi, и кириллица в нём
// не представима — pdf.js вернул бы вместо букв мусор.
const LINES = [
  "DB Bot Lite - PDF viewer probe",
  "Built by scripts/make-probe-pdf.mjs.",
  "Pages: 1. Font: Helvetica 18.",
];

function escapePdfText(value) {
  return value.replace(/([\\()])/g, "\\$1");
}

function buildPdf() {
  const content = [
    "BT",
    "/F1 18 Tf",
    "72 720 Td",
    "20 TL",
    ...LINES.map(line => `(${escapePdfText(line)}) Tj T*`),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const parts = ["%PDF-1.4\n"];
  const offsets = [];
  let position = parts[0].length;
  objects.forEach((body, index) => {
    const chunk = `${index + 1} 0 obj\n${body}\nendobj\n`;
    offsets.push(position);
    parts.push(chunk);
    position += chunk.length;
  });
  const xrefOffset = position;
  const xref = [
    `xref\n0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n `),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  ].join("\n");
  return Buffer.from(`${parts.join("")}${xref}`, "latin1");
}

const target = path.resolve(process.argv[2] ?? path.join(repoRoot, "tests", "fixtures", "probe-preview.pdf"));
mkdirSync(path.dirname(target), { recursive: true });
const bytes = buildPdf();
writeFileSync(target, bytes);
console.log(`${target}: ${bytes.byteLength} байт`);