/**
 * Снимок участка экрана средствами Windows. Из Node `System.Drawing` не достать,
 * поэтому запускается отдельный процесс PowerShell и пишет PNG на диск.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "qa-01-grab-screen.ps1");

export function grabScreen({ x, y, w, h, out }) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", script,
      "-X", String(x), "-Y", String(y), "-W", String(w), "-H", String(h),
      "-Out", out
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && /SAVED/.test(stdout)) resolve({ ok: true, stdout, stderr });
      else reject(new Error(`qa-01-grab-screen.ps1 code=${code}: ${(stderr || stdout).trim()}`));
    });
  });
}