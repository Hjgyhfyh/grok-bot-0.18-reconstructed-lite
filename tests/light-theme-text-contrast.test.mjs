/**
 * Четыре темы — то, что пользователь видит каждый день. Раньше они собирались из
 * одной палитры простым переносом доли непрозрачности: `--sand-text-secondary`
 * брал из «Белой» темы `0x99`, `--sand-text-tertiary` — `0x66`, и оба просто
 * накладывались на холст своего варианта. На «Белой» это давало 4.8:1 и 2.6:1,
 * а на «Молочном», «Дымчатом» и «Небе» — 3.3–4.2:1 и 2.1–2.4:1. Три темы из четырёх
 * показывали второстепенный текст хуже минимума WCAG AA (4.5:1), а третичный —
 * хуже 3:1, то есть подписи под вложениями, разделитель времени и подписи в списке
 * расширений читались только при хорошем освещении и близком расстоянии.
 *
 * Причина в том, что переносили долю непрозрачности, а контраст — нет: у каждого
 * варианта свой холст и своя краска чернил, поэтому доля, дающая 4.8:1 на белом,
 * на «Дымчатом» даёт меньше четырёх.
 *
 * Тест считает контраст по формуле WCAG 2.1 прямо из того CSS, который модуль
 * отдаёт браузеру, и проверяет четыре роли текста в каждой из четырёх тем:
 * основной, второстепенный (на всех плоскостях, где он лежит, включая выбранную
 * строку боковой панели), третичный и подсвеченный акцентом. Заодно проверяет, что
 * фон окна Electron совпадает с холстом интерфейса и что тёмных тем в сборке нет.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build, transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = mkdtempSync(path.join(os.tmpdir(), "dbbot-theme-contrast-build-"));
test.after(() => rmSync(buildDir, { recursive: true, force: true }));

/** Формула WCAG 2.1 считается здесь, а не берётся у модуля: иначе тест сам себя оправдывал бы. */
function parseColour(value) {
  const text = String(value).trim().toLowerCase();
  const fail = () => { throw new Error(`не удалось разобрать цвет «${value}»`); };
  const rgba = /^rgba?\(([^)]+)\)$/.exec(text);
  if (rgba != null) {
    const parts = rgba[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
  }
  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex == null) fail();
  const body = hex[1];
  const wide = body.length <= 4 ? [...body].map((c) => c + c).join("") : body;
  return {
    r: parseInt(wide.slice(0, 2), 16),
    g: parseInt(wide.slice(2, 4), 16),
    b: parseInt(wide.slice(4, 6), 16),
    a: wide.length === 8 ? parseInt(wide.slice(6, 8), 16) / 255 : 1,
  };
}
function over(foreground, background) {
  return {
    r: foreground.r * foreground.a + background.r * (1 - foreground.a),
    g: foreground.g * foreground.a + background.g * (1 - foreground.a),
    b: foreground.b * foreground.a + background.b * (1 - foreground.a),
    a: 1,
  };
}
const linear = (value) => {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
};
const luminance = ({ r, g, b }) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
function contrast(first, second) {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
const round = (value) => Math.round(value * 100) / 100;

/** Все `--имя: значение;` из блоков конкретного варианта: у темы два правила — палитра Cursor и `--sand-*`. */
function declarationsOf(css, selector) {
  const values = {};
  let from = 0;
  let found = false;
  for (;;) {
    const start = css.indexOf(selector, from);
    if (start === -1) break;
    found = true;
    const end = css.indexOf("}", start);
    for (const match of css.slice(start, end === -1 ? css.length : end).matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
      values[match[1]] = match[2].trim();
    }
    from = end === -1 ? css.length : end;
  }
  assert.equal(found, true, `в собранном листе нет блока ${selector}`);
  return values;
}

const themeSource = readFileSync(path.join(repoRoot, "frontend/src/recovered/features/runtime-theme-token-installer.ts"), "utf8");
const themeModule = await import(
  `data:text/javascript;base64,${Buffer.from(
    (await transform(themeSource, { format: "esm", loader: "ts", target: "es2022" })).code
  ).toString("base64")}`
);
const { WINDOW_BACKGROUND_BY_THEME } = await (async () => {
  const outfile = path.join(buildDir, "theme-controller.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/electron-main/prefs/theme-controller.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  return import(pathToFileURL(outfile).href);
})();

const WCAG_AA_TEXT = 4.5;
const WCAG_AAA_TEXT = 7;

/** Плоскости, на которых лежит обычный текст: холст, боковая панель, карточка, наведение и выбранная строка. */
function planesOf(tokens) {
  const canvas = over(parseColour(tokens["--sand-bg-base"]), { r: 255, g: 255, b: 255, a: 1 });
  const surface = over(parseColour(tokens["--sand-bg-subtle"]), canvas);
  const elevated = over(parseColour(tokens["--sand-bg-elevated"]), canvas);
  const hovered = over(over(parseColour(tokens["--sand-fill-ghost-hover"]), surface), canvas);
  const selected = over(over(parseColour(tokens["--sand-fill-ghost-selected"]), surface), canvas);
  return { canvas, surface, elevated, hovered, selected };
}

test("второй и третий текст набирают WCAG AA во всех четырёх темах", () => {
  const sheet = themeModule.buildRuntimeThemeSheet();
  const measurements = [];
  for (const variant of themeModule.RUNTIME_THEME_VARIANTS) {
    const tokens = declarationsOf(sheet, `:root[data-theme="${variant}"]`);
    const planes = planesOf(tokens);
    const secondary = over(parseColour(tokens["--sand-text-secondary"]), planes.canvas);
    const tertiary = over(parseColour(tokens["--sand-text-tertiary"]), planes.canvas);
    for (const [name, plane] of Object.entries(planes)) {
      measurements.push({
        variant, pair: `второй текст на плоскости «${name}»`, ratio: round(contrast(secondary, plane))
      });
    }
    measurements.push({ variant, pair: "третий текст на холсте", ratio: round(contrast(tertiary, planes.canvas)) });
    measurements.push({ variant, pair: "третий текст на боковой панели", ratio: round(contrast(tertiary, planes.surface)) });
  }
  const failures = measurements.filter((entry) => entry.ratio < WCAG_AA_TEXT);
  assert.deepEqual(
    failures,
    [],
    `контраст ниже ${WCAG_AA_TEXT}:1 — пользователь не прочитает такой текст: ${JSON.stringify(failures)}`
  );
});

test("основной текст держит 7:1, а не проходит на грани", () => {
  const sheet = themeModule.buildRuntimeThemeSheet();
  for (const variant of themeModule.RUNTIME_THEME_VARIANTS) {
    const tokens = declarationsOf(sheet, `:root[data-theme="${variant}"]`);
    const planes = planesOf(tokens);
    const primary = over(parseColour(tokens["--sand-text-primary"]), planes.canvas);
    const onCanvas = round(contrast(primary, planes.canvas));
    assert.ok(
      onCanvas >= WCAG_AAA_TEXT,
      `в теме «${variant}» основной текст даёт ${onCanvas}:1 на холсте, а нужно не меньше ${WCAG_AAA_TEXT}:1`
    );
    const onSurface = round(contrast(primary, planes.surface));
    assert.ok(
      onSurface >= WCAG_AA_TEXT,
      `в теме «${variant}» основной текст даёт ${onSurface}:1 на боковой панели, а нужно не меньше ${WCAG_AA_TEXT}:1`
    );
  }
});

test("подсвеченный текст выделения набирает 4.5:1 и на подложке, и на холсте", () => {
  const sheet = themeModule.buildRuntimeThemeSheet();
  for (const variant of themeModule.RUNTIME_THEME_VARIANTS) {
    const tokens = declarationsOf(sheet, `:root[data-theme="${variant}"]`);
    const planes = planesOf(tokens);
    const accent = over(parseColour(tokens["--sand-text-accent"]), planes.canvas);
    const subtle = over(over(parseColour(tokens["--sand-fill-accent-subtle"]), planes.canvas), { r: 255, g: 255, b: 255, a: 1 });
    const onSubtle = round(contrast(accent, subtle));
    const onCanvas = round(contrast(accent, planes.canvas));
    assert.ok(
      onSubtle >= WCAG_AA_TEXT,
      `в теме «${variant}» выделенный текст даёт ${onSubtle}:1 на подсветке, а нужно не меньше ${WCAG_AA_TEXT}:1`
    );
    assert.ok(
      onCanvas >= WCAG_AA_TEXT,
      `в теме «${variant}» выделенный текст даёт ${onCanvas}:1 на холсте, а нужно не меньше ${WCAG_AA_TEXT}:1`
    );
  }
});

test("фон окна Electron совпадает с холстом интерфейса в каждой теме", () => {
  // Окно без рамки: пока первый кадр не нарисован, видно `backgroundColor` окна.
  // Если он не равен холсту темы, окно выглядит как обрезок интерфейса.
  for (const variant of themeModule.RUNTIME_THEME_VARIANTS) {
    assert.equal(
      String(WINDOW_BACKGROUND_BY_THEME[variant]).toLowerCase(),
      themeModule.RUNTIME_THEME_CANVAS[variant].toLowerCase(),
      `в теме «${variant}» окно красится в ${WINDOW_BACKGROUND_BY_THEME[variant]}, а интерфейс лежит на ${themeModule.RUNTIME_THEME_CANVAS[variant]}, и окно выглядит обрезанным`
    );
  }
});

test("в сборке нет тёмных тем и нет веточки prefers-color-scheme: dark", () => {
  assert.deepEqual(
    [...themeModule.RUNTIME_THEME_VARIANTS],
    ["light-white", "milk", "smoke", "sky"],
    "набор тем изменился: в приложении допустимы только четыре светлых варианта"
  );
  const sheet = themeModule.buildRuntimeThemeSheet();
  assert.equal(
    /prefers-color-scheme/i.test(sheet),
    false,
    "в листе тем появилась ветка prefers-color-scheme, и системная тёмная тема снова может повлиять на окно"
  );
  assert.equal(
    /color-scheme\s*:\s*dark/i.test(sheet),
    false,
    "в листе тем появилось color-scheme: dark, и нативные элементы окна станут тёмными"
  );
  // У каждой темы свой блок с одной и той же таблицей токенов: тёмного двойника быть не должно.
  for (const variant of themeModule.RUNTIME_THEME_VARIANTS) {
    const tokens = declarationsOf(sheet, `:root[data-theme="${variant}"]`);
    assert.equal(
      tokens["--sand-text-primary"],
      declarationsOf(sheet, `:root[data-theme="${variant}"]`)["--sand-text-primary"],
      "в теме «${variant}» текст не задан"
    );
    assert.ok(
      luminance(over(parseColour(tokens["--sand-text-primary"]), planesOf(tokens).canvas)) < 0.1,
      `в теме «${variant}» основной текст светлый (${tokens["--sand-text-primary"]}): это тёмная тема под именем ${variant}`
    );
  }
});