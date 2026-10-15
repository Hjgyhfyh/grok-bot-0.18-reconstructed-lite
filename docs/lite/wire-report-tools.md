# wire-report-tools.md — registration edits outside `lite/waveb-report-tools` ownership

This branch lands `source/packages/report-tools/**` and
`source/host/runner/tools/report-turn-tools.ts` plus their tests, but the toolset
registration itself lives in files this branch does not own. Below are the exact
edits, taken from `archive/wave-3` and adapted to current `main` (cloud-agent
code is still present on `main`; nothing below removes or touches it).

Until these edits are applied, the five report tools exist but no turn receives
them — `skill_list`/`skill_read`/`save_report`/`fill_sample`/`report_preview`
are invisible to the model, which is exactly the defect
`tests/report-tools-registered.test.mjs` describes in its header comment.

---

## 1. `source/host/runner/tools/turn-toolset.ts`

### 1a. Imports

After the `send-message-tool` import block:

```ts
import {
  createSendMessageTool,
  type SendMessageDependencies,
} from "./send-message-tool.js";
```

add:

```ts
import { createReportTurnTools } from "./report-turn-tools.js";
import type { ReportToolsDependencies } from "../../../packages/report-tools/index.js";
```

### 1b. `TurnToolFactories` — add the factory slot

After `updateState?(): TurnTool;` (inside `export interface TurnToolFactories`):

```ts
  reportTools?(): readonly TurnTool[];
```

### 1c. New factory-input interface

After `TurnStateToolFactoryInput` (before `TurnSubagentManagementToolFactoryInput`):

```ts
/**
 * Пять отчётных инструментов: save_report, fill_sample, report_preview,
 * skill_list, skill_read. Зависимости приходят снаружи, потому что слой
 * `source/packages/**` не должен знать, где у хоста корень данных и куда
 * уходит превью.
 */
export interface TurnReportToolFactoryInput {
  readonly dependencies: ReportToolsDependencies;
}
```

### 1d. `TurnToolsetFactoryInputs` — accept the input

After `readonly sendMessage?: TurnSendMessageToolFactoryInput;`:

```ts
  readonly reportTools?: TurnReportToolFactoryInput;
```

### 1e. `TurnToolsetHostFactoryProvider` — provider hook

After `createStateToolInputs` (inside `export interface TurnToolsetHostFactoryProvider`):

```ts
  /**
   * Отчётные инструменты. Пусто — набор остаётся без них, а не с пятью
   * инструментами, у которых нет папки для записи.
   */
  readonly createReportToolInputs?: (
    turn: TurnToolsetTurnInput,
    props: TurnToolsetBuildProps,
  ) => TurnReportToolFactoryInput;
```

### 1f. New factory function

After `createTurnStateToolFactory` (before `createTurnSubagentManagementToolFactory`):

```ts
/**
 * Собирает пять отчётных инструментов из уже реализованного пакета
 * `source/packages/report-tools/`. Ничего не переписывает: меняется только
 * форма (TurnTool вместо ReportTool) и язык описаний.
 */
export function createTurnReportToolFactory(
  input: TurnReportToolFactoryInput,
): () => readonly TurnTool[] {
  return () => createReportTurnTools(input.dependencies).map(asTurnTool);
}
```

### 1g. `createTurnToolsetFactories` — key union and entry

Add `"reportTools"` to the key union (e.g. after `"updateState"`), and in the
returned literal after the `updateState` entry:

```ts
    ...(input.reportTools === undefined
      ? {}
      : { reportTools: createTurnReportToolFactory(input.reportTools) }),
```

### 1h. `createTurnToolsetFactoriesForTurn` — provider projection

After the `state` entry (`provider.createStateToolInputs`):

```ts
    ...(provider.createReportToolInputs === undefined
      ? {}
      : { reportTools: provider.createReportToolInputs(turn, props) }),
```

### 1i. `buildTurnTools` — actually push the tools into the turn

Immediately before `const agentId = host.getConversationId();` (after the block
that pushes `updateState`):

```ts
  // Пять отчётных инструментов: save_report, fill_sample, report_preview,
  // skill_list, skill_read. Только главному помощнику — у помощника с
  // отдельной задачей нет ни папки отчётов, ни доступа к экрану пользователя.
  // `report_preview` сам по себе ответом не считается: он обновляет экран, а
  // `DELIVERY_TOOL_NAMES` в `turn-shape.ts` остаётся без него.
  if (!host.isSubagentRunner && !host.isBoxScopedSubagent) {
    const reportTools = factories.reportTools?.();
    if (reportTools !== undefined) tools.push(...reportTools);
  }
```

---

## 2. `source/host/host-runner-composition.ts`

### 2a. Imports

After `import { connectorCardEmissionToMessage } from "./runner/tools/box-help-tool.js";`:

```ts
import { resolveReportSkillsDir } from "./runner/tools/report-turn-tools.js";
import { getSandRootDir } from "./host-paths.js";
```

### 2b. Provider entry in `createTurnToolsetFactoryProvider`

After `createAgentManagementToolInputs: () => ({ dependencies: dependencies.agentManagement, }),`:

```ts
      // Пять отчётных инструментов. Корень данных — тот же, что у всего
      // приложения, поэтому отчёты лежат в «Отчёты» рядом с остальным.
      // Превью уходит тем же событием `send-message`, что и настоящий
      // SendMessage, поэтому строка переписки несёт автора, а `fromAgent`
      // и `channel` (признаки строки с чужой машины) не появляются.
      // `ackToken` сюда не передаётся: превью не отвечает пользователю и не
      // должно закрывать его ожидание ответа.
      createReportToolInputs: turn => ({
        dependencies: {
          dataRoot: getSandRootDir(),
          skillsDir: resolveReportSkillsDir(getSandRootDir()),
          ...(turn.emitUpdate === undefined
            ? {}
            : {
                emitPreview: (update) => {
                  // Событие собирается здесь, а не пробрасывается объектом
                  // `ReportPreviewUpdate`: `ForwardedUpdate` требует строковый
                  // индекс, а у интерфейса из пакета его нет. Заодно видно
                  // точно, что на экран уходит тот же `send-message`, что и
                  // от настоящего SendMessage.
                  turn.emitUpdate?.({
                    type: "send-message",
                    message: { type: "text", content: update.message.content },
                    timestampMs: update.timestampMs,
                  });
                },
              }),
        },
      }),
```

---

## Notes for whoever applies this

- No new npm dependencies: the package uses only `node:*`, `zod` and esbuild
  (devDep for tests), all already in `package.json`.
- `skills/` is already on `main` with the same ten skills wave-3 had.
- After wiring, `tests/report-tools-registered.test.mjs`'s `toolsFor` may be
  switched from `adapter.createReportTurnTools(...)` to
  `toolset.createTurnReportToolFactory({ dependencies } )()` to also prove the
  toolset-level factory — it currently exercises the identical call directly.
- `DELIVERY_TOOL_NAMES` (`source/host/runner/turn-shape.ts`) must NOT gain
  `report_preview` or any of the five names — the registered test asserts this.
