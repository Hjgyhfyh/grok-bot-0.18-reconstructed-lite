import { type ReactNode } from "react";
import type { TranscriptThreadSummary } from "./thread-summary-controller";

// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=5080561 (View thread copy/label)
// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=5080586 (sand-thread-affordance)

export interface ThreadAffordanceProps {
  readonly summary: TranscriptThreadSummary;
  readonly onOpen: (rootId: string) => void;
  readonly role?: string;
  readonly children?: ReactNode;
}

export function threadReplyLabel(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (last === 1 && lastTwo !== 11) return "1 ответ";
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return `${count} ответа`;
  return `${count} ответов`;
}

export function ThreadAffordance({ summary, onOpen, role, children }: ThreadAffordanceProps) {
  if (summary.rootId.length === 0 || !Number.isInteger(summary.count) || summary.count <= 0) return null;
  const countLabel = threadReplyLabel(summary.count);
  return (
    <button
      aria-label={`Открыть обсуждение: ${countLabel}`}
      className="sand-thread-affordance"
      data-role={role}
      onClick={() => onOpen(summary.rootId)}
      type="button"
    >
      {children ?? <span>Открыть обсуждение</span>}
      <span aria-hidden="true" className="sand-thread-affordance__count">{countLabel}</span>
    </button>
  );
}
