/**
 * Инструменты агента для работы с отчётами.
 *
 * Здесь нет ни pandoc, ни LibreOffice, ни mammoth: RTF, DOCX и ODT пишутся
 * строками, а zip собирается на `node:zlib`. Единственный формат, который
 * приходится упаковывать, — это DOCX и ODT.
 *
 * Порядок снизу вверх: `zip` → `markdown-to-blocks` → `rtf`/`docx`/`odt` →
 * `fill-sample` → `skills` → `tools`.
 */

export {
  crc32,
  readZipEntries,
  readZipEntryText,
  writeZip,
  type ZipReadEntry,
  type ZipWriteEntry,
} from "./zip.js";

export {
  reportBlocks,
  stripBoldMarkers,
  type ReportBlock,
} from "./markdown-to-blocks.js";

export { blocksToRtf, markdownToRtf, rtfEscape, rtfInline } from "./rtf.js";
export { blocksToDocx, columnWidths } from "./docx.js";
export { blocksToOdt } from "./odt.js";
export { stripXmlTags, xmlEscape, xmlEscapeText, xmlUnescape } from "./xml.js";

export {
  braceBalance,
  extractDocxRows,
  extractOdtRows,
  fillDocument,
  formatOf,
  parseMarkdownSections,
  rewriteDocxCell,
  rewriteOdtCell,
  rewriteRtfCell,
  rtfEscapeText,
  rtfText,
  tokenizeRtf,
  type DocFormat,
  type FillDocumentInput,
  type FillReport,
} from "./fill-sample.js";

export {
  findSkill,
  formatSkillList,
  listSkills,
  parseSkill,
  readSkill,
  type SkillSummary,
} from "./skills.js";

export {
  buildReportPreviewUpdate,
  createReportTools,
  fillSample,
  fillSampleParameters,
  reportPreview,
  reportPreviewParameters,
  reportsDir,
  safeFileName,
  saveReport,
  saveReportParameters,
  skillListParameters,
  skillReadParameters,
  REPORTS_DIR_NAME,
  type FillSampleInput,
  type ReportFormat,
  type ReportPreviewInput,
  type ReportPreviewUpdate,
  type ReportTool,
  type ReportToolsDependencies,
  type SaveReportInput,
} from "./tools.js";
