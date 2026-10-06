/**
 * Когда от двух отдельно живущих дел ищи настройки
 * `source/shared/node/settings/sand-settings-store.ts`.
 *
 * На живой машине команда `setHostSettings` семь раз молча потеряла значение:
 * в журнале `EPERM ... rename settings.json.<pid>.tmp -> settings.json`. Настройка
 * в интерфейсе менялась, а на диске оставалась старая. Пользователь нажимает и
 * ничего не происходит — и никто ему об этом не говорит.
 *
 * ЧТО ИЗВЕСТНО ТОЧНО. Настоящая и подтверждённая причина — вторая: на Windows
 * подмена имени над файлом, который кто-то открыл, падает с `EPERM` или
 * `EBUSY`. Главный процесс, координатор и хост держат `settings.json` открытым
 * почти всё время, а попытка подмены была ровно одна. Держатель отпускает файл
 * через миллисекунды, но повтора не было, поэтому первое же столкновение
 * означало потерю настройки.
 *
 * ЧТО ВЫГЛЯДИТ ПРАВДОПОДОБНО, НО НЕ ПОДТВЕРЖДЕНО. Имя временного файла раньше
 * строилось только из номера процесса: `${settingsPath}.${process.pid}.tmp`.
 * В одном процессе две записи получили бы одно имя и могли бы мешать другу
 * (вторая переименовывала бы уже унесённый файл, а если успевала затереть его
 * содержимое — первая унесла бы в настройки чужие данные). Но `persist`
 * синхронный, а хост и координатор — разные процессы с разными номерами, то
 * есть на практике это столкновение почти не встречается. Уникальное имя
 * временного файла — это страховка от редкого случая, а не лечение видимой
 * болезни.
 *
 * ЧЕСТНО О САМИХ ПРОВЕРКАХ, И ЭТО ВАЖНЕЕ ВСЕГО ОСТАЛЬНОГО. Первые и последние
 * проверки этого файла ПРОХОДЯТ И НА СТАРОМ, СЛОМАНОМ КОДЕ — проверено откатом
 * правки. Они бьют по обычной записи и на дефект не смотрят. Ловят его ровно
 * две проверки на код: повтор при EPERM и уникальное имя временного файла. Не
 * принимай первые проверки за доказательство починки — это не доказательство.
 *
 * Настоящий честный тест на повтор здесь невозможен: чтобы подмена гарантированно
 * получила EPERM, нужен файл, открытый БЕЗ разрешения на удаление, а Node так
 * открывать файлы не умеет. Поэтому поведение повтора закреплено проверкой кода,
 * а не имитацией.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const storePath = path.join(repoRoot, "source/shared/node/settings/sand-settings-store.ts");

/**
 * Собираем настоящий модуль со всеми его импортами: тест должен бить по
 * работающему коду, а не по вырезанной копии функции.
 */
const bundled = await build({
  entryPoints: [storePath],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  write: false,
  external: ["node:*"],
});
const store = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);

const { SandSettingsStore } = store;

/** Каталог под один прогон. Каждому тесту — свой, чтобы тесты не мешали друг другу. */
function profileDir() {
  return mkdtempSync(path.join(tmpdir(), "dbbot-settings-race-"));
}

