// Заглушка `supports-color`.
//
// Пакет приходит транзитивно из `debug`, который тянет `builder-util-runtime`.
// `debug` читает его в `try`, то есть без пакета обойдётся, но esbuild
// оставляет неразрешённый `require` внешним импортом, а сборка падает на
// проверке «необъявленные внешние импорты».
//
// Само определение отвечает на вопрос «умеет ли терминал цвета» и в
// упакованном приложении, где stdout — заглушка Windows, ответа не имеет.
// Подменяется в `scripts/build-from-source.mjs` через `alias`.
module.exports = { level: 0, stdout: { level: 0 }, stderr: { level: 0 }, hasBasic: false, has256: false, has16m: false };
