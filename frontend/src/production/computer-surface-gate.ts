/**
 * Условия, по которым на экране появляются поверхности «компьютера агента».
 *
 * Что было. `ComputerInfoPane` монтировался при каждом запуске: в условии
 * стояли только мост, выбранный помощник и «панель занят другим» — проверки
 * `computerInfoOpen` не было. Внутри панели живёт `ComputerPreview` с
 * заглушкой «Включаем компьютер» и подписью «Экран «<помощник>»», а из
 * него вызывается `experience.open()`. `ComputerFullscreen` — `position: fixed`
 * на всё окно, и вместе с ним пропадает поле ввода.
 *
 * Что стало. Панель появляется только после действия человека: кнопка
 * компьютера в шапке диалога ставит `isInfoPaneOpen`. При обычном запуске на
 * экране остаётся диалог с полем ввода.
 *
 * Модуль маленький и чистый специально: правило проверяется тестом, а не
 * чтением строки в большом рендерере.
 */

export interface ComputerSurfaceContext {
  /** Мост главного процесса доступен. */
  isBridgeReady: boolean;
  /** Выбранный помощник открыт. */
  hasActiveAgent: boolean;
  /** Выбранный помощник — группа, а не обычный помощник. */
  isGroupAgent: boolean;
  /** Человек нажал кнопку компьютера в шапке диалога. */
  isInfoPaneOpen: boolean;
  /** Открыта панель сценариев. */
  isRoutinesPaneOpen: boolean;
  /** Открыта панель настроек помощника. */
  isAgentSettingsOpen: boolean;
  /** Открыта панель каналов. */
  isChannelsPaneOpen: boolean;
}

/** Панель компьютера: только по действию человека и только вместо других панелей. */
export function shouldRenderComputerInfoPane(context: ComputerSurfaceContext): boolean {
  return context.isBridgeReady
    && context.hasActiveAgent
    && !context.isGroupAgent
    && context.isInfoPaneOpen
    && !context.isRoutinesPaneOpen
    && !context.isAgentSettingsOpen
    && !context.isChannelsPaneOpen;
}

export interface ComputerFullscreenContext {
  hasActiveAgent: boolean;
  isGroupAgent: boolean;
  /** Зритель экрана открыт прямо сейчас. */
  isViewerOpen: boolean;
  /** Зритель был открыт и панель ещё не закрыли. */
  isViewerRetained: boolean;
  isInfoPaneOpen: boolean;
}

/**
 * Полноэкранный зритель «компьютера агента». Он перекрывает всё окно, поэтому
 * монтируется только по прямому действию: человек нажал «Открыть» в панели или
 * «Перехватить» в карточке передачи управления.
 */
export function shouldRenderComputerFullscreen(context: ComputerFullscreenContext): boolean {
  if (!context.hasActiveAgent || context.isGroupAgent) return false;
  return context.isViewerOpen || (context.isInfoPaneOpen && context.isViewerRetained);
}