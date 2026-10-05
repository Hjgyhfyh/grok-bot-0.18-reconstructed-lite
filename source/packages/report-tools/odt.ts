/**
 * Блоки отчёта → .odt.
 *
 * Требование ODF: часть `mimetype` идёт первой в архиве и без сжатия.
 * Нарушение этого правила означает, что LibreOffice не откроет файл, поэтому
 * порядок и флаг `stored` здесь не украшение, а часть формата.
 *
 * Порт: Graphite Lite `ai/tools.rs:983-1051`. Имя таблицы заменено с
 * «ТаблицаOtchet» на ASCII — кириллица в имени работает, но лишняя.
 */

import { type ReportBlock } from "./markdown-to-blocks.js";
import { writeZip } from "./zip.js";
import { xmlEscape } from "./xml.js";

const CONTENT_HEAD =
  "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
  + "<office:document-content"
  + " xmlns:office=\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\""
  + " xmlns:style=\"urn:oasis:names:tc:opendocument:xmlns:style:1.0\""
  + " xmlns:text=\"urn:oasis:names:tc:opendocument:xmlns:text:1.0\""
  + " xmlns:table=\"urn:oasis:names:tc:opendocument:xmlns:table:1.0\""
  + " xmlns:fo=\"urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0\""
  + " office:version=\"1.2\"><office:automatic-styles>"
  + "<style:style style:name=\"ReportTable\" style:family=\"table\">"
  + "<style:table-properties style:width=\"17cm\" table:border-model=\"collapsing\"/></style:style>"
  + "<style:style style:name=\"ReportCell\" style:family=\"table-cell\">"
  + "<style:table-cell-properties fo:border=\"0.5pt solid #808080\" fo:padding=\"0.05cm\"/></style:style>"
  + "</office:automatic-styles><office:body><office:text>";

const CONTENT_TAIL = "</office:text></office:body></office:document-content>";

const MANIFEST =
  "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
  + "<manifest:manifest xmlns:manifest=\"urn:oasis:names:tc:opendocument:xmlns:manifest:1.0\" manifest:version=\"1.2\">"
  + "<manifest:file-entry manifest:media-type=\"application/vnd.oasis.opendocument.text\" manifest:full-path=\"/\"/>"
  + "<manifest:file-entry manifest:media-type=\"text/xml\" manifest:full-path=\"content.xml\"/>"
  + "</manifest:manifest>";

const MIMETYPE = "application/vnd.oasis.opendocument.text";

const encoder = new TextEncoder();

export function blocksToOdt(blocks: readonly ReportBlock[]): Uint8Array {
  let body = "";
  for (const block of blocks) {
    if (block.kind === "heading") {
      body += `<text:h text:outline-level="${block.level}">${xmlEscape(block.text)}</text:h>`;
      continue;
    }
    if (block.kind === "paragraph") {
      for (const line of block.text.split("\n")) body += `<text:p>${xmlEscape(line)}</text:p>`;
      continue;
    }
    if (block.kind === "bullet") {
      body += `<text:p>• ${xmlEscape(block.text)}</text:p>`;
      continue;
    }
    body += "<table:table table:name=\"ReportTable\" table:style-name=\"ReportTable\">";
    // В ODF ячейки размещаются подряд и колонками не адресованы: короткая
    // строка из двух ячеек в таблице из трёх колонок сдвигает содержимое на
    // соседнюю графу — «День книги» встаёт на место «Срок». DOCX дополняет
    // строку пустыми ячейками, и ODT обязан делать то же самое.
    const columns = Math.max(1, ...block.rows.map((row) => row.length));
    for (const row of block.rows) {
      body += "<table:table-row>";
      for (let index = 0; index < columns; index += 1) {
        body += `<table:table-cell table:style-name="ReportCell"><text:p>${xmlEscape(row[index] ?? "")}</text:p></table:table-cell>`;
      }
      body += "</table:table-row>";
    }
    body += "</table:table>";
  }

  return writeZip([
    { name: "mimetype", data: encoder.encode(MIMETYPE), stored: true },
    { name: "content.xml", data: encoder.encode(`${CONTENT_HEAD}${body}${CONTENT_TAIL}`) },
    { name: "META-INF/manifest.xml", data: encoder.encode(MANIFEST) },
  ]);
}
