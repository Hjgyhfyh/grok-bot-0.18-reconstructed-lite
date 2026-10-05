/**
 * Минимальный zip без внешних зависимостей: чтение и запись на node:zlib.
 *
 * Формат zip — это четыре подписи (local file header, central directory,
 * end of central directory) плюс CRC32. Отчёты — это 3–4 части, всё в памяти,
 * без zip64, без шифрования, без потоков, поэтому хватает этого слоя.
 *
 * Порядок записи значим для ODF: часть `mimetype` обязана идти первой и без
 * сжатия, иначе LibreOffice и Word не откроют файл.
 *
 * ЧТЕНИЕ ОГРАНИЧЕНО. Образец приходит с диска пользователя, а не из вложения,
 * но упаковать его может любая программа-архиватор, и 100 МБ на диске после
 * распаковки — это сотни мегабайт в памяти. У заведующей 8 ГБ ОПЕРАТИВНОЙ ПАМЯТИ,
 * и три процесса Electron держат её заняты. Поэтому у чтения ровно те же
 * потолки, что у `source/host/extensions/attachments/document/zip-reader.ts`,
 * и добавочно сверка CRC32: Word файл с неверной контрольной суммой не откроет,
 * а бот обязан сказать об этом до того, как соберёт из него «готовый отчёт».
 *
 * Порядок проверок не менее важен, чем сами проверки: сначала всё, что можно
 * узнать из каталога (маркеры zip64, смещения, объявленные размеры), и только
 * потом распаковка. Тогда отказ приходит до выделения памяти.
 */

import { deflateRawSync, inflateRawSync } from "node:zlib";

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_SIGNATURE = 0x06054b50;

const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

/** Маркер zip64 в полях размера и числа частей. */
const ZIP64_MARKER = 0xffff;

/**
 * Потолки чтения. Числа те же, что у `zip-reader.ts`, с одной поправкой:
 * потолок на часть поднят до суммарного. Иначе образец `.docx` с фотографией
 * на 50 МБ — обычное дело — отказывался бы, хотя в сумме он укладывается.
 */
export const ZIP_READ_LIMITS = {
  maxEntries: 2_000,
  maxEntryBytes: 96 * 1024 * 1024,
  maxTotalBytes: 96 * 1024 * 1024,
} as const;

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

function zipError(message: string): Error {
  return new Error(`zip: ${message}`);
}

function megabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

interface PlannedEntry {
  readonly name: string;
  readonly method: number;
  /** Смещение локального заголовка: им же заканчивается область предыдущей части. */
  readonly localOffset: number;
  readonly dataStart: number;
  readonly compressedSize: number;
  readonly checksum: number;
}

