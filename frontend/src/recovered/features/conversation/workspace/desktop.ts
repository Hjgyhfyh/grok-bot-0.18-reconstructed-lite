import type { DesktopBridge } from "../../../contracts/desktop-bridge";
import type { DraftAttachment } from "./model";
import { formatAttachmentTooLargeNotice } from "../../../../../../source/shared/media/attachment-limits";

// Immutable root: ef4e9831b65d39633f09c9ad0c083b98b7ebf52e3bb558182aee5bde31f876fa
// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=4778285 (D9n/F9n unnamed-file staging; UTF-8 region SHA-256 9d660cff2cc10e4b2aea9a6d72a5a5d69d1574a16b75cc7f7b0e5fd5700dd135)
// @evidence recovered/frontend/app/assets/index-UbX-y3il.js#byteOffset=5999839 (D9n/F9n unnamed-file staging; UTF-8 region SHA-256 916b05cca48cf1a047a3dd1c0845d899d3bfabf9d9e0e905b3721685f89d207d)

export interface StageableFile {
  name: string;
  size: number;
  type?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface StageFilesResult {
  attachments: DraftAttachment[];
  failures: StageFileFailure[];
  notice: string | null;
}

export type StageFileFailureReason = "empty" | "too-large" | "failed";

export interface StageFileFailure {
  name: string;
  reason: StageFileFailureReason;
}

function stageFileName(file: StageableFile): string {
  if (file.name.length > 0) return file.name;
  return file.type?.startsWith("image/") === true ? "image.png" : "file";
}

/**
 * Отказ по файлам — по-русски.
 *
 * Раньше здесь стоял английский текст с цифрой «max 25 MB» для всех файлов
 * без разбора: скан отчёта на 40 МБ отклонялся как слишком большой, хотя
 * документы принимаются до 100 МБ. Теперь цифру и объяснение даёт
 * `formatAttachmentTooLargeNotice` из `source/shared/media/attachment-limits` —
 * тот же код, по которому считается лимит при приёме файла.
 */
export function formatStageAttachmentFailureNotice(failures: readonly StageFileFailure[]): string | null {
  if (failures.length === 0) return null;
  const first = failures[0];
  if (failures.length === 1 && first != null) {
    if (first.reason === "too-large") return formatAttachmentTooLargeNotice(first.name);
    if (first.reason === "empty") return `Файл «${first.name}» пустой — прикрепить нечего. Пришлите файл с текстом.`;
    return `Не получилось прикрепить файл «${first.name}».`;
  }
  if (failures.every((failure) => failure.reason === "too-large"))
    return `Не прикрепились файлы (${failures.length}): ${failures.map((failure) => formatAttachmentTooLargeNotice(failure.name)).join(" ")}`;
  return `Не прикрепились файлы (${failures.length}). Попробуйте прикрепить их по одному.`;
}

export async function stageComposerFiles(
  bridge: Pick<DesktopBridge, "stageAttachmentBytes">,
  files: readonly StageableFile[]
): Promise<StageFilesResult> {
  const results = await Promise.all(files.map(async (file) => {
    const name = stageFileName(file);
    try {
      const result = await bridge.stageAttachmentBytes(name, new Uint8Array(await file.arrayBuffer()));
      return result.ok
        ? { kind: "attachment" as const, attachment: { path: result.path, name, size: file.size, ...(file.type ? { mimeType: file.type } : {}) } }
        : { kind: "failure" as const, failure: { name, reason: result.reason } };
    } catch {
      return { kind: "failure" as const, failure: { name, reason: "failed" as const } };
    }
  }));
  const attachments = results.flatMap((result) => result.kind === "attachment" ? [result.attachment] : []);
  const failures = results.flatMap((result) => result.kind === "failure" ? [result.failure] : []);
  return { attachments, failures, notice: formatStageAttachmentFailureNotice(failures) };
}

export function createFixtureAttachments(files: readonly StageableFile[]): DraftAttachment[] {
  return files.map((file) => ({
    path: `fixture://composer/${encodeURIComponent(file.name)}`,
    name: file.name,
    size: file.size,
    ...(file.type ? { mimeType: file.type } : {})
  }));
}

export async function commitComposerAttachments(
  bridge: Pick<DesktopBridge, "commitStagedAttachments">,
  attachments: readonly DraftAttachment[]
): Promise<DraftAttachment[]> {
  if (attachments.length === 0) return [];
  const committed = await bridge.commitStagedAttachments(
    attachments.map((attachment) => attachment.path),
    attachments.map((attachment) => attachment.name)
  );
  if (committed == null || committed.length !== attachments.length) throw new Error("Мост не смог сохранить подготовленные вложения.");
  return attachments.map((attachment, index) => ({ ...attachment, path: committed[index] ?? attachment.path }));
}
