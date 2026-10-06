import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadComputerSurfaceGateModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "dbbot-computer-surface-"));
  const output = path.join(temporary, "computer-surface-gate.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "frontend/src/production/computer-surface-gate.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

/**
 * Состояние окна сразу после обычного запуска: мост есть, помощник выбран и
 * открыт, группа не выбрана, ни одна боковая панель не открыта.
 */
const BOOT = {
  isBridgeReady: true,
  hasActiveAgent: true,
  isGroupAgent: false,
  isInfoPaneOpen: false,
  isRoutinesPaneOpen: false,
  isAgentSettingsOpen: false,
  isChannelsPaneOpen: false
};

const VIEWER_BOOT = {
  hasActiveAgent: true,
  isGroupAgent: false,
  isViewerOpen: false,
  isViewerRetained: false,
  isInfoPaneOpen: false
};

test("при обычном запуске поверхности «компьютера агента» не выходят на экран и человек сразу видит поле ввода", async () => {
  // Что ломалось. Панель компьютера монтировалась при каждом запуске: в условии
  // не было проверки `computerInfoOpen`, поэтому `ComputerPreview` собирался
  // вместе с заглушкой «Включаем компьютер» и подписью «Экран «<помощник>»».
  // Именно оттуда вызывается `experience.open()`, а `ComputerFullscreen` —
  // `position: fixed` на всё окно: он закрывал поле ввода. Никто этого не
  // замечал, потому что проверка жила внутри строки JSX в файле на 3600 строк,
  // и её никто не читал как правило.
  // Что доказывает тест. Решение о выводе панели и зрителя лежит в отдельной
  // функции, и оба вызова на пустом запуске дают «не показывать».
  const loaded = await loadComputerSurfaceGateModule();
  try {
    const { shouldRenderComputerInfoPane, shouldRenderComputerFullscreen } = loaded.module;
    assert.equal(shouldRenderComputerInfoPane(BOOT), false, "панель компьютера не должна собираться, пока человек её не открыл");
    assert.equal(shouldRenderComputerFullscreen(VIEWER_BOOT), false, "полноэкранный зритель не должен закрывать окно при запуске");
  } finally {
    await loaded.dispose();
  }
});

test("панель компьютера появляется только по кнопке в шапке диалога и уступает место другим панелям", async () => {
  // Что ломалось. Проверки на панели настроек, сценариев и каналов в условии
  // были, а проверки на кнопку компьютера — нет. Правило «кто сейчас имеет
  // право на правую панель» разъехалось по трём местам.
  // Что доказывает тест. Право на панель выдаёт ровно одно действие человека,
  // и любая другая открытая панель это право отбирает.
  const loaded = await loadComputerSurfaceGateModule();
  try {
    const { shouldRenderComputerInfoPane } = loaded.module;
    assert.equal(shouldRenderComputerInfoPane({ ...BOOT, isInfoPaneOpen: true }), true, "нажатая кнопка компьютера открывает панель");
    assert.equal(shouldRenderComputerInfoPane({ ...BOOT, isInfoPaneOpen: true, isAgentSettingsOpen: true }), false, "панель настроек помощника важнее панели компьютера");
    assert.equal(shouldRenderComputerInfoPane({ ...BOOT, isInfoPaneOpen: true, isRoutinesPaneOpen: true }), false, "панель сценариев важнее панели компьютера");
    assert.equal(shouldRenderComputerInfoPane({ ...BOOT, isInfoPaneOpen: true, isChannelsPaneOpen: true }), false, "панель каналов важнее панели компьютера");
    assert.equal(shouldRenderComputerInfoPane({ ...BOOT, isInfoPaneOpen: true, isGroupAgent: true }), false, "у группы нет панели компьютера");
    assert.equal(shouldRenderComputerInfoPane({ ...BOOT, isInfoPaneOpen: true, hasActiveAgent: false }), false, "без выбранного помощника панели нет");
    assert.equal(shouldRenderComputerInfoPane({ ...BOOT, isInfoPaneOpen: true, isBridgeReady: false }), false, "без моста главного процесса панели нет");
  } finally {
    await loaded.dispose();
  }
});

test("полноэкранный зритель закрывает окно только после прямого действия человека", async () => {
  // Что ломалось. `ComputerFullscreen` — `position: fixed` на всё окно. Пока
  // панель компьютера монтировалась при запуске, до кнопки «Открыть» можно было
  // дойти одним щелчком мимо, а окно оказывалось без поля ввода.
  // Что доказывает тест. Зритель выходит на экран либо по открытому зрителю, либо
  // по кнопке человека, и никогда сам.
  const loaded = await loadComputerSurfaceGateModule();
  try {
    const { shouldRenderComputerFullscreen } = loaded.module;
    assert.equal(shouldRenderComputerFullscreen({ ...VIEWER_BOOT, isViewerOpen: true }), true, "открытый зритель показывается даже после закрытия панели");
    assert.equal(shouldRenderComputerFullscreen({ ...VIEWER_BOOT, isViewerRetained: true }), false, "запоминание зрителя без открытой панели не показывает его снова");
    assert.equal(shouldRenderComputerFullscreen({ ...VIEWER_BOOT, isViewerRetained: true, isInfoPaneOpen: true }), true, "открытая панель возвращает запомненный зритель");
    assert.equal(shouldRenderComputerFullscreen({ ...VIEWER_BOOT, isGroupAgent: true, isViewerOpen: true }), false, "у группы нет зрителя компьютера");
    assert.equal(shouldRenderComputerFullscreen({ ...VIEWER_BOOT, hasActiveAgent: false, isViewerOpen: true }), false, "без выбранного помощника зрителя нет");
  } finally {
    await loaded.dispose();
  }
});