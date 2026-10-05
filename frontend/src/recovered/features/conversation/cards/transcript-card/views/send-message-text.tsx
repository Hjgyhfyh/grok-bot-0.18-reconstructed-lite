import { hasDesktopBridge, type ReportsDesktopBridge } from "../../../../../contracts/desktop-bridge";
import { detectReportMessage } from "../../../../../../production/report-actions-model";
import { AssistantMessageContent } from "../../../workspace/transcript";
import { classifySendMessageTextUrl } from "../send-message-text";
import { projectLeafEntry, useTranscriptCardLeafProviders, type TranscriptCardLeafProps } from "./shared";
import LinkCardView from "./link-card";
import ReportActions from "./report-actions";

// @evidence src/app/dist/renderer/assets/view-BuhxMXKm.js#byteOffset=0 (send-message:text lazy leaf)
// @evidence src/app/dist/renderer/assets/view-BuhxMXKm.js#byteOffset=267 (content/images/streaming projection)
// @evidence src/app/dist/renderer/assets/view-BuhxMXKm.js#byteOffset=510 (ordinary message projection)
// @evidence src/app/dist/renderer/assets/view-BuhxMXKm.js#byteOffset=732 (URL-card fallback and trusted source)
// @evidence recovered/frontend/app/assets/view-BuhxMXKm.js#byteOffset=172 (Windows content/images/streaming projection)
// @evidence recovered/frontend/app/assets/view-BuhxMXKm.js#byteOffset=390 (Windows URL-card fallback)
// @evidence recovered/frontend/app/assets/view-BuhxMXKm.js#byteOffset=1210 (Windows trusted ordinary projection)

/**
 * Мост из окна. Отчёт сохраняется и печатается главным процессом, а агент в
 * этом не участвует: `report_preview` кладёт в ленту обычное сообщение, и
 * кнопки под ним — единственный способ получить файл без разговора с агентом.
 */
function reportBridge(): ReportsDesktopBridge | null {
  const desktop = (globalThis as { readonly desktop?: unknown }).desktop;
  if (!hasDesktopBridge(desktop)) return null;
  const reports = (desktop as { readonly reports?: unknown }).reports;
  if (typeof reports !== "object" || reports == null) return null;
  const candidate = reports as Partial<ReportsDesktopBridge>;
  return typeof candidate.saveFile === "function" && typeof candidate.print === "function"
    ? candidate as ReportsDesktopBridge
    : null;
}

export function SendMessageTextTranscriptCard(props: TranscriptCardLeafProps) {
  const entry = projectLeafEntry(props.entry);
  const providers = useTranscriptCardLeafProviders();
  if (entry == null || entry.message.type !== "text") return null;

  const message = entry.message;
  const streaming = entry.streaming === true;
  const url = classifySendMessageTextUrl({
    kind: "send-message",
    id: entry.id,
    message,
    ...(streaming ? { streaming } : {}),
  });
  if (url != null && providers?.urlCards != null) {
    return <LinkCardView isGroupStart={props.adjacency?.isGroupStart} provider={providers.urlCards} url={url} whenUnavailable="url-card" />;
  }

  // Пока текст дописывается, отчёта ещё нет: кнопки появляются у готового.
  const report = streaming ? null : detectReportMessage(message.content);

  return <div aria-label="Сообщение помощника" className="sand-message" data-group-start={props.adjacency?.isGroupStart || undefined} data-role="assistant" role="group">
    <AssistantMessageContent
      channel={message.channel}
      images={message.images}
      isSourceTrusted={true}
      isStreaming={streaming}
      text={message.content}
    />
    {report == null ? null : <ReportActions bridge={reportBridge()} report={report} />}
  </div>;
}

export default SendMessageTextTranscriptCard;