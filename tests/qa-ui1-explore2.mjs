// Разведка №2: заходит в интерфейс с поддельной учётной записью, чтобы увидеть
// экраны, которые иначе закрыты экраном входа, и выбрать селекторы проверок.
//
// Поддельный вход нужен потому, что `SandCursorAuthService.getStatus` читает
// `sand-secrets.json` из каталога данных и понимает префикс `plaintext:v1:`.
// Это позволяет попасть в состояние `logged-in` без сети и без учётной записи.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { launchLiveApp, repoRoot, sleep } from "./qa-ui1-cdp.mjs";

const userDataDir = path.join(repoRoot, ".tmp-qa-ui1-explore2");
rmSync(userDataDir, { recursive: true, force: true });
mkdirSync(userDataDir, { recursive: true });

function fakeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.${"A".repeat(86)}`;
}

const accessToken = fakeJwt({ sub: "qa1-local-probe-user", email: "qa1@example.invalid", exp: 4_000_000_000 });
const refreshToken = fakeJwt({ sub: "qa1-local-probe-user", exp: 4_000_000_000 });
writeFileSync(path.join(userDataDir, "sand-secrets.json"), JSON.stringify({
  "cursor-access-token": `plaintext:v1:${Buffer.from(accessToken, "utf8").toString("base64")}`,
  "cursor-refresh-token": `plaintext:v1:${Buffer.from(refreshToken, "utf8").toString("base64")}`
}, null, 2), "utf8");

const app = await launchLiveApp({ userDataDir, preferredPort: 9463 });
console.log(`PID=${app.pid} порт=${app.port}`);

await sleep(12_000);

const dump = `(() => {
  const describe = node => {
    const r = node.getBoundingClientRect();
    const cs = getComputedStyle(node);
    return {
      tag: node.tagName.toLowerCase(),
      cls: (typeof node.className === "string" ? node.className : "").slice(0, 70),
      aria: node.getAttribute("aria-label"),
      title: node.getAttribute("title"),
      text: (node.innerText ?? node.textContent ?? "").trim().replace(/\\s+/g, " ").slice(0, 50),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      visible: cs.visibility !== "hidden" && cs.display !== "none" && r.width > 0 && r.height > 0
    };
  };
  return {
    viewport: [window.innerWidth, window.innerHeight],
    bodyText: (document.body.innerText ?? "").slice(0, 1500),
    buttons: Array.from(document.querySelectorAll("button")).map(describe),
    inputs: Array.from(document.querySelectorAll("input,textarea")).map(describe),
    dialogs: Array.from(document.querySelectorAll("[role=dialog]")).map(describe)
  };
})()`;

console.log(JSON.stringify(await app.client.eval(dump), null, 2).slice(0, 22000));
console.log(`\n--- ошибки консоли (${app.consoleErrors.length}) ---`);
for (const e of app.consoleErrors.slice(0, 25)) console.log(`  [${e.type}] ${e.text}`);
console.log(`--- исключения (${app.exceptions.length}) ---`);
for (const e of app.exceptions.slice(0, 15)) console.log(`  ${String(e.text).slice(0, 300)}`);

await app.client.screenshot(path.join(repoRoot, ".tmp-qa-ui1-shots", "02-signed-in.png"));
await app.close();
rmSync(userDataDir, { recursive: true, force: true });
console.log("Готово.");