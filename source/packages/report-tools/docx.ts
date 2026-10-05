/**
 * Блоки отчёта → .docx.
 *
 * Пишутся ровно три части: `[Content_Types].xml`, `_rels/.rels`,
 * `word/document.xml`. Ни `styles.xml`, ни `fontTable.xml` не нужны — Word
 * открывает такой файл, а отчёт всё равно потом заполняется через
 * `fill_sample`, где оформление берётся из настоящего образца.
 *
 * Порт: Graphite Lite `ai/tools.rs:881-981`.
 */

import { type ReportBlock } from "./markdown-to-blocks.js";
import { writeZip } from "./zip.js";
import { xmlEscape } from "./xml.js";

/** Минимальная ширина колонки, ниже которой Word переверстывает таблицу. */
const MIN_COLUMN_WIDTH = 400;

/**
 * Ширины колонок пропорциональны длине текста.
 *
 * Сумма обязана помещаться в полосу набора, иначе таблица уезжает за правое
 * поле и часть колонок не попадает на печать. Потолок `MIN_COLUMN_WIDTH`
 * поэтому ставится не всегда, а только когда он влезает: на 23 и более колонках
 * `23 * 400` уже шире полосы, и удержать потолок можно было бы только уронив
 * таблицу за поля. В этом случае колонки делят полосу поровну — узко, но целиком.
 */
export function columnWidths(
  rows: readonly (readonly string[])[],
  total: number,
): number[] {
  const columns = Math.max(1, ...rows.map((row) => row.length));
  const weights = new Array<number>(columns).fill(6);
  for (const row of rows) {
    row.forEach((cell, index) => {
      if (index < columns) {
        weights[index] = Math.max(weights[index] as number, Math.min([...cell].length, 60));
      }
    });
  }
  const sum = Math.max(1, weights.reduce((total, weight) => total + weight, 0));
  const widths = weights.map((weight) => Math.floor((weight * total) / sum));
  if (columns * MIN_COLUMN_WIDTH > total) return widths;
  return widths.map((width) => Math.max(width, MIN_COLUMN_WIDTH));
}

const DOCUMENT_HEAD =
  "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
  + "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>";

const DOCUMENT_TAIL =
  "<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/>"
  + "<w:pgMar w:top=\"1134\" w:right=\"850\" w:bottom=\"1134\" w:left=\"1701\"/></w:sectPr>"
  + "</w:body></w:document>";

const CONTENT_TYPES =
  "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
  + "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">"
  + "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>"
  + "<Default Extension=\"xml\" ContentType=\"application/xml\"/>"
  + "<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>"
  + "</Types>";

const ROOT_RELS =
  "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
  + "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
  + "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>"
  + "</Relationships>";

const encoder = new TextEncoder();

export function blocksToDocx(blocks: readonly ReportBlock[]): Uint8Array {
  let body = "";
  for (const block of blocks) {
    if (block.kind === "heading") {
      const size = block.level === 1 ? 32 : block.level === 2 ? 28 : 26;
      body += `<w:p><w:pPr><w:spacing w:before="160" w:after="80"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr><w:t xml:space="preserve">${xmlEscape(block.text)}</w:t></w:r></w:p>`;
      continue;
    }
    if (block.kind === "paragraph") {
      for (const line of block.text.split("\n")) {
        body += `<w:p><w:r><w:rPr><w:sz w:val="22"/></w:rPr><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`;
      }
      continue;
    }
    if (block.kind === "bullet") {
      body += `<w:p><w:pPr><w:ind w:left="360" w:hanging="180"/></w:pPr><w:r><w:rPr><w:sz w:val="22"/></w:rPr><w:t xml:space="preserve">• ${xmlEscape(block.text)}</w:t></w:r></w:p>`;
      continue;
    }
    const widths = columnWidths(block.rows, 9026);
    body += "<w:tbl><w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/><w:tblBorders>";
    for (const edge of ["top", "left", "bottom", "right", "insideH", "insideV"]) {
      body += `<w:${edge} w:val="single" w:sz="4" w:space="0" w:color="808080"/>`;
    }
    body += "</w:tblBorders></w:tblPr><w:tblGrid>";
    for (const width of widths) body += `<w:gridCol w:w="${width}"/>`;
    body += "</w:tblGrid>";
    block.rows.forEach((row, rowIndex) => {
      body += "<w:tr>";
      widths.forEach((width, columnIndex) => {
        const cell = row[columnIndex] ?? "";
        const bold = rowIndex === 0 ? "<w:b/>" : "";
        body += `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr><w:p><w:r><w:rPr>${bold}<w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${xmlEscape(cell)}</w:t></w:r></w:p></w:tc>`;
      });
      body += "</w:tr>";
    });
    body += "</w:tbl>";
  }

  return writeZip([
    { name: "[Content_Types].xml", data: encoder.encode(CONTENT_TYPES) },
    { name: "_rels/.rels", data: encoder.encode(ROOT_RELS) },
    { name: "word/document.xml", data: encoder.encode(`${DOCUMENT_HEAD}${body}${DOCUMENT_TAIL}`) },
  ]);
}
