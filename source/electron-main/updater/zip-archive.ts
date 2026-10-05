// Распаковка ZIP без сторонних пакетов.
//
// Зачем свой распаковщик, если в проекте есть `tar` и `builder-util-runtime`:
// обновление приезжает на компьютер, где живут 8 ГБ RAM и нет Node.js.
// Распаковка идёт в процессе приложения, поэтому лишняя зависимость — это
// лишние мегабайты в бандле main и лишняя точка отказа при запуске.
//
// Файл читается кусками через файловый дескриптор, а не целиком: пакет весит
// около 300 МБ, и держать его в памяти вместе с распакованными файлами на
// машине пользователя нельзя.

import { mkdir, open, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const ZIP64_MARKER = 0xffffffff;
const ZIP64_MARKER_16 = 0xffff;
const MAX_COMMENT_LENGTH = 0xffff;
const END_OF_CENTRAL_DIRECTORY_LENGTH = 22;

export interface ZipEntry {
  readonly name: string;
  readonly compressionMethod: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly crc32: number;
  readonly localHeaderOffset: number;
}

export interface ZipExtractionReport {
  readonly files: number;
  readonly bytes: number;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index] ?? 0;
    const table = CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0;
    crc = table ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Имя записи, приведённое к безопасному относительному пути.
 *
 * `..`, абсолютные пути и буквы диска отбрасываются: архив приходит из сети,
 * а содержимое распаковывается поверх каталога программы.
 */
export function resolveSafeEntryPath(targetRoot: string, entryName: string): string | null {
  const normalized = entryName.replace(/\\/g, "/");
  if (normalized.length === 0) return null;
  if (normalized.startsWith("/") || /^[a-z]:/i.test(normalized)) return null;
  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null;
    segments.push(segment);
  }
  if (segments.length === 0) return null;
  const resolved = path.resolve(targetRoot, ...segments);
  const root = path.resolve(targetRoot);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

async function readExactly(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new Error(`ZIP: не хватило данных по смещению ${position}`);
  return buffer;
}

/**
 * Читает оглавление архива. Возвращает записи в порядке архива.
 *
 * ZIP64 не поддерживается: пакет приложения меньше 4 ГБ, а поддержка
 * потребовала бы ещё одного формата заголовков ради случая, который
 * для этого архива не наступает.
 */
export async function readZipEntries(archivePath: string): Promise<ZipEntry[]> {
  const handle = await open(archivePath, "r");
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, END_OF_CENTRAL_DIRECTORY_LENGTH + MAX_COMMENT_LENGTH);
    const tail = await readExactly(handle, size - tailLength, tailLength);
    let endOffset = -1;
    for (let index = tail.length - END_OF_CENTRAL_DIRECTORY_LENGTH; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === END_OF_CENTRAL_DIRECTORY) {
        endOffset = index;
        break;
      }
    }
    if (endOffset < 0) throw new Error("ZIP: не найден конец оглавления");
    const entryCount = tail.readUInt16LE(endOffset + 10);
    const directorySize = tail.readUInt32LE(endOffset + 12);
    const directoryOffset = tail.readUInt32LE(endOffset + 16);
    if (directoryOffset === ZIP64_MARKER || directorySize === ZIP64_MARKER || entryCount === ZIP64_MARKER_16) {
      throw new Error("ZIP: архив в формате ZIP64 не поддерживается");
    }
    const directory = await readExactly(handle, directoryOffset, directorySize);
    const entries: ZipEntry[] = [];
    let cursor = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (directory.readUInt32LE(cursor) !== CENTRAL_FILE_HEADER) {
        throw new Error(`ZIP: повреждена запись оглавления №${index}`);
      }
      const compressionMethod = directory.readUInt16LE(cursor + 10);
      const crc = directory.readUInt32LE(cursor + 16);
      const compressedSize = directory.readUInt32LE(cursor + 20);
      const uncompressedSize = directory.readUInt32LE(cursor + 24);
      const nameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      const localHeaderOffset = directory.readUInt32LE(cursor + 42);
      const name = directory.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
      entries.push({
        name,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        crc32: crc,
        localHeaderOffset,
      });
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

async function readEntryData(handle: FileHandle, entry: ZipEntry): Promise<Buffer> {
  const header = await readExactly(handle, entry.localHeaderOffset, 30);
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const raw = await readExactly(handle, dataOffset, entry.compressedSize);
  if (entry.compressionMethod === 0) return raw;
  if (entry.compressionMethod !== 8) {
    throw new Error(`ZIP: неподдерживаемый метод сжатия ${entry.compressionMethod} в ${entry.name}`);
  }
  const inflated = inflateRawSync(raw, { maxOutputLength: entry.uncompressedSize });
  if (entry.crc32 !== 0 && crc32(inflated) !== entry.crc32) {
    throw new Error(`ZIP: не совпала контрольная сумма ${entry.name}`);
  }
  return inflated;
}

/**
 * Распаковывает архив в `targetRoot`. Возвращает число файлов и байт.
 *
 * Каталоги внутри архива создаются по мере надобности: пустая директория без
 * файлов ничего не меняет в пакете.
 */
export async function extractZipFile(archivePath: string, targetRoot: string): Promise<ZipExtractionReport> {
  const entries = await readZipEntries(archivePath);
  const handle = await open(archivePath, "r");
  let files = 0;
  let bytes = 0;
  try {
    for (const entry of entries) {
      const destination = resolveSafeEntryPath(targetRoot, entry.name);
      if (destination === null) {
        if (entry.name.endsWith("/")) continue;
        throw new Error(`ZIP: небезопасное имя записи ${entry.name}`);
      }
      const data = await readEntryData(handle, entry);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, data);
      files += 1;
      bytes += data.length;
    }
  } finally {
    await handle.close();
  }
  return { files, bytes };
}
