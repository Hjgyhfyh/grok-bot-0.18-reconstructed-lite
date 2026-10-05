import { attachmentExtension } from "./attachment-open-policy.js";

/**
 * Политика расширений вложений: разрешено всё, кроме того, что прочитать
 * нечем.
 *
 * Раньше здесь был белый список из ~90 текстовых расширений
 * (`TEXT_PREVIEWABLE_EXTENSIONS` в `attachment-preview.ts`). Из-за него
 * `.docx`, `.odt`, `.rtf`, `.pdf`, `.doc`, `.xls` и любой незнакомый файл
 * получали пометку «двоичный» и в модель не попадали ни байтом. Заведующая
 * библиотеки присылает ровно эти форматы, поэтому белый список отравлял всю
 * работу с отчётами.
 *
 * Теперь решение принимается по содержимому, а не по имени: движок
 * `source/host/extensions/attachments/document/text.ts` сначала смотрит на
 * сигнатуру, потом на расширение. Список ниже нужен только для двух вещей —
 * сказать пользователю по-русски, что за формат, и не тратить время на
 * заведомо нечитаемые файлы.
 */

export const ATTACHMENT_FORMATS = [
  "docx", "doc", "odt", "ods", "odp", "rtf", "xlsx", "xls", "pdf",
  "text", "markdown", "csv", "json", "xml", "html", "archive", "image", "media", "binary",
] as const;

export type AttachmentFormat = (typeof ATTACHMENT_FORMATS)[number];

const FORMAT_BY_EXTENSION: Readonly<Record<string, AttachmentFormat>> = {
  docx: "docx", docm: "docx", dotx: "docx", dotm: "docx", doc: "doc",
  odt: "odt", ott: "odt", ods: "ods", odp: "odp", otg: "odt",
  rtf: "rtf", rtx: "rtf",
  xlsx: "xlsx", xlsm: "xlsx", xltx: "xlsx", xltm: "xlsx", xls: "xls", xlsb: "xls", csv: "csv", tsv: "csv",
  pdf: "pdf",
  txt: "text", text: "text", log: "text", diff: "text", patch: "text", ini: "text", cfg: "text", conf: "text",
  md: "markdown", markdown: "markdown", mdx: "markdown", rst: "markdown", tex: "text",
  json: "json", jsonc: "json", json5: "json", ndjson: "json", yml: "text", yaml: "text", toml: "text",
  xml: "xml", htm: "html", html: "html", svg: "html", xhtml: "html",
  zip: "archive", "7z": "archive", rar: "archive", tar: "archive", gz: "archive", tgz: "archive",
  bz2: "archive", tbz2: "archive", xz: "archive", txz: "archive", zst: "archive", jar: "archive",
  jpg: "image", jpeg: "image", png: "image", gif: "image", bmp: "image", webp: "image", avif: "image",
  ico: "image", tif: "image", tiff: "image", heic: "image", heif: "image", raw: "image",
  mp4: "media", m4v: "media", mov: "media", webm: "media", ogv: "media",
  mp3: "media", wav: "media", ogg: "media", m4a: "media", flac: "media", aac: "media", opus: "media",
  exe: "binary", dll: "binary", msi: "binary", com: "binary", scr: "binary", sys: "binary",
  iso: "binary", img: "binary", bin: "binary", dat: "binary", db: "binary", sqlite: "binary",
};

/**
 * Запрещено только то, что прочитать нечем. Расширение отсутствует в списке —
 * значит файл попробуют прочитать по содержимому.
 *
 * `.7z` и `.rar` здесь нет намеренно: заведующая их присылает, они принимаются
 * и сохраняются как есть. Просто текст из них вытащить нечем — об этом
 * сообщается отдельно, по-русски.
 */
export const UNREADABLE_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  "exe", "dll", "msi", "com", "scr", "sys", "bat", "cmd", "vbs", "jse", "wsf", "wsh",
  "iso", "img", "vhd", "vhdx", "dmg", "pkg", "deb", "rpm", "msu",
  "bin", "dat", "db", "sqlite", "sqlite3", "mdb", "accdb", "dbf", "bak", "tmp", "swp",
  "so", "dylib", "a", "o", "obj", "lib", "pdb", "lnk", "reg", "pak", "ttc", "otf", "woff", "woff2",
]);

/** `true`, если расширение не запрещено policy-кой. Неизвестные расширения разрешены. */
export function isAttachmentReadableExtension(extension: string | null): boolean {
  if (extension == null || extension.length === 0) return true;
  return !UNREADABLE_ATTACHMENT_EXTENSIONS.has(extension);
}

/** Архивы, которые нечем распаковать: в проекте нет ни 7z, ни rar. */
const OPAQUE_ARCHIVE_EXTENSIONS: ReadonlySet<string> = new Set([
  "7z", "rar", "br", "zst", "xz", "lz", "lzma", "cab", "arj", "lzh", "ace", "zoo",
]);

export function isOpaqueArchiveExtension(extension: string | null): boolean {
  return extension != null && OPAQUE_ARCHIVE_EXTENSIONS.has(extension);
}

