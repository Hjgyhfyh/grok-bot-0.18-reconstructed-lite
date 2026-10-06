// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#L499 bytes 2328200,2331500,2332789,2337409,2346511,2346725,2346952,2347189,2347629,2347841,2347970; sha256=ef4e9831b65d39633f09c9ad0c083b98b7ebf52e3bb558182aee5bde31f876fa
import type { ReactNode } from "react";
import { SandMenuContent, SandMenuItem, SandMenuRoot, SandMenuTrigger } from "../../../ui/sand-floating-primitives";

/**
 * Меню внизу боковой панели.
 *
 * Что было. Меню аккаунта Cursor: выход из аккаунта, «Войти», «Расход за
 * месяц», «Расход за неделю», «Входит в тариф», «Изменить лимит», «Центр
 * помощи» (адрес cursor.com), ссылка на приложение для iPhone и отправка
 * отзыва в чужую службу. Пользователь — заведующая детской библиотеки; аккаунт
 * Cursor ей никто не заводил. Ни один из этих пунктов не приводил к работе
 * программы, а три из них уводили данные пользователя наружу.
 *
 * Что осталось. Два пункта, которые открывают экран внутри программы.
 *
 * Обход моста тоже удалён: прежний `getAvatar` ходил за аватаром на
 * cursor.com, а поле «Введите ваше имя» писало имя в чужую учётную запись.
 */
export interface AccountMenuProps {
  accountLabel: string;
  displayName: string;
  isOpen: boolean;
  updatePill?: ReactNode;
  onOpenAbout(): void;
  onOpenSettings(): void;
  onOpenChange(open: boolean): void;
  labels: {
    about: string;
    settings: string;
  };
}

export function AccountMenu({
  accountLabel,
  displayName,
  isOpen,
  updatePill,
  onOpenAbout,
  onOpenSettings,
  onOpenChange,
  labels
}: AccountMenuProps) {
  let menuIndex = 0;
  const nextMenuIndex = () => menuIndex++;

  return (
    <div className="sand-agents-sidebar__account sand-agents-sidebar__footer" data-account-menu-open={isOpen || undefined}>
      {updatePill ?? null}
      <SandMenuRoot closeOnSelect={false} offset={4} onOpenChange={onOpenChange} open={isOpen} placement="bottom-start">
        <SandMenuTrigger>
          <button aria-expanded={isOpen} aria-haspopup="menu" aria-label={accountLabel} type="button">
            <span aria-hidden="true">{displayName.slice(0, 1).toUpperCase()}</span>
            <span><strong>{displayName}</strong></span>
          </button>
        </SandMenuTrigger>
        <SandMenuContent ariaLabel={accountLabel}>
          <div data-component="menu-layout">
            <SandMenuItem index={nextMenuIndex()} onSelect={() => { onOpenChange(false); onOpenSettings(); }}>{labels.settings}</SandMenuItem>
            <SandMenuItem index={nextMenuIndex()} onSelect={() => { onOpenChange(false); onOpenAbout(); }}>{labels.about}</SandMenuItem>
          </div>
        </SandMenuContent>
      </SandMenuRoot>
    </div>
  );
}

export default AccountMenu;