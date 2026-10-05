import { readFile, stat } from "node:fs/promises";
import { basename, posix } from "node:path";
import { videoMimeFromPath } from "../../../shared/media/image-mime.js";
import type { TransferBox } from "../../box/box-transfer.js";
import { extractAttachmentText } from "./document/text.js";

export const SAND_BOX_STAGE_MAX_BYTES = 50 * 1024 * 1024;
export const SAND_BOX_UPLOADS_DIR = "/workspace/uploads";
/** Суффикс текстовой копии документа. `Read` открывает её как обычный текст. */
export const SAND_BOX_STAGED_TEXT_SUFFIX = ".txt";
export interface BoxStagingDependencies<Context> {
  readonly ctx: Context;
  readonly box: TransferBox & { runState(ctx: Context, agentId: string): Promise<string> };
  readonly resolveOwnerDir: (path: string) => string | null;
  readonly upload: (ctx: Context, box: BoxStagingDependencies<Context>["box"], agentId: string, files: readonly { boxPath: string; data: Uint8Array }[]) => Promise<void>;
}

/**
 * Кладёт вложения в рабочий корень агента и возвращает карту «путь на машине →
 * путь в box».
 *
 * Зачем рядом с самим файлом кладётся ещё и `.txt`: агент читает вложение
 * инструментом `Read`, а `Read` отдаёт байты как есть — из `.docx` или `.rtf`
 * приходит мусор, и модель строит отчёт по мусору. Текстовая копия читается
 * как текст, поэтому именно на неё показывается заметка о вложенных файлах.
 * Если текст извлечь не удалось, показывается путь к самому файлу.
 */
export async function stageAttachmentsIntoBox<Context>(deps: BoxStagingDependencies<Context>, agentId: string, hostPaths: readonly string[]): Promise<Map<string, string>> {
  const staged = new Map<string, string>();
  if (hostPaths.length === 0) return staged;
  try { if (await deps.box.runState(deps.ctx, agentId) !== "running") return staged; } catch { return staged; }
  const uploads: { boxPath: string; data: Uint8Array }[] = [];
  for (const hostPath of hostPaths) {
    if (videoMimeFromPath(hostPath) !== undefined || deps.resolveOwnerDir(hostPath) == null) continue;
    try {
      const info = await stat(hostPath); if (!info.isFile() || info.size > SAND_BOX_STAGE_MAX_BYTES) continue;
      const data = new Uint8Array(await readFile(hostPath));
      const boxPath = posix.join(SAND_BOX_UPLOADS_DIR, basename(hostPath));
      uploads.push({ boxPath, data });
      const textPath = `${boxPath}${SAND_BOX_STAGED_TEXT_SUFFIX}`;
      const text = extractAttachmentText(hostPath, data);
      if (text.status === "text" || text.status === "partial") {
        uploads.push({ boxPath: textPath, data: new TextEncoder().encode(text.text) });
        staged.set(hostPath, textPath);
        continue;
      }
      staged.set(hostPath, boxPath);
    } catch {}
  }
  if (uploads.length === 0) return staged;
  try { await deps.upload(deps.ctx, deps.box, agentId, uploads); } catch { return new Map(); }
  return staged;
}
