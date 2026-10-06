// При каждом обычном запуске в `document.body.innerText` оставался текст закрытого
// экрана компьютера агента: «Booting up the computer» и «DB Bot's screen». Экран
// компьютера при этом никто не открывал — ни `computerInfoOpen`, ни
// `computer.isOpen` на старте не включены. Причина была в том, что
// `ComputerInfoPane` монтировала `ComputerPreview` безусловно, а закрытая панель
// пряталась только шириной `0` и `overflow:hidden`: атрибут `hidden` на внутреннем
// блоке перебивался классом с `display:flex`, поэтому `innerText` этот текст видел.
// Проверка закрывается тем, что предпросмотр монтируется только в открытой панели,
// а все надписи этого экрана переведены на русский.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shellDir = path.join(repoRoot, "frontend/src/recovered/features/computer/shell");

async function loadComputerShellModel() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "dbbot-computer-shell-"));
  const output = path.join(temporary, "model.mjs");
  await build({
    entryPoints: [path.join(shellDir, "model.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

const CYRILLIC = /[А-Яа-яЁё]/;

test("every line the closed computer screen can print is Russian", async () => {
  const loaded = await loadComputerShellModel();
  try {
    const { computerStageCopy, handoffStatusLabel } = loaded.module;
    const subjectLabel = "DB Bot";
    const base = { subjectLabel, isScreenLoading: false, isScreenUnavailable: false, isEmptyLoading: false, pullPercent: null };

    const copies = [
      computerStageCopy({ ...base, isScreenLoading: true }),
      computerStageCopy({ ...base, isScreenUnavailable: true }),
      computerStageCopy({ ...base, pullPercent: 40 }),
      computerStageCopy({ ...base, isEmptyLoading: true }),
      computerStageCopy({ ...base, emptyMessage: "Этот помощник работает на вашем компьютере. Отдельного рабочего стола нет." })
    ];
    for (const copy of copies) {
      assert.match(copy.message, CYRILLIC, `надпись экрана компьютера осталась без русского текста: ${JSON.stringify(copy.message)}`);
      assert.equal(/Booting up the computer|Setting up the computer|Switching to |Can't reach /.test(copy.message), false,
        `в надписи экрана компьютера остался английский текст исходного продукта: ${JSON.stringify(copy.message)}`);
    }

    for (const status of ["waiting", "handed_back", "replied", "dismissed", "что-то другое"]) {
      const label = handoffStatusLabel(status).label;
      assert.match(label, CYRILLIC, `статус передачи управления показан без русского текста: ${JSON.stringify(label)}`);
    }

    const fallbackTitle = loaded.module.projectComputerMonitors(
      [{ subagentId: "sub-1", title: "", status: "running", subagentType: "computerUse" }],
      () => ({ state: "running", vncUrl: "vnc://127.0.0.1:5900" })
    );
    assert.equal(fallbackTitle[0]?.title, "Помощник", "монитор без названия должен называться по-русски, а не словом Subagent");
  } finally {
    await loaded.dispose();
  }
});

test("the closed details pane never mounts the computer preview", async () => {
  const view = await readFile(path.join(shellDir, "view.tsx"), "utf8");
  const mount = view.match(/\{isOpen && !experience\.isOpen \? <ComputerPreview/);
  assert.ok(mount != null,
    "ComputerInfoPane снова монтирует ComputerPreview безусловно: закрытая панель вернёт текст экрана компьютера в body.innerText при каждом запуске");

  const guarded = /\{isOpen && !experience\.isOpen \? <ComputerPreview\b[\s\S]{0,400}?teachRecording=\{teachRecording\} \/> : null\}/.test(view);
  assert.ok(guarded,
    "предпросмотр компьютера должен монтироваться только в открытой панели, а в закрытой отдавать null");

  // Статическая проверка обязана что-то находить: ноль совпадений — провал, а не успех.
  assert.equal(view.includes("ComputerPreview"), true, "view.tsx перестал содержать ComputerPreview, и этот тест проверяет не то");
});

test("the shell header and the details pane name the computer in Russian", async () => {
  const view = await readFile(path.join(shellDir, "view.tsx"), "utf8");
  const forbidden = ["DB Bot's Computer", "DB Bot's screen", "Open computer", "Computer preview", "Close details", "Conversation details", "Exit fullscreen", "Needs your attention", "Skip this step", "I'm done, continue", "Take over", "Screen preview unavailable", "Switch to ", "needs you"];
  // Идентификаторы `onRetry` и `RETRY_BUTTON` остаются английскими — они не надписи.
  assert.equal(/>Retry</.test(view), false, "кнопка повтора на экране компьютера осталась с английской надписью");
  assert.equal(view.includes("Subagent"), false, "в интерфейсе экрана компьютера осталось слово Subagent");
  for (const phrase of forbidden) {
    assert.equal(view.includes(phrase), false, `в интерфейсе экрана компьютера осталась английская надпись ${JSON.stringify(phrase)}`);
  }
  assert.match(view, /Компьютер DB Bot/, "кнопка экрана компьютера в шапке диалога должна называться по-русски");
  assert.match(view, /Экран «\{subjectLabel\}»/, "подпись под экраном компьютера должна быть на русском");
});
