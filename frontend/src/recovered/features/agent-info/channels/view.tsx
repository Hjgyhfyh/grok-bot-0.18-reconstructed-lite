import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  agentInfoChannelRowStatus,
  agentInfoChannelStatusDetail,
  agentInfoChannelStatusLabel,
  type AgentInfoChannelManifest,
  type AgentInfoChannelsController,
  type AgentInfoChannelConnection,
  type AgentInfoChannelsSnapshot
} from "./model";
import "./view.css";

// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#sha256=ef4e9831b65d39633f09c9ad0c083b98b7ebf52e3bb558182aee5bde31f876fa#byteOffset=2629126-2631040
// @evidence recovered/frontend/app/assets/index-UbX-y3il.js#sha256=80464803b50f478598080bdc1b91da3996c6b74168e2351ea26f620f2ec62ba5#byteOffset=3343445-3345790
// Mount contract for the immutable `_0n({agentId, labelledBy})` Channels tab.

export interface AgentInfoChannelsMount {
  readonly agentId: string;
  readonly labelledBy: string;
  readonly controller: AgentInfoChannelsController;
}

export type AgentInfoChannelsPanelProps = AgentInfoChannelsMount;

export function mountAgentInfoChannels(input: AgentInfoChannelsMount): ReactNode {
  return <AgentInfoChannelsPanel {...input} />;
}

export function AgentInfoChannelsPanel({ agentId, labelledBy, controller }: AgentInfoChannelsPanelProps) {
  const snapshot = useControllerSnapshot(controller);
  useEffect(() => {
    controller.setAgent(agentId);
    controller.open();
    return () => controller.close();
  }, [agentId, controller]);
  const view = snapshot.view ?? snapshot.previous;
  return <div aria-busy={snapshot.status === "loading"} className="sand-channels-tab">
    <p>Подключите помощника к мессенджеру, чтобы он мог разговаривать с людьми там. Можно просто попросить его в чате: «подключи меня к мессенджеру».</p>
    {snapshot.status === "failed" && view == null ? <div aria-live="polite" role="alert">
      <span>{snapshot.error instanceof Error ? snapshot.error.message : String(snapshot.error)}</span>
      <button onClick={() => void controller.retry().catch(() => {})} type="button">Повторить</button>
    </div> : null}
    {view == null ? null : view.manifests.length === 0
      ? <div><span>Подключений нет.</span></div>
      : <ul aria-labelledby={labelledBy}>
        {view.manifests.map((manifest) => <AgentInfoChannelRow controller={controller} connection={view.connections.find((item) => item.platform === manifest.platform)} key={manifest.platform} manifest={manifest} />)}
      </ul>}
  </div>;
}

