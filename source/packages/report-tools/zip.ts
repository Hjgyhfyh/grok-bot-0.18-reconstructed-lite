/**
 * Минимальный zip без внешних зависимостей: чтение и запись на node:zlib.
 *
 * Формат zip — это четыре подписи (local file header, central directory,
 * end of central directory) плюс CRC32. Отчёты — это 3–4 части, всё в памяти,
 * без zip64, без шифрования, без потоков, поэтому хватает этого слоя.
 *
 * Порядок записи значим для ODF: часть `mimetype` обязана идти первой и без
 * сжатия, иначе LibreOffice и Word не откроют файл.
 */

import { deflateRawSync, inflateRawSync } from "node:zlib";

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_SIGNATURE = 0x06054b50;

const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

/** Бит 11: имя части записано в UTF-8. */
const FLAG_UTF8_NAMES = 0x800;

const CRC32_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = -1;
  for (let index = 0; index < data.length; index += 1) {
    crc = CRC32_TABLE[(crc ^ (data[index] as number)) & 0xff] as number ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date: Date): { readonly time: number; readonly date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export interface ZipWriteEntry {
  readonly name: string;
  readonly data: Uint8Array;
  /** `true` — писать без сжатия (обязательно для `mimetype` в ODF). */
  readonly stored?: boolean;
}

export interface ZipReadEntry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly stored: boolean;
}

function deflateIfNeeded(data: Uint8Array, stored: boolean): Uint8Array {
  return stored ? data : new Uint8Array(deflateRawSync(data, { level: 9 }));
}

export function writeZip(entries: readonly ZipWriteEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(new Date());
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const stored = entry.stored === true;
    const nameBytes = encoder.encode(entry.name);
    const raw = entry.data;
    const payload = deflateIfNeeded(raw, stored);
    const method = stored ? METHOD_STORED : METHOD_DEFLATED;
    const checksum = crc32(raw);

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, LOCAL_HEADER_SIGNATURE, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, FLAG_UTF8_NAMES, true);
    localView.setUint16(8, method, true);
    localView.setUint16(10, time, true);
    localView.setUint16(12, date, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, payload.length, true);
    localView.setUint32(22, raw.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    const directory = new Uint8Array(46 + nameBytes.length);
    const directoryView = new DataView(directory.buffer);
    directoryView.setUint32(0, CENTRAL_HEADER_SIGNATURE, true);
    directoryView.setUint16(4, 20, true);
    directoryView.setUint16(6, 20, true);
    directoryView.setUint16(8, FLAG_UTF8_NAMES, true);
    directoryView.setUint16(10, method, true);
    directoryView.setUint16(12, time, true);
    directoryView.setUint16(14, date, true);
    directoryView.setUint32(16, checksum, true);
    directoryView.setUint32(20, payload.length, true);
    directoryView.setUint32(24, raw.length, true);
    directoryView.setUint16(28, nameBytes.length, true);
    directoryView.setUint16(30, 0, true);
    directoryView.setUint16(32, 0, true);
    directoryView.setUint16(34, 0, true);
    directoryView.setUint16(36, 0, true);
    directoryView.setUint32(38, 0, true);
    directoryView.setUint32(42, offset, true);
    directory.set(nameBytes, 46);

    parts.push(local, payload);
    central.push(directory);
    offset += local.length + payload.length;
  }

  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, END_OF_CENTRAL_SIGNATURE, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, central.length, true);
  endView.setUint16(10, central.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  const total =
    parts.reduce((sum, item) => sum + item.length, 0) + centralSize + end.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const piece of [...parts, ...central, end]) {
    out.set(piece, cursor);
    cursor += piece.length;
  }
  return out;
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_SIGNATURE) return offset;
  }
  return -1;
}

export function readZipEntries(buffer: Uint8Array): ZipReadEntry[] {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const endOffset = findEndOfCentralDirectory(view);
  if (endOffset < 0) throw new Error("zip: не найдена запись конца центрального каталога");
  const count = view.getUint16(endOffset + 10, true);
  let position = view.getUint32(endOffset + 16, true);
  const decoder = new TextDecoder();
  const entries: ZipReadEntry[] = [];

  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(position, true) !== CENTRAL_HEADER_SIGNATURE) {
      throw new Error("zip: запись центрального каталога повреждена");
    }
    const method = view.getUint16(position + 10, true);
    const compressedSize = view.getUint32(position + 20, true);
    const nameLength = view.getUint16(position + 28, true);
    const extraLength = view.getUint16(position + 30, true);
    const commentLength = view.getUint16(position + 32, true);
    const localOffset = view.getUint32(position + 42, true);
    const name = decoder.decode(buffer.subarray(position + 46, position + 46 + nameLength));

    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const payload = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === METHOD_STORED
      ? new Uint8Array(payload)
      : new Uint8Array(inflateRawSync(payload));
    entries.push({ name, data, stored: method === METHOD_STORED });
    position += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

export function readZipEntryText(buffer: Uint8Array, name: string): string {
  const entry = readZipEntries(buffer).find((item) => item.name === name);
  if (entry === undefined) throw new Error(`в образце нет части ${name}`);
  return new TextDecoder().decode(entry.data);
}
