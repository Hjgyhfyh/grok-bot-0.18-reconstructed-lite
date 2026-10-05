// Мой собственный клиент CDP: подключается к уже запущенному через
// scripts/probe-live-renderer.mjs окну и задаёт ему выражения.
import { readFileSync } from "node:fs";

const port = Number(process.argv[2] ?? "9463");
const file = process.argv[3];

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find(t => t.type === "page" && t.webSocketDebuggerUrl);
if (!page) { console.log("страница не найдена:", JSON.stringify(targets)); process.exit(1); }

const expression = readFileSync(file, "utf8");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve);
  socket.addEventListener("error", () => reject(new Error("ws error")));
});
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("таймаут 120 с")), 120_000);
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    clearTimeout(timer);
    resolve(message);
  });
  socket.send(JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: { expression, returnByValue: true, awaitPromise: true },
  }));
});
socket.close();
if (result.result?.exceptionDetails) console.log("ИСКЛЮЧЕНИЕ:", JSON.stringify(result.result.exceptionDetails, null, 2));
console.log(JSON.stringify(result.result?.result?.value ?? null, null, 2));
process.exit(0);