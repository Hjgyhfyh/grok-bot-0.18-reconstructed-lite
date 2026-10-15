# wire-updater — правки вне `lite/waveb-updater`, которые нужны для автообновления

Ветка `lite/waveb-updater` портирует из `archive/wave-3`:

- `source/electron-main/updater/{auto-updates,apply-script,zip-archive}.ts`
- `.github/workflows/release.yml`
- `scripts/ci/{make-release,set-release-version,selfcheck}.mjs`
- `package.json` + `package-lock.json`: `electron-updater@6.8.9` (dependencies),
  `builder-util-runtime@9.7.0` (devDependencies — только `import type` в
  `auto-updates.ts`), script `package:win`.

Ниже — правки в файлах, которые ветка НЕ трогает. Без них новый апдейтер
не запускается и/или рядом продолжает жить старый сервис обновлений.

## 1. `source/electron-main/main.ts` — точка входа автообновления

### 1a. Импорт (после строки с `main-production-services.js`, ~строка 20)

Старый код:
```ts
import { createElectronMainProductionComposition, type ElectronMainProductionBindings } from "./main-production-services.js";
```

Новый код:
```ts
import { createElectronMainProductionComposition, type ElectronMainProductionBindings } from "./main-production-services.js";
import { startAutomaticUpdates } from "./updater/auto-updates.js";
```

### 1b. Вызов в bootstrap (якорь — `markPhase("services")`, ~строка 386)

Старый код:
```ts
      deps.startup.markPhase("services");
      services = await deps.initializeServices({ routeHostInput: hostChords.routeHostInput });
```

Новый код (как в wave-3 `main.ts:496-503`):
```ts
      deps.startup.markPhase("services");
      // Проверка обновлений идёт по сети и не должна задерживать окно,
      // поэтому она запускается параллельно сбору сервисов, а не после него.
      void startAutomaticUpdates({
        app: deps.app,
        env,
        platform,
        ...(deps.appVersion == null ? {} : { appVersion: deps.appVersion }),
      });
      services = await deps.initializeServices({ routeHostInput: hostChords.routeHostInput });
```

Все имена (`deps.app`, `deps.appVersion`, `env`, `platform`) уже есть в этой
области видимости на main — проверено.

## 2. `source/electron-main/production-binding-providers.ts:326` — глушение старого сервиса обновлений

Баннер `liteServiceGuard` в `scripts/build-from-source.mjs` уже выставляет
`DB_BOT_DISABLE_RECONSTRUCTED_UPDATES=1`, но gate на main читает только
`SAND_DISABLE_UPDATES` — то есть старый сервис обновлений Grok Bot (лента
`api2.cursor.sh` + локальный HTTP-сервер Squirrel) сейчас этим флагом
НЕ выключается.

Старый код:
```ts
          envDisabled: env.SAND_DISABLE_UPDATES === "1",
```

Новый код (wave-3 `production-binding-providers.ts:326-333`):
```ts
          // `SAND_DISABLE_UPDATES` больше не значит «выключить обновления DB Bot».
          // Он остался рычагом для сервиса обновлений исходного Grok Bot, который
          // опрашивает чужую ленту `api2.cursor.sh` и поднимает локальный
          // HTTP-сервер Squirrel. Lite работает только с DeepSeek и наружу не
          // ходит, поэтому эта лента выключена всегда. Автообновление самой
          // программы живёт в `source/electron-main/updater/**`, читает
          // `DB_BOT_AUTO_UPDATE` и этого флага не знает.
          envDisabled: env.DB_BOT_DISABLE_RECONSTRUCTED_UPDATES === "1" || env.SAND_DISABLE_UPDATES === "1",
```

Замечание: `source/electron-main/update/release-metadata.ts:3`
(`computeUpdateDisabledReasonLive`) на wave-3 тоже читал только
`SAND_DISABLE_UPDATES` — оставлено как есть для паритета с wave-3.

## 3. `source/node-agent-coordinator/carrier.ts:143` — конфликт типов с `electron.d.ts`

Подключение `electron-updater` втягивает в программу `node_modules/electron/electron.d.ts`,
который глобально дополняет `NodeJS.Process` полем `parentPort: ParentPort`.
Пересечение `NodeJS.Process & { parentPort?: unknown }` после этого даёт
`ParentPort` (тип Electron, у него нет `start`), и tsc падает:

```
source/node-agent-coordinator/carrier.ts(147,18): error TS2339: Property 'start' does not exist on type 'ParentPort'.
```

Ошибка вне моих файлов, вызвана моими новыми импортами — wave-3 чинил её так:

Старый код:
```ts
  const parentPort = (process as NodeJS.Process & { readonly parentPort?: unknown }).parentPort;
```

Новый код (wave-3 `carrier.ts:143-145`):
```ts
  // Именно `as unknown as`, а не пересечение с `unknown`: пересечение не расширяет
  // тип, и `parentPort` оставался бы `ParentPort` из @types/node, где нет `start`.
  const parentPort = (process as unknown as { readonly parentPort?: unknown }).parentPort;
```

До применения этой правки `tsc --project source/tsconfig.json` выдаёт ровно эту
одну ошибку; все файлы владений ветки (`source/electron-main/updater/**`)
компилируются чисто.

## 4. `package.json` — script `build` (опционально, при сведении волн)

На wave-3 `build` указывал на `scripts/build-from-source.mjs`; на main он пока
указывает на `scripts/build.mjs`. В `release.yml` этой ветки lite-сборка и
упаковка вызываются напрямую (`node scripts/build-from-source.mjs`,
`node scripts/package-windows-lite.mjs`), поэтому работоспособность от этого
репоинта НЕ зависит. Если при интеграции `build` будет репоинтнут на
`build-from-source.mjs`, шаги workflow можно вернуть к `npm run build` /
`npm run package:win` (script `package:win` добавлен этой веткой).

## Флаги окружения (уже есть, менять не надо)

- `DB_BOT_DISABLE_RECONSTRUCTED_UPDATES` — ставится баннером `liteServiceGuard`
  (`scripts/build-from-source.mjs`), глушит старый сервис обновлений после
  правки из п. 2.
- `DB_BOT_AUTO_UPDATE=0` — выключает новое автообновление
  (`source/electron-main/updater/auto-updates.ts`).
- `DB_BOT_UPDATE_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` — токен для приватного
  репозитория релизов; для публичного не нужен.
- `DB_BOT_RELEASE_VERSION` — версия релиза в CI (`set-release-version.mjs`).
