/**
 * Чтение zip с ограничениями — «распакованная бомба» не должна съесть память.
 *
 * Отличие от `source/packages/report-tools/zip.ts`: там `readZipEntries`
 * распаковывает каждую часть без ограничений, а здесь три потолка: число частей,
 * размер одной части, суммарный распакованный объём. Плюс потолок на
 * `inflateRawSync` — он срабатывает раньше, чем распаковка успеет выделить
 * память.
 *
 * Архив читается в два шага: `planGuardedZipEntries` читает центральный каталог и
 * проверяет потолки, не распаковывая ни байта, а `readGuardedZipEntry` распаковывает
 * только ту часть, которую действительно попросили. Так фотография на 40 МБ внутри
 * `.docx` не распаковывается ради текста, а `.docx` на 47 МБ не обходится
 * распаковкой дважды.
 *
 * Поддерживаются методы 0 (без сжатия) и 8 (deflate). ZIP64, шифрование и
 * потоки не нужны: офисные файлы ими не пользуются.
 */

import { inflateRawSync } from "node:zlib";
import { DOCUMENT_BYTE_LIMIT } from "../../../../shared/media/attachment-limits.js";

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_SIGNATURE = 0x06054b50;
const ZIP64_MARKER = 0xffff;

const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

export interface ZipReadLimits {
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
  readonly maxTotalBytes: number;
}

export const DEFAULT_ZIP_READ_LIMITS: ZipReadLimits = {
  maxEntries: 2_000,
  maxEntryBytes: 48 * 1024 * 1024,
  // Суммарный потолок держим на уровне обещанного лимита документа: архив весом
  // 99 МБ обещан принимать, а 120 МБ — уже нет. Проверяется в `tests/qa-limits-abuse-1.test.mjs`.
  maxTotalBytes: DOCUMENT_BYTE_LIMIT,
};

export class ZipGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipGuardError";
  }
}

export interface GuardedZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly stored: boolean;
  readonly uncompressedSize: number;
}

/** Запись центрального каталога: что в архиве лежит, но ещё не распаковано. */
export interface GuardedZipPlanEntry {
  readonly name: string;
  readonly method: number;
  readonly dataStart: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

export interface GuardedZipPlan {
  readonly bytes: Uint8Array;
  readonly entries: readonly GuardedZipPlanEntry[];
  readonly limits: ZipReadLimits;
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_SIGNATURE) return offset;
  }
  return -1;
}

/**
 * Читает центральный каталог и проверяет потолки, ничего не распаковывая.
 * Бросает `ZipGuardError`, если архив превышает потолки или это не zip.
 */
