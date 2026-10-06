import { SAND_PRODUCT_DISPLAY_NAME } from "../../shared/product-name.js";
import type { SandAuthStatus } from "./cursor-auth.js";

/**
 * Локальная учётная запись — единственный «вход», который есть в DB Bot Lite.
 *
 * Что было. `getCursorAuthStatus` отдавал ровно то, что сообщал сервис входа
 * Cursor. У пользователя нет аккаунта Cursor и он его не заводил, поэтому
 * статус всегда был `logged-out`, а рендерер на этом условии рисовал экран
 * входа и не показывал рабочую область. Кнопка «Войти» звала `loginCursor`,
 * который открывал адрес Cursor и падал с `Invalid URL`.
 *
 * Почему здесь, а не в рендерере. Рендерер спрашивает `account.kind` больше
 * чем в тридцати местах: список помощников, поле ввода, онбординг, черновики,
 * видимость панелей. Переписывать тридцать проверок — это тридцать chances
 * разъехаться с логикой. Здесь меняется одно место, и все тридцать проверок
 * получают одинаковый ответ.
 *
 * Почему без `authId` и `email`. Оба поля превращают локальный запуск в запрос
 * к чужому сервису: `readSandAccessOnce` берёт из них «слот» и идёт за
 * разрешением на доступ (`api2.cursor.sh`), а `getAvatar` идёт за аватаром
 * (`cursor.com`). Без них обе функции возвращают пусто и сети не касаются.
 *
 * Имя `LOCAL_ACCOUNT_SLOT` в `coordinator-account-runtime.ts` остаётся: это
 * слот, под которым координатор работает без аккаунта, и он не менялся.
 */
export const LOCAL_ACCOUNT_DISPLAY_NAME = SAND_PRODUCT_DISPLAY_NAME;

/** Статус, который приложение показывает, когда вход в Cursor не нужен и невозможен. */
export const LOCAL_ACCOUNT_STATUS: SandAuthStatus = {
  kind: "logged-in",
  displayName: LOCAL_ACCOUNT_DISPLAY_NAME,
};

/** Что приложение отвечает, когда пользователь всё-таки жмёт «Войти». */
export const LOCAL_ACCOUNT_NO_SIGN_IN_MESSAGE =
  "DB Bot работает на этом компьютере. Вход в аккаунт не нужен." as const;

/**
 * Статус для рендерера: настоящий вход, если он есть, локальная запись иначе.
 */
export function asLocalAccountStatus(status: SandAuthStatus): SandAuthStatus {
  return status.kind === "logged-in" ? status : LOCAL_ACCOUNT_STATUS;
}