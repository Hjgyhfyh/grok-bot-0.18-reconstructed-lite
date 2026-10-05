import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = await mkdtemp(path.join(os.tmpdir(), "dbbot-qa-explore-"));

async function bundle(entry, out) {
  await build({ entryPoints: [entry], outfile: path.join(dir, out), bundle: true, format: "esm", platform: "node", target: "node22", logLevel: "silent" });
  return import(pathToFileURL(path.join(dir, out)).href);
}
const docs = await bundle(path.join(repoRoot, "source", "electron-main", "reports", "report-documents.ts"), "docs.mjs");
const port = await bundle(path.join(repoRoot, "source", "electron-main", "reports", "report-file-port.ts"), "port.mjs");
const model = await bundle(path.join(repoRoot, "frontend", "src", "production", "report-actions-model.ts"), "model.mjs");

const md = [
  "## 1. Отчёт о работе",
  "",
  "| Период | Читателей |",
  "| --- | --- |",
  "| 1 кв | 1240 |",
  "",
  "- Книговыдача выросла.",
].join("\n");

// ── структура zip ─────────────────────────────────────────────
function zipEntries(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let end = -1;
  for (let o = buf.length - 22; o >= 0; o--) { if (dv.getUint32(o, true) === 0x06054b50) { end = o; break; } }
  const count = dv.getUint16(end + 10, true);
  let pos = dv.getUint32(end + 16, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    const method = dv.getUint16(pos + 10, true);
    const csize = dv.getUint32(pos + 20, true);
    const nlen = dv.getUint16(pos + 28, true);
    const elen = dv.getUint16(pos + 30, true);
    const clen = dv.getUint16(pos + 32, true);
    const off = dv.getUint32(pos + 42, true);
    const name = new TextDecoder().decode(buf.subarray(pos + 46, pos + 46 + nlen));
    const localExtraLen = dv.getUint16(off + 28, true);
    out.push({ name, method, localOffset: off, localExtraLen });
    pos += 46 + nlen + elen + clen;
  }
  return out;
}

for (const f of ["docx", "odt", "rtf", "md"]) {
  const bytes = docs.reportDocumentBytes(md, f);
  const target = path.join(dir, `probe.${f}`);
  await writeFile(target, bytes);
  console.log(`\n=== ${f} size=${bytes.length}`);
  if (f === "docx" || f === "odt") {
    const onDisk = new Uint8Array(await readFile(target));
    console.log("entries:", JSON.stringify(zipEntries(onDisk)));
    const e0 = zipEntries(onDisk)[0];
    const localNameLen = new DataView(onDisk.buffer, onDisk.byteOffset, onDisk.byteLength).getUint16(e0.localOffset + 26, true);
    const payloadStart = e0.localOffset + 30 + localNameLen;
    console.log("first payload offset:", payloadStart, "first 40 bytes of payload:", new TextDecoder().decode(onDisk.subarray(payloadStart, payloadStart + 40)));
  } else {
    console.log("head:", new TextDecoder().decode(bytes.subarray(0, 60)));
  }
}

// ── имена файлов ──────────────────────────────────────────────
console.log("\n=== имена файлов");
for (const title of [
  "Отчёт за 2024/05", "Отчёт: май 2024", "Отчёт *проект*", "CON", "NUL", "PRN.docx",
  "Отчёт   за   2024", "   ", "...", "Отчёт.", "COM1",
  "A".repeat(200),
  "Отчёт 📊 за май",
]) {
  const n = docs.reportFileName(title, "docx");
  console.log(JSON.stringify(title.slice(0, 30)), "->", JSON.stringify(n.slice(0, 40)), "len=", n.length);
  const target = path.join(dir, n);
  try { await writeFile(target, new Uint8Array([1, 2, 3])); console.log("   записан: да"); }
  catch (e) { console.log("   записан: НЕТ code=", e.code, "msg=", e.message.slice(0, 90)); }
  finally { if (existsSync(target)) await rm(target, { force: true }); }
}