export function planGuardedZipEntries(buffer: Uint8Array, limits: ZipReadLimits = DEFAULT_ZIP_READ_LIMITS): GuardedZipPlan {
  if (buffer.byteLength < 22) throw new ZipGuardError("Файл слишком мал, чтобы быть zip-архивом.");
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const endOffset = findEndOfCentralDirectory(view);
  if (endOffset < 0) throw new ZipGuardError("В файле нет записи конца центрального каталога zip — это не архив.");
  const count = view.getUint16(endOffset + 10, true);
  if (count === ZIP64_MARKER) throw new ZipGuardError("Это zip64; такой архив боту прочитать нечем.");
  if (count > limits.maxEntries) throw new ZipGuardError(`В архиве ${count} частей, а читать можно не больше ${limits.maxEntries}.`);
  let position = view.getUint32(endOffset + 16, true);
  const decoder = new TextDecoder();
  const planned: GuardedZipPlanEntry[] = [];
  let totalUncompressed = 0;

  for (let index = 0; index < count; index += 1) {
    if (position + 46 > view.byteLength || view.getUint32(position, true) !== CENTRAL_HEADER_SIGNATURE) {
      throw new ZipGuardError("Запись центрального каталога zip повреждена.");
    }
    const method = view.getUint16(position + 10, true);
    const compressedSize = view.getUint32(position + 20, true);
    const uncompressedSize = view.getUint32(position + 24, true);
    const nameLength = view.getUint16(position + 28, true);
    const extraLength = view.getUint16(position + 30, true);
    const commentLength = view.getUint16(position + 32, true);
    const localOffset = view.getUint32(position + 42, true);
    if (compressedSize === ZIP64_MARKER || uncompressedSize === ZIP64_MARKER) throw new ZipGuardError("Это zip64; такой архив боту прочитать нечем.");
    const name = decoder.decode(buffer.subarray(position + 46, position + 46 + nameLength));
    if (localOffset + 30 > view.byteLength || view.getUint32(localOffset, true) !== LOCAL_HEADER_SIGNATURE) {
      throw new ZipGuardError(`Заголовок части «${name}» повреждён.`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > buffer.byteLength) throw new ZipGuardError(`Часть «${name}» обрезана.`);
    // Размер проверяется и по заявленному в каталоге, и по фактическому для
    // метода 0: там `compressedSize` и есть размер части, а `inflateRawSync` не
    // вызывается и потолок не срабатывает. Раньше вредоносный архив с враньём в
    // каталоге проходил целиком в память.
    if (uncompressedSize > limits.maxEntryBytes || (method === METHOD_STORED && compressedSize > limits.maxEntryBytes)) {
      throw new ZipGuardError(`Часть «${name}» больше ${Math.round(limits.maxEntryBytes / (1024 * 1024))} МБ — бот не станет её разворачивать.`);
    }
    planned.push({ name, method, dataStart, compressedSize, uncompressedSize });
    totalUncompressed += Math.max(uncompressedSize, method === METHOD_STORED ? compressedSize : 0);
    if (totalUncompressed > limits.maxTotalBytes) {
      throw new ZipGuardError(`Архив распаковывается больше чем в ${Math.round(limits.maxTotalBytes / (1024 * 1024))} МБ — бот не станет его разворачивать.`);
    }
    position += 46 + nameLength + extraLength + commentLength;
  }
  return { bytes: buffer, entries: planned, limits };
}

/** Имена частей архива — без единого байта распакованных данных. */
export function guardedZipEntryNames(plan: GuardedZipPlan): string[] {
  return plan.entries.map((entry) => entry.name);
}

export function findGuardedZipEntry(plan: GuardedZipPlan, name: string): GuardedZipPlanEntry | null {
  return plan.entries.find((entry) => entry.name === name) ?? null;
}

/**
 * Распаковывает одну часть. Суммарный потолок считается по уже распакованному,
 * поэтому архив, который врёт о размерах, всё равно упирается в него.
 */
export function readGuardedZipEntry(plan: GuardedZipPlan, item: GuardedZipPlanEntry, inflatedSoFar = 0): GuardedZipEntry {
  const { limits } = plan;
  const payload = plan.bytes.subarray(item.dataStart, item.dataStart + item.compressedSize);
  let data: Uint8Array;
  if (item.method === METHOD_STORED) {
    data = new Uint8Array(payload);
  } else if (item.method === METHOD_DEFLATED) {
    try {
      // `inflateRawSync` отдаёт `Buffer`, а это и есть `Uint8Array`: оборачивать
      // его ещё раз значит держать в памяти две копии части по 48 МБ.
      data = inflateRawSync(payload, { maxOutputLength: limits.maxEntryBytes });
    } catch (error) {
      throw new ZipGuardError(`Часть «${item.name}» не распаковывается: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    throw new ZipGuardError(`Часть «${item.name}» сжата методом ${item.method}; бот читает только обычный zip.`);
  }
  if (inflatedSoFar + data.byteLength > limits.maxTotalBytes) throw new ZipGuardError("Архив распаковывается слишком много.");
  return { name: item.name, data, stored: item.method === METHOD_STORED, uncompressedSize: item.uncompressedSize };
}

/** Распаковывает части по именам. Порядок запроса сохраняется. */
export function readGuardedZipEntriesByName(plan: GuardedZipPlan, names: readonly string[]): GuardedZipEntry[] {
  const entries: GuardedZipEntry[] = [];
  let inflated = 0;
  for (const name of names) {
    const item = findGuardedZipEntry(plan, name);
    if (item == null) continue;
    const entry = readGuardedZipEntry(plan, item, inflated);
    inflated += entry.data.byteLength;
    entries.push(entry);
  }
  return entries;
}

/**
 * Возвращает части архива. Бросает `ZipGuardError`, если архив превышает
 * потолки или это не zip.
 */
export function readGuardedZipEntries(buffer: Uint8Array, limits: ZipReadLimits = DEFAULT_ZIP_READ_LIMITS): GuardedZipEntry[] {
  const plan = planGuardedZipEntries(buffer, limits);
  const entries: GuardedZipEntry[] = [];
  let inflated = 0;
  for (const item of plan.entries) {
    const entry = readGuardedZipEntry(plan, item, inflated);
    inflated += entry.data.byteLength;
    entries.push(entry);
  }
  return entries;
}

export function hasZipSignature(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
    && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
}
