// Разведка живого интерфейса: поднимает упакованное приложение, снимает главный
// экран и выписывает структуру DOM, чтобы выбрать селекторы для проверок.
import { rmSync } from "node:fs";
import path from "node:path";

import { launchLiveApp, repoRoot, sleep } from "./qa-ui1-cdp.mjs";

const userDataDir = path.join(repoRoot, ".tmp-qa-ui1-explore");
rmSync(userDataDir, { recursive: true, force: true });

const app = await launchLiveApp({ userDataDir, preferredPort: 9461 });
console.log(`PID=${app.pid} порт=${app.port} страница=${app.pageUrl}`);

await sleep(8000);

const shape = await app.client.eval(`(() => {
  const describe = node => {
    const r = node.getBoundingClientRect();
    return {
      tag: node.tagName.toLowerCase(),
      cls: (node.className && typeof node.className === "string" ? node.className : "").slice(0, 90),
      testid: node.getAttribute("data-testid"),
      role: node.getAttribute("role"),
      aria: node.getAttribute("aria-label"),
      text: (node.innerText ?? "").trim().replace(/\\s+/g, " ").slice(0, 60),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]
    };
  };
  const buttons = Array.from(document.querySelectorAll("button")).map(describe);
  return {
    title: document.title,
    url: location.href,
    viewport: [window.innerWidth, window.innerHeight],
    bodyText: (document.body.innerText ?? "").slice(0, 2000),
    buttonCount: buttons.length,
    buttons,
    rootChildren: document.getElementById("root")?.childElementCount ?? null
  };
})()`);

console.log(JSON.stringify(shape, null, 2).slice(0, 20000));
console.log(`\n--- ошибки консоли (${app.consoleErrors.length}) ---`);
for (const e of app.consoleErrors.slice(0, 30)) console.log(`  [${e.type}] ${e.text}`);
console.log(`--- исключения (${app.exceptions.length}) ---`);
for (const e of app.exceptions.slice(0, 20)) console.log(`  ${e.text}`);
console.log(`--- упавшие запросы (${app.failedRequests.length}) ---`);
for (const e of app.failedRequests.slice(0, 20)) console.log(`  ${e.errorText} ${e.type}`);

await app.client.screenshot(path.join(repoRoot, ".tmp-qa-ui1-shots", "01-main.png"));
console.log("\nСнимок: .tmp-qa-ui1-shots\\01-main.png");

await app.close();
rmSync(userDataDir, { recursive: true, force: true });
console.log("Приложение закрыто.");