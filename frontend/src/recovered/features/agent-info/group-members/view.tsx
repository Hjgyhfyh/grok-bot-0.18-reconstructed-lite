import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { AppAlertController } from "../../window-chrome/app-alert/controller";
import { GROUP_MAX_MEMBERS, type GroupMemberAgent, type GroupMembersProvider } from "./model";
import "./view.css";

// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=2726951 (group member DOM)
// @evidence recovered/frontend/app/assets/index-UbX-y3il.js#byteOffset=3477755 (Windows group member DOM)
// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=2734297 (shipped remove action DOM region; UTF-8 offset; SHA256 ef4e9831b65d39633f09c9ad0c083b98b7ebf52e3bb558182aee5bde31f876fa)
// @evidence recovered/frontend/app/assets/index-UbX-y3il.js#byteOffset=3478375 (Windows shipped remove action DOM region; UTF-8 offset; SHA256 80464803b50f478598080bdc1b91da3996c6b74168e2351ea26f620f2ec62ba5)
// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=2735108 (shipped add-member popover trigger region; UTF-8 offset; SHA256 ef4e9831b65d39633f09c9ad0c083b98b7ebf52e3bb558182aee5bde31f876fa)
// @evidence recovered/frontend/app/assets/index-UbX-y3il.js#byteOffset=3479294 (Windows shipped add-member popover trigger region; UTF-8 offset; SHA256 80464803b50f478598080bdc1b91da3996c6b74168e2351ea26f620f2ec62ba5)
// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=2735448 (shipped add-member popover content region; UTF-8 offset; SHA256 ef4e9831b65d39633f09c9ad0c083b98b7ebf52e3bb558182aee5bde31f876fa)
// @evidence recovered/frontend/app/assets/index-UbX-y3il.js#byteOffset=3479679 (Windows shipped add-member popover content region; UTF-8 offset; SHA256 80464803b50f478598080bdc1b91da3996c6b74168e2351ea26f620f2ec62ba5)
// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=2736205 (shipped group-members footer selector; UTF-8 offset; SHA256 ef4e9831b65d39633f09c9ad0c083b98b7ebf52e3bb558182aee5bde31f876fa)
// @evidence recovered/frontend/app/assets/index-UbX-y3il.js#byteOffset=3480600 (Windows shipped group-members footer selector; UTF-8 offset; SHA256 80464803b50f478598080bdc1b91da3996c6b74168e2351ea26f620f2ec62ba5)
// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=2733478 (shipped cap template; Sge=6 at UTF-8 offset 2297717; SHA256 ef4e9831b65d39633f09c9ad0c083b98b7ebf52e3bb558182aee5bde31f876fa)
// @evidence recovered/frontend/app/assets/index-UbX-y3il.js#byteOffset=3477363 (Windows shipped cap template; Sge=6 at UTF-8 offset 2914801; SHA256 80464803b50f478598080bdc1b91da3996c6b74168e2351ea26f620f2ec62ba5)

export interface GroupMembersPaneProps {
  readonly provider: GroupMembersProvider;
  readonly alert: AppAlertController;
  readonly agent: GroupMemberAgent;
  readonly accountGeneration: number;
  onOpenAgentChat(agentId: string): void;
}

export function GroupMembersPane({ provider, alert: _alert, agent, accountGeneration, onOpenAgentChat }: GroupMembersPaneProps) {
  const snapshot = useSyncExternalStore(provider.subscribe, provider.getSnapshot, provider.getSnapshot);
  const headingId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    provider.setContext(agent, accountGeneration);
  }, [provider, agent, accountGeneration]);

  useEffect(() => {
    if (!menuOpen) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>("button[role=menuitem]");
    first?.focus();
    const closeOnKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMenuOpen(false);
      triggerRef.current?.focus();
    };
    const closeOnPointerDown = (event: PointerEvent): void => {
      if (menuRef.current?.contains(event.target as Node) || triggerRef.current?.contains(event.target as Node)) return;
      setMenuOpen(false);
    };
    document.addEventListener("keydown", closeOnKeyDown);
    document.addEventListener("pointerdown", closeOnPointerDown, true);
    return () => {
      document.removeEventListener("keydown", closeOnKeyDown);
      document.removeEventListener("pointerdown", closeOnPointerDown, true);
    };
  }, [menuOpen]);

  if (snapshot.group == null) return null;
  const selectMember = (member: GroupMemberAgent): void => {
    setMenuOpen(false);
    triggerRef.current?.focus();
    provider.addMember(member.id).catch(() => {});
  };

  return (
    <section aria-label="Участники" className="sand-group-members-section" data-account-generation={snapshot.accountGeneration} data-pending={snapshot.pending?.kind}>
      <span className="sand-info-pane__section-heading" id={headingId}>Участники</span>
      <ul aria-labelledby={headingId} className="sand-group-members-list">
        {snapshot.members.map((member) => {
          const nameId = `${headingId}-${member.id}-name`;
          return <li aria-labelledby={nameId} className="sand-group-member-row" key={member.id}>
            <button aria-label={`Открыть диалог с ${member.name}`} className="sand-group-member-open" onClick={() => onOpenAgentChat(member.id)} type="button">
              <span className="sand-group-member-name" id={nameId}>{member.name}</span>
            </button>
            <button aria-label={`Убрать из группы: ${member.name}`} disabled={!snapshot.canRemove} onClick={() => { void provider.requestRemoveMember(member); }} type="button">Убрать</button>
          </li>;
        })}
        {snapshot.canAdd ? <li className="sand-group-member-add-row">
          <div ref={menuRef}>
            <button aria-expanded={menuOpen} aria-haspopup="menu" aria-label="Добавить участника" className="sand-group-member-add" disabled={snapshot.pending != null} onClick={() => setMenuOpen((open) => !open)} ref={triggerRef} type="button">Добавить участника</button>
            {menuOpen ? <div aria-label="Добавить участника" role="menu">
              {snapshot.candidates.map((candidate) => <button key={candidate.id} onClick={() => selectMember(candidate)} role="menuitem" type="button">{candidate.name}</button>)}
            </div> : null}
          </div>
        </li> : null}
      </ul>
      {snapshot.group.memberIds.length >= GROUP_MAX_MEMBERS ? <div className="sand-group-members-footer">{`В группе может быть до ${GROUP_MAX_MEMBERS} участников.`}</div> : snapshot.candidates.length === 0 ? <div className="sand-group-members-footer">Создайте ещё помощников, чтобы добавить их сюда.</div> : null}
    </section>
  );
}