// ── сообщения об ошибках ───────────────────────────────────────
console.log("\n=== сообщения об ошибках");
const cases = {
  "файл открыт в Word (EBUSY)": Object.assign(new Error("EBUSY: resource busy or locked, open 'C:\\\\x.docx'"), { code: "EBUSY", path: "C:\\x.docx" }),
  "нет места (ENOSPC)": Object.assign(new Error("ENOSPC: no space left on disk, write 'C:\\\\x.docx'"), { code: "ENOSPC", path: "C:\\x.docx" }),
  "слишком длинное имя (ENAMETOOLONG)": Object.assign(new Error("ENAMETOOLONG: name too long, open 'C:\\\\x.docx'"), { code: "ENAMETOOLONG", path: "C:\\x.docx" }),
  "диск только для чтения (EROFS)": Object.assign(new Error("EROFS: read-only file system, open 'C:\\\\x.docx'"), { code: "EROFS", path: "C:\\x.docx" }),
  "зарезервированное имя (EINVAL)": Object.assign(new Error("EINVAL: invalid argument, open 'C:\\\\CON.docx'"), { code: "EINVAL", path: "C:\\CON.docx" }),
  "папки нет (ENOENT)": Object.assign(new Error("ENOENT: no such file or directory, open 'C:\\\\x.docx'"), { code: "ENOENT", path: "C:\\x.docx" }),
  "путь это папка (EISDIR)": Object.assign(new Error("EISDIR: illegal operation on a directory, open 'C:\\\\dir'"), { code: "EISDIR", path: "C:\\dir" }),
  "вирус заблокировал (EACCES)": Object.assign(new Error("EACCES: permission denied, open 'C:\\\\x.docx'"), { code: "EACCES", path: "C:\\x.docx" }),
};
for (const [name, err] of Object.entries(cases)) {
  console.log(`${name}\n   -> ${port.reportFileErrorMessage(err)}`);
}

// настоящая ошибка Node: пишем в несуществующую папку
try { await writeFile(path.join(dir, "нет-такой", "файл.docx"), new Uint8Array([1])); }
catch (e) {
  console.log("\nнастоящая ошибка fs/promises:", e.constructor.name, JSON.stringify({ code: e.code, syscall: e.syscall, path: e.path, message: e.message }));
  console.log("   -> reportFileErrorMessage:", port.reportFileErrorMessage(e));
}

// ── отмена печати ─────────────────────────────────────────────
console.log("\n=== отмена окна печати");
function makePort(over) {
  return port.createReportFilePort({
    getMainWindow: () => null,
    createHiddenWindow: () => null,
    showSaveDialog: async () => ({ canceled: true }),
    writeFile: async () => {},
    createPrintWindow: () => over.printWindow,
    downloadsDir: os.tmpdir(),
  });
}
const calls = [];
const cancelled = await makePort({
  printWindow: {
    webContents: {
      loadURL: async (u) => calls.push(["loadURL", u.length]),
      executeJavaScript: async () => true,
      print: (o, cb) => { calls.push(["print", o]); cb(false, "cancelled"); },
    },
    isDestroyed: () => false,
    destroy: () => calls.push(["destroy"]),
  },
}).printReport({ title: "Отчёт", markdown: md });
console.log("печать отменена пользователем ->", JSON.stringify(cancelled));
console.log("вызовы:", JSON.stringify(calls.map(([k, v]) => [k, typeof v === "object" ? v : v])));

const calls2 = [];
const failed = await makePort({
  printWindow: {
    webContents: {
      loadURL: async () => {},
      executeJavaScript: async () => true,
      print: (o, cb) => { cb(false, "Printer not found"); },
    },
    isDestroyed: () => false,
    destroy: () => {},
  },
}).printReport({ title: "Отчёт", markdown: md });
console.log("принтера нет ->", JSON.stringify(failed));

// ── формат по расширению, набранному руками ───────────────────
console.log("\n=== расширение, набранное руками");
for (const p of ["C:\\x.txt", "C:\\x", "C:\\x.DOCX", "C:\\x.doc", "C:\\x.rtf", "C:\\x.odt", "C:\\x.md", "C:\\x.odt.docx"]) {
  console.log(p, "->", docs.reportFormatFromPath(p));
}

// ── размер HTML для печати ────────────────────────────────────
const huge = Array.from({ length: 4000 }, (_, i) => `Строка номер ${i} с русским текстом для проверки размера печатной страницы`).join("\n\n");
const html = docs.reportPrintHtml("Большой отчёт", huge);
console.log("\n=== печать большого отчёта");
console.log("markdown chars:", huge.length, "html chars:", html.length, "data-url chars:", `data:text/html;charset=utf-8,${encodeURIComponent(html)}`.length);

// ── detectReportMessage ────────────────────────────────────────
console.log("\n=== detectReportMessage");
const samples = {
  "без заголовка (только таблица)": "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |",
  "короткий": "Готово.",
  "заголовок 2 символа": "ИТ\n\n## Раздел\n\n- пункт один\n- пункт два\n- пункт три",
  "заголовок 201 символ": "Я".repeat(201) + "\n\n## Раздел\n\n- пункт один\n- пункт два\n- пункт три тут",
  "заголовок 200 символов": "Я".repeat(200) + "\n\n## Раздел\n\n- пункт один\n- пункт два\n- пункт три тут",
  "обычный ответ со списком": "Я выполнил задачу. Вот что сделано:\n\n- открыл файл\n- посчитал строки\n- сохранил отчёт",
};
for (const [name, sample] of Object.entries(samples)) {
  const r = model.detectReportMessage(sample);
  console.log(`${name} -> ${r === null ? "НЕТ кнопок" : "кнопки есть, title=" + JSON.stringify(r.title.slice(0, 30))}`);
}

await rm(dir, { recursive: true, force: true });