export function readZipEntries(buffer: Uint8Array): ZipReadEntry[] {
  if (buffer.byteLength < 22) throw zipError("файл слишком мал, чтобы быть zip-архивом");
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const endOffset = findEndOfCentralDirectory(view);
  if (endOffset < 0) throw zipError("не найдена запись конца центрального каталога");
  const count = view.getUint16(endOffset + 10, true);
  if (count === ZIP64_MARKER) throw zipError("это zip64; такой архив прочитать нечем");
  if (count > ZIP_READ_LIMITS.maxEntries) {
    throw zipError(`в архиве ${count} частей, а читать можно не больше ${ZIP_READ_LIMITS.maxEntries}`);
  }
  const centralOffset = view.getUint32(endOffset + 16, true);
  if (centralOffset + 46 > view.byteLength || view.getUint32(centralOffset, true) !== CENTRAL_HEADER_SIGNATURE) {
    throw zipError("запись центрального каталога повреждена");
  }

  let position = centralOffset;
  const decoder = new TextDecoder();
  const planned: PlannedEntry[] = [];
  let declaredTotal = 0;

  for (let index = 0; index < count; index += 1) {
    if (position + 46 > view.byteLength) throw zipError("запись центрального каталога повреждена: файл обрезан");
    if (view.getUint32(position, true) !== CENTRAL_HEADER_SIGNATURE) {
      throw zipError(`запись ${index} центрального каталога повреждена`);
    }
    const method = view.getUint16(position + 10, true);
    const checksum = view.getUint32(position + 16, true);
    const compressedSize = view.getUint32(position + 20, true);
    const declaredSize = view.getUint32(position + 24, true);
    const nameLength = view.getUint16(position + 28, true);
    const extraLength = view.getUint16(position + 30, true);
    const commentLength = view.getUint16(position + 32, true);
    const localOffset = view.getUint32(position + 42, true);
    if (compressedSize === ZIP64_MARKER || declaredSize === ZIP64_MARKER) {
      throw zipError("это zip64; такой архив прочитать нечем");
    }
    if (position + 46 + nameLength > view.byteLength) throw zipError("запись центрального каталога повреждена: имя обрезано");
    const name = decoder.decode(buffer.subarray(position + 46, position + 46 + nameLength));
    // Смещение локального заголовка приходит из каталога, а каталог может быть
    // собран из обрывка файла. Без проверки подписи `subarray` отдаёт пустой
    // массив, и часть молча читается пустой — образец «прочитался», отчёт
    // собрался, а в нём нет ни одной строки.
    if (localOffset + 30 > view.byteLength || view.getUint32(localOffset, true) !== LOCAL_HEADER_SIGNATURE) {
      throw zipError(`заголовок части «${name}» повреждён: смещение ${localOffset} не указывает на локальный заголовок`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart > view.byteLength) throw zipError(`часть «${name}» обрезана`);
    planned.push({ name, method, localOffset, dataStart, compressedSize, checksum });
    declaredTotal += declaredSize;
    position += 46 + nameLength + extraLength + commentLength;
  }

  // Первый рубеж: объявленные размеры. Каталог может соврать, но когда он не
  // врёт, бомба отсекается до того, как что-то распаковано.
  if (declaredTotal > ZIP_READ_LIMITS.maxTotalBytes) {
    throw zipError(`архив распаковывается больше чем в ${megabytes(ZIP_READ_LIMITS.maxTotalBytes)} МБ — столько бот не разворачивает`);
  }

  // Граница физических данных части: локальный заголовок следующей части,
  // начало центрального каталога или конец файла. Каталог вправе объявить длину
  // больше фактической, и для части без сжатия `subarray` тогда молча отдаст
  // байты соседней части — такой .docx Word называет повреждённым.
  const entries: ZipReadEntry[] = [];
  let inflatedTotal = 0;

  for (const item of planned) {
    let limit = Math.min(view.byteLength, centralOffset);
    for (const other of planned) {
      if (other.localOffset > item.localOffset && other.localOffset < limit) limit = other.localOffset;
    }
    const available = Math.max(0, limit - item.dataStart);
    const payload = buffer.subarray(item.dataStart, item.dataStart + Math.min(item.compressedSize, available));
    let data: Uint8Array;
    if (item.method === METHOD_STORED) {
      data = new Uint8Array(payload);
    } else if (item.method === METHOD_DEFLATED) {
      try {
        data = new Uint8Array(inflateRawSync(payload, { maxOutputLength: ZIP_READ_LIMITS.maxEntryBytes }));
      } catch (error) {
        throw zipError(`часть «${item.name}» не распаковывается: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      throw zipError(`часть «${item.name}» сжата методом ${item.method}; читается только обычный zip`);
    }
    if (data.byteLength > ZIP_READ_LIMITS.maxEntryBytes) {
      throw zipError(`часть «${item.name}» больше ${megabytes(ZIP_READ_LIMITS.maxEntryBytes)} МБ — столько бот не разворачивает`);
    }
    inflatedTotal += data.byteLength;
    if (inflatedTotal > ZIP_READ_LIMITS.maxTotalBytes) {
      throw zipError(`архив распаковывается больше чем в ${megabytes(ZIP_READ_LIMITS.maxTotalBytes)} МБ — столько бот не разворачивает`);
    }
    // Единственный честный признак того, что архив битый, — это CRC32.
    // Без сверки Word такой файл не откроет, а бот соберёт из него отчёт
    // и рапортует пользователю, что всё в порядке.
    if (crc32(data) !== item.checksum) {
      throw zipError(`часть «${item.name}» повреждена: контрольная сумма не сходится`);
    }
    entries.push({ name: item.name, data, stored: item.method === METHOD_STORED });
  }

  return entries;
}

export function readZipEntryText(buffer: Uint8Array, name: string): string {
  const entry = readZipEntries(buffer).find((item) => item.name === name);
  if (entry === undefined) throw new Error(`в образце нет части ${name}`);
  return new TextDecoder().decode(entry.data);
}
