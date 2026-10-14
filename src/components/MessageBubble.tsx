import { Fragment, type ReactNode } from "react";
import { t } from "../i18n";

export interface MessageBubbleProps {
  role: "user" | "assistant";
  content: string;
  /** Пузырь ещё дописывается стримом — небольшой визуальный маркер. */
  streaming?: boolean;
}

/**
 * Пузырь сообщения. Свой — без подписи, ответ — с подписью «Помощник».
 * Markdown-базово: fenced-блоки с тремя бэктиками, списки (маркированные
 * и нумерованные), параграфы; инлайн: `код`, жирный, курсив.
 * HTML не рендерится — React экранирует.
 */
export default function MessageBubble({ role, content, streaming }: MessageBubbleProps) {
  return (
    <div className={`msg${role === "user" ? " msg--user" : ""}`}>
      {role === "assistant" && <span className="msg-name">{t("aiName")}</span>}
      <div className="msg-body">
        {role === "assistant" ? renderMarkdown(content) : content}
        {streaming && <span className="msg-cursor" aria-hidden="true" />}
      </div>
    </div>
  );
}

/* ---------- мини-markdown: блоки ---------- */

interface Block {
  kind: "text" | "code";
  lang?: string;
  text: string;
}

function splitBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  const re = /```([\w+-]*)\r?\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m.index > last) blocks.push({ kind: "text", text: src.slice(last, m.index) });
    blocks.push({ kind: "code", lang: m[1] || undefined, text: m[2].replace(/\n$/, "") });
    last = re.lastIndex;
  }
  if (last < src.length) blocks.push({ kind: "text", text: src.slice(last) });
  return blocks;
}

function renderMarkdown(src: string): ReactNode {
  return splitBlocks(src).map((b, i) =>
    b.kind === "code" ? (
      <pre key={i} className="md-code">
        {b.lang && <div className="md-code-lang">{b.lang}</div>}
        <code>{b.text}</code>
      </pre>
    ) : (
      <Fragment key={i}>{renderTextBlock(b.text, `b${i}`)}</Fragment>
    ),
  );
}

/** Текстовый блок: параграфы по пустой строке, внутри — строки и списки. */
function renderTextBlock(text: string, keyPrefix: string): ReactNode[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.replace(/^\n+|\n+$/g, ""))
    .filter(Boolean)
    .map((para, pi) => {
      const lines = para.split("\n");
      const listItems: { ordered: boolean; body: string }[] = [];
      const plain: string[] = [];
      let allOrdered = true;
      for (const ln of lines) {
        const m = ln.match(/^\s*(?:([-•*])|(\d+)[.)])\s+(.*)$/);
        if (m) {
          listItems.push({ ordered: !m[1], body: m[3] });
          if (m[1]) allOrdered = false;
        } else {
          plain.push(ln);
        }
      }
      // Смешанный параграф (текст + список) редок — список отдаём списком,
      // остальные строки собираем в обычный параграф перед ним.
      const out: ReactNode[] = [];
      if (plain.length) {
        out.push(
          <p key={`${keyPrefix}-p${pi}`} className="md-p">
            {renderInlineLines(plain, `${keyPrefix}-p${pi}`)}
          </p>,
        );
      }
      if (listItems.length) {
        const items = listItems.map((it, li) => (
          <li key={li}>{renderInline(it.body, `${keyPrefix}-p${pi}-li${li}`)}</li>
        ));
        out.push(
          allOrdered ? (
            <ol key={`${keyPrefix}-l${pi}`} className="md-list">
              {items}
            </ol>
          ) : (
            <ul key={`${keyPrefix}-l${pi}`} className="md-list">
              {items}
            </ul>
          ),
        );
      }
      return <Fragment key={`${keyPrefix}-g${pi}`}>{out}</Fragment>;
    });
}

function renderInlineLines(lines: string[], keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  lines.forEach((ln, i) => {
    if (i > 0) out.push(<br key={`${keyPrefix}-br${i}`} />);
    out.push(<Fragment key={`${keyPrefix}-l${i}`}>{renderInline(ln, `${keyPrefix}-l${i}`)}</Fragment>);
  });
  return out;
}

/* ---------- мини-markdown: инлайн ---------- */

const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyPrefix}-i${k++}`;
    if (m[1]) out.push(<code key={key} className="md-code-inline">{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key}>{m[2].slice(2, -2)}</strong>);
    else if (m[3]) out.push(<em key={key}>{m[3].slice(1, -1)}</em>);
    last = INLINE_RE.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
