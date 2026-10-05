// Нейтральные знаки для сервисов без файлового логотипа.
//
// @evidence src/app/dist/renderer/assets/apollo-B0sEgAUH.png
// @evidence src/app/dist/renderer/assets/salesforce-DuGcPENR.svg
// Шестнадцать логотипов из пакета 0.18 лежали отдельными файлами в
// `src/app/dist/renderer/assets`. Байтов нет ни в репозитории, ни в npm. Раньше
// рендерер ссылался на эти имена файлов и получал 404; теперь он рисует
// нейтральный знак — скруглённый квадрат с буквой названия. Это не логотип
// сервиса: подделывать чужие торговые знаки нельзя, а пустое место в списке
// программ выглядит как поломка.
//
// Остальные тридцать два знака в `tool-assets.ts` восстановлены из байтов
// пакета 0.18 и остались настоящими SVG.

/** Приглушённые фоны: ни один не является фирменным цветом какого-либо сервиса. */
const NEUTRAL_TINTS = Object.freeze([
  "#5b6b7c", "#6a5f7c", "#5f7c6a", "#7c6a5b", "#5b7c7c",
  "#7c5f6a", "#6b6b5b", "#4f6272", "#72604f", "#5f7260",
]);

function tintFor(key: string): string {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  return NEUTRAL_TINTS[hash % NEUTRAL_TINTS.length]!;
}

export function neutralToolMark(key: string, label: string): string {
  const initials = label.replace(/[^0-9A-Za-z]+/gu, "").slice(0, 2).toUpperCase() || "?";
  const svg = [
    "<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'>",
    `<rect width='32' height='32' rx='7.5' fill='${tintFor(key)}'/>`,
    `<text x='16' y='16.6' fill='#ffffff' font-family='system-ui,-apple-system,Segoe UI,sans-serif' font-size='13.5' font-weight='600' text-anchor='middle'>${initials}</text>`,
    "</svg>",
  ].join("");
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}