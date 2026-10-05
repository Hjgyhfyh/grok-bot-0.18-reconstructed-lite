// Разведка №3: выясняет, почему список помощников пишет «Не удаётся связаться с
// компьютером», и не является ли это следствием поддельной учётной записи.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { launchLiveApp, repoRoot, sleep } from "./qa-ui1-cdp.mjs";

const userDataDir = path.join(repoRoot, ".tmp-qa-ui1-explore3");
rmSync(userDataDir, { recursive: true, force: true });
mkdirSync(userDataDir, { recursive: true });

function fakeJwt(payload) {
  return `${Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${"A".repeat(86)}`;
}
const accessToken = fakeJwt({ sub: "qa1-local-probe-user", email: "qa1@example.invalid", exp: 4_000_000_000 });
const refreshToken = fakeJwt({ sub: "qa1-local-probe-user", exp: 4_000_000_000 });
writeFileSync(path.join(userDataDir, "sand-secrets.json"), JSON.stringify({
  "cursor-access-token": `plaintext:v1:${Buffer.from(accessToken, "utf8").toString("base64")}`,
  "cursor-refresh-token": `plaintext:v1:${Buffer.from(refreshToken, "utf8").toString("base64")}`
}, null, 2), "utf8");

const app = await launchLiveApp({ userDataDir, preferredPort: 9465 });
console.log(`PID=${app.pid}`);
await sleep(30_000);

const probe = `(() => ({
  hasDesktop: typeof window.desktop,
  hasCoordinatorPort: typeof window.coordinatorPort,
  desktopKeys: window.desktop ? Object.keys(window.desktop).slice(0, 60) : null,
  rosterState: (document.querySelector(".sand-agents-state__label") ?? {}).textContent,
  shellDataset: (() => { const n = document.querySelector(".sand-shell"); return n ? JSON.stringify({...n.dataset}) : null; })(),
  statusBadge: (document.querySelector(".sand-window-status-badge, [class*=status-badge]") ?? {}).textContent,
  allText: (document.body.innerText ?? "").replace(/\\s+/g, " ").slice(0, 400)
}))()`;
console.log(JSON.stringify(await app.client.eval(probe), null, 2));

console.log(`\n--- процессы ---`);
console.log(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'DB Bot|node|box' } | Select-Object ProcessId,Name,@{n='cl';e={$_.CommandLine.Substring(0,[Math]::Min(150,$_.CommandLine.Length))}} | Format-Table -AutoSize | Out-String -Width 200"
], { encoding: "utf8", timeout: 60_000 }));

console.log(`\n--- файлы каталога данных ---`);
function walk(dir, depth = 0) {
  if (depth > 3) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, depth + 1));
    else out.push(`${full.replace(userDataDir, "<udd>")} ${statSync(full).size}`);
  }
  return out;
}
console.log(walk(userDataDir).slice(0, 80).join("\n"));

for (const candidate of [
  path.join(userDataDir, "logs"),
  path.join(userDataDir, "box.log"),
  path.join(process.env.LOCALAPPDATA ?? "", "GrokBotLocalBox", "box.log")
]) {
  try {
    const files = statSync(candidate).isDirectory() ? readdirSync(candidate).map(n => path.join(candidate, n)) : [candidate];
    for (const file of files) {
      console.log(`\n--- хвост ${file} ---`);
      console.log(readFileSync(file, "utf8").slice(-3000));
    }
  } catch { /* нет такого файла */ }
}

console.log(`\n--- stderr приложения (хвост) ---`);
console.log(app.stderr.slice(-4000));

await app.close();
console.log("Закрыто.");