// Знак приложения.
//
// @evidence src/app/dist/renderer/assets/app-icon-C7NKj2u7.png (растр 64×64 из пакета 0.18)
// Байтов растра нет ни в репозитории, ни в npm: они жили только в стёртом
// Git LFS-объекте. Рендерер рисует тот же знак встроенной SVG-разметкой, поэтому
// картинка не запрашивается и не может дать 404.
const svg = [
  "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'>",
  "<rect width='64' height='64' rx='14' fill='#2f6df6'/>",
  "<path d='M18 20h9.5c8.2 0 13.5 4.8 13.5 12s-5.3 12-13.5 12H18V20zm9.2 19.4c5 0 8.1-2.7 8.1-7.4s-3.1-7.4-8.1-7.4h-3.5v14.8h3.5z' fill='#fff'/>",
  "<path d='M44 20h5.6v24H44z' fill='#fff'/>",
  "</svg>",
].join("");

export const APP_MARK_DATA_URL = `data:image/svg+xml,${encodeURIComponent(svg)}`;