function AgentInfoChannelRow({ controller, manifest, connection }: { controller: AgentInfoChannelsController; manifest: AgentInfoChannelManifest; connection?: AgentInfoChannelConnection }) {
  const status = agentInfoChannelRowStatus(manifest, connection);
  const [credentialOpen, setCredentialOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [token, setToken] = useState("");
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsTriggerRef = useRef<HTMLButtonElement>(null);
  const inputId = useId();
  const pending = controller.getSnapshot().pending;
  const busy = pending.some((key) => key.endsWith(`:${manifest.platform}`));
  const connected = status.kind === "connected" || status.kind === "connecting";
  const connect = () => {
    if (token.trim().length === 0 || busy) return;
    const value = token;
    setToken("");
    setCredentialOpen(false);
    void controller.connect(manifest.platform, value).catch(() => {});
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") { event.preventDefault(); connect(); }
  };
  const onActionsBlur = (event: FocusEvent<HTMLSpanElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setActionsOpen(false);
  };
  const detail = agentInfoChannelStatusDetail(status, manifest, connection);
  return <li aria-labelledby={inputId} className="sand-channel-row">
    <div>
      <span aria-hidden="true">◌</span>
      <span><span id={inputId}>{manifest.displayName}</span><small>{detail}</small></span>
    </div>
    {agentInfoChannelStatusLabel(status) == null ? null : <span aria-label={agentInfoChannelStatusLabel(status) as string} role="status">{agentInfoChannelStatusLabel(status)}</span>}
    <span>
      {status.kind === "available" || status.kind === "error" ? <>
        <button disabled={busy} onClick={() => setCredentialOpen(true)} type="button">{status.kind === "error" ? "Подключить заново" : "Подключить"}</button>
        {status.kind === "error" ? <button disabled={busy} onClick={() => void controller.disconnect(manifest.platform).catch(() => {})} type="button">Отключить</button> : null}
      </> : null}
      <span onBlur={onActionsBlur} onFocus={() => setActionsOpen(true)}>
        <button aria-expanded={actionsOpen} aria-haspopup="menu" aria-label="Действия с подключением" onClick={() => setActionsOpen((open) => !open)} ref={actionsTriggerRef} type="button">⋯</button>
      {actionsOpen ? <div aria-label="Действия с подключением" role="menu">
        <button onClick={() => { setActionsOpen(false); setGuideOpen(true); }} role="menuitem" type="button">Как подключить</button>
        {connected ? <>
          <button disabled={busy} onClick={() => { setActionsOpen(false); void controller.refresh(manifest.platform).catch(() => {}); }} role="menuitem" type="button">Обновить</button>
          <button disabled={busy} onClick={() => { setActionsOpen(false); void controller.disconnect(manifest.platform).catch(() => {}); }} role="menuitem" type="button">Отключить</button>
        </> : null}
      </div> : null}
      </span>
    </span>
    {credentialOpen && status.kind !== "coming-soon" ? <div>
      <input autoComplete="off" onChange={(event) => setToken(event.currentTarget.value)} onKeyDown={onKeyDown} placeholder={`Вставьте ${manifest.credentialLabel}`} spellCheck={false} type="password" value={token} />
      <small>Хранится в тайне, помощник его не видит.</small>
      <button onClick={() => { setToken(""); setCredentialOpen(false); }} type="button">Отмена</button>
      <button disabled={token.trim().length === 0 || busy} onClick={connect} type="button">Сохранить</button>
    </div> : null}
    {guideOpen ? <ChannelGuideDialog manifest={manifest} onClose={() => setGuideOpen(false)} restoreRef={actionsTriggerRef} statusKind={status.kind} /> : null}
  </li>;
}

function ChannelGuideDialog({ manifest, onClose, restoreRef, statusKind }: {
  manifest: AgentInfoChannelManifest;
  onClose(): void;
  restoreRef: React.RefObject<HTMLButtonElement | null>;
  statusKind: ReturnType<typeof agentInfoChannelRowStatus>["kind"];
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialogRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target === event.currentTarget) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
      restoreRef.current?.focus();
    };
  }, [onClose, restoreRef]);
  const isComingSoon = statusKind === "coming-soon";
  return <div aria-label={`Подключить ${manifest.displayName}`} aria-modal="true" className="sand-channel-guide-dialog" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }} ref={dialogRef} role="dialog" tabIndex={-1}>
    <h3>Подключить {manifest.displayName}</h3>
    <p>{channelGuideDescription(isComingSoon, manifest.displayName)}</p>
    {isComingSoon ? <strong>Скоро будет</strong> : <ol>{(manifest.setupGuide?.steps ?? manifest.connectGuide.split("\n").filter(Boolean).map((text): { readonly text: string } => ({ text }))).map((step, index) => <li key={`${step.text}:${index}`}>{step.text}{"code" in step && step.code != null ? <code>{step.code}</code> : null}</li>)}</ol>}
    <button onClick={onClose} type="button">Понятно</button>
  </div>;
}

function channelGuideDescription(isComingSoon: boolean, displayName: string): string {
  return isComingSoon ? `Подключить ${displayName} пока нельзя.` : `Чтобы подключить ${displayName}, выполните шаги ниже.`;
}

function useControllerSnapshot(controller: AgentInfoChannelsController): AgentInfoChannelsSnapshot {
  const [snapshot, setSnapshot] = useState(controller.getSnapshot);
  useEffect(() => controller.subscribe(() => setSnapshot(controller.getSnapshot())), [controller]);
  return snapshot;
}