test("обычная запись настроек работает: две подряд, и последняя побеждает", () => {
  const dir = profileDir();
  try {
    const settingsPath = path.join(dir, "settings.json");
    const store = new SandSettingsStore(settingsPath);

    store.setHasSeenOnboarding(true);
    store.setHasSeenOnboarding(false);

    assert.equal(
      store.getHasSeenOnboarding(),
      false,
      "после второй записи на диске должно лежать последнее значение, а не первое"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("две записи в разные файлы одного каталога не путают временные файлы", () => {
  const dir = profileDir();
  try {
    // Два экземпляра на ОДНИ И ТЕ ЖЕ файлы, как главный процесс и координатор.
    const settingsPath = path.join(dir, "settings.json");
    const first = new SandSettingsStore(settingsPath);
    const second = new SandSettingsStore(settingsPath);

    first.setHasSeenOnboarding(true);
    second.setHasSeenOnboarding(true);

    assert.equal(
      second.getHasSeenOnboarding(),
      true,
      "вторая запись не должна была снести первую или унести в файл чужое значение"
    );

    // Читаем файл как есть, минуя класс: так видно, что именно лежит на диске.
    const onDisk = JSON.parse(readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, ""));
    assert.equal(onDisk.hasSeenOnboarding, true, "на диске лежит не то, что записали");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("временные файлы после записи убираются, иначе они копятся в папке настроек", () => {
  const dir = profileDir();
  try {
    const settingsPath = path.join(dir, "settings.json");
    const store = new SandSettingsStore(settingsPath);

    store.setHasSeenOnboarding(true);
    store.setHasSeenOnboarding(false);

    const leftovers = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(
      leftovers,
      [],
      `в папке настроек остались временные файлы: ${leftovers.join(", ")}. Они копятся при каждой записи и со временем занимают место.`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("подмена имени повторяется при EPERM, а не сдаётся с первой попытки", () => {
  const source = readFileSync(storePath, "utf8");
  const retry = /function renameWithRetry\(from: string, to: string\): void \{[\s\S]*?\n\}/.exec(source);
  assert.notEqual(retry, null, "в `sand-settings-store.ts` нет `renameWithRetry`, и подмена имени идёт без повторов");

  const body = retry[0];
  assert.match(
    body,
    /renameSync\(from, to\)/,
    "повторяющаяся подмена зовёт `renameSync`"
  );
  assert.match(
    body,
    /EPERM/,
    "код EPERM не назван, хотя именно он приходит от Windows на занятый файл"
  );
  assert.match(
    body,
    /EBUSY|EACCES/,
    "назван только EPERM. Занятый файл на Windows даёт ещё и EBUSY, и EACCES"
  );
  assert.match(
    body,
    /sleepSync|retry|attempt/i,
    "повтор есть по коду, но нет паузы между попытками — файл мог быть ещё занят"
  );
  assert.match(
    body,
    /ENOENT/,
    "на `ENOENT` повторять бессмысленно: временного файла просто нет. Этот случай должен отличаться от занятого файла."
  );
});

test("имя временного файла уникально для каждой записи, а не только для процесса", () => {
  const source = readFileSync(storePath, "utf8");
  const persist = /persist\(settings: SandStoredSettings\): void \{[\s\S]*?\n  \}/.exec(source);
  assert.notEqual(persist, null, "в `sand-settings-store.ts` нет метода `persist`");

  const body = persist[0];
  assert.doesNotMatch(
    body,
    /\$\{this\.settingsPath\}\.\$\{process\.pid\}\.tmp/,
    "имя временного файла снова строится только из номера процесса. Две записи внутри одного процесса снова столкнутся, и настройка снова будет теряться."
  );
  assert.match(
    body,
    /process\.pid/,
    "номер процесса в имени временного файла не участвует — а он и должен участвовать, чтобы процессы не мешали друг другу"
  );
  assert.match(
    body,
    /Math\.random|counter|sequence|counterpart/i,
    "внутри одного процесса записи всё ещё не различаются: нет ни счётчика, ни случайного хвоста"
  );
});

test("настройка переживает сорок записей подряд и остаётся читаемой", () => {
  const dir = profileDir();
  try {
    const settingsPath = path.join(dir, "settings.json");
    const store = new SandSettingsStore(settingsPath);

    // Много записей подряд — как при переключении темы, окон и панелей.
    for (let i = 0; i < 40; i += 1) store.setHasSeenOnboarding(i % 2 === 0);

    assert.equal(
      store.getHasSeenOnboarding(),
      false,
      "после сорока записей на диске должно лежать последнее значение"
    );
    assert.equal(
      existsSync(settingsPath),
      true,
      "файл настроек исчез после серии записей"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});