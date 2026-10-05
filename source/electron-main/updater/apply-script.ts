// Скрипт, который ставит скачанное обновление после закрытия программы.
//
// Почему скрипт, а не код в приложении: в момент закрытия Windows держит
// дескрипторы на `DB Bot.exe`, на DLL и на `resources\app.asar`. Пока
// программа жива, заменить эти файлы нельзя. Скрипт запускается отдельным
// процессом, ждёт завершения по номеру процесса и меняет файлы после.
//
// Копирование делает `robocopy /MIR`: он не только копирует новые файлы, но и
// удаляет из каталога те, которых в новой сборке больше нет. Обычный `cp`
// оставил бы старые локали и старые чанки рендерера навсегда.

import path from "node:path";

export interface ApplyScriptInput {
  /** Каталог установленной программы (тот, где лежит `DB Bot.exe`). */
  readonly appDirectory: string;
  /** Каталог с уже распакованной новой сборкой. */
  readonly stagedDirectory: string;
  readonly executableName: string;
  /** Номер процесса приложения, выход которого надо дождаться. */
  readonly processId: number;
  readonly logFile: string;
  readonly version: string;
}

/** Строковый литерал PowerShell: одинарные кавычки удваиваются. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildApplyScript(input: ApplyScriptInput): string {
  const appDirectory = psQuote(input.appDirectory);
  const stagedDirectory = psQuote(input.stagedDirectory);
  const executable = psQuote(path.join(input.appDirectory, input.executableName));
  const logFile = psQuote(input.logFile);
  return `$ErrorActionPreference = 'Stop'
$log = ${logFile}
function Write-Log([string]$message) {
  Add-Content -LiteralPath $log -Value ((Get-Date).ToString('s') + ' ' + $message) -Encoding UTF8
}
try {
  Write-Log 'update ${input.version}: waiting for pid ${input.processId} to exit'
  $process = Get-Process -Id ${input.processId} -ErrorAction SilentlyContinue
  if ($process) { Wait-Process -Id ${input.processId} -Timeout 180 -ErrorAction SilentlyContinue }
  if (Get-Process -Id ${input.processId} -ErrorAction SilentlyContinue) {
    Write-Log 'update ${input.version}: application is still running after 180 s, cancelling'
    exit 1
  }
  Write-Log 'update ${input.version}: mirroring ${input.stagedDirectory} into ${input.appDirectory}'
  # /MIR удаляет в приёмнике всё, чего нет в источнике.
  # Коды 0–7 — это успех robocopy, 8 и выше — ошибка.
  & robocopy ${stagedDirectory} ${appDirectory} /MIR /IS /R:3 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
  $code = $LASTEXITCODE
  if ($code -ge 8) { throw "robocopy failed with code $code" }
  Write-Log 'update ${input.version}: files copied, starting ${input.executableName}'
  Start-Process -FilePath ${executable}
  Remove-Item -LiteralPath ${stagedDirectory} -Recurse -Force -ErrorAction SilentlyContinue
  Write-Log 'update ${input.version}: done'
} catch {
  Write-Log ('update ${input.version}: FAILED ' + $_.Exception.Message)
  exit 1
}
`;
}