export function isArchiveExtension(extension: string | null): boolean {
  return extension != null && (extension === "zip" || isOpaqueArchiveExtension(extension));
}

export function attachmentFormatOf(nameOrPath: string): AttachmentFormat {
  const extension = attachmentExtension(nameOrPath);
  if (extension == null) return "binary";
  return FORMAT_BY_EXTENSION[extension] ?? "binary";
}

/** Человеческое имя формата по-русски — для сообщения об ошибке. */
export function describeAttachmentFormatRu(nameOrPath: string): string {
  const extension = attachmentExtension(nameOrPath);
  const format = attachmentFormatOf(nameOrPath);
  const withExtension = extension == null ? "без расширения" : `.${extension}`;
  switch (format) {
    case "docx": return `документ Word (${withExtension})`;
    case "doc": return `старый документ Word (${withExtension})`;
    case "odt": return `документ LibreOffice (${withExtension})`;
    case "ods": return `таблица LibreOffice (${withExtension})`;
    case "odp": return `презентация LibreOffice (${withExtension})`;
    case "rtf": return `документ RTF (${withExtension})`;
    case "xlsx": return `таблица Excel (${withExtension})`;
    case "xls": return `старая таблица Excel (${withExtension})`;
    case "pdf": return `документ PDF (${withExtension})`;
    case "text": return `текстовый файл (${withExtension})`;
    case "markdown": return `текст Markdown (${withExtension})`;
    case "csv": return `таблица в тексте (${withExtension})`;
    case "json": return `файл JSON (${withExtension})`;
    case "xml": return `файл XML (${withExtension})`;
    case "html": return `страница (${withExtension})`;
    case "archive": return `архив (${withExtension})`;
    case "image": return `изображение (${withExtension})`;
    case "media": return `аудио или видео (${withExtension})`;
    case "binary": return `неизвестный формат (${withExtension})`;
  }
}

/**
 * Название формата в родительном падеже — для оборота «в формате …».
 *
 * Раньше здесь стояло единственное `describeAttachmentFormatRu` в именительном
 * падеже, и отказ звучал как «он, скорее всего, в формате таблица в тексте» или
 * «в формате архив». По-русски так не говорят: после «в формате» нужен
 * родительный падеж — «в формате таблицы в тексте», «в формате архива».
 */
export function describeAttachmentFormatCaseRu(nameOrPath: string): string {
  const extension = attachmentExtension(nameOrPath);
  const format = attachmentFormatOf(nameOrPath);
  const withExtension = extension == null ? "без расширения" : `.${extension}`;
  switch (format) {
    case "docx": return `документа Word (${withExtension})`;
    case "doc": return `старого документа Word (${withExtension})`;
    case "odt": return `документа LibreOffice (${withExtension})`;
    case "ods": return `таблицы LibreOffice (${withExtension})`;
    case "odp": return `презентации LibreOffice (${withExtension})`;
    case "rtf": return `документа RTF (${withExtension})`;
    case "xlsx": return `таблицы Excel (${withExtension})`;
    case "xls": return `старой таблицы Excel (${withExtension})`;
    case "pdf": return `документа PDF (${withExtension})`;
    case "text": return `текстового файла (${withExtension})`;
    case "markdown": return `текста Markdown (${withExtension})`;
    case "csv": return `таблицы в тексте (${withExtension})`;
    case "json": return `файла JSON (${withExtension})`;
    case "xml": return `файла XML (${withExtension})`;
    case "html": return `страницы (${withExtension})`;
    case "archive": return `архива (${withExtension})`;
    case "image": return `изображения (${withExtension})`;
    case "media": return `аудио или видео (${withExtension})`;
    case "binary": return `неизвестного формата (${withExtension})`;
  }
}

/**
 * Сообщение об отказе. Формулировка из задания: «Не смог прочитать файл X —
 * он, скорее всего, в формате Y. Пришлите его в Word или в виде таблицы.»
 * `reason` вставляется перед последней фразой, чтобы отказ во всех случаях
 * заканчивался одним и тем же советом. Если `reason` уже содержит свой совет
 * («Пришлите его в виде .docx»), общая фраза не добавляется: один отказ не
 * должен просить два разных действия подряд.
 */
export function attachmentReadFailureNoticeRu(
  filename: string,
  nameOrPath = filename,
  reason?: string,
): string {
  const lead = `Не смог прочитать файл ${filename} — он, скорее всего, в формате ${describeAttachmentFormatCaseRu(nameOrPath)}.`;
  const tail = "Пришлите его в Word или в виде таблицы.";
  if (reason == null || reason.length === 0) return `${lead} ${tail}`;
  return reason.includes("Пришлите") ? `${lead} ${reason}` : `${lead} ${reason} ${tail}`;
}

/** Сообщение о том, что файл принят, но текста из него не получилось. */
export function attachmentWithoutTextNoticeRu(filename: string, formatLabel: string): string {
  return `Файл ${filename} принят, но это ${formatLabel} — из него нельзя вытащить текст. Пришлите его в Word, в Excel или в виде таблицы.`;
}
