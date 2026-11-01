import { spawn, execFileSync } from "node:child_process";
import {
  openSync,
  closeSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const entry = join(root, "src/server/main.ts");
const stateFile = join(root, "var/service.json");
const action = process.argv[2] ?? "status";
const envText = readFileSync(join(root, ".env"), "utf8");
const port = Number(envText.match(/^PORT=(\d+)$/m)?.[1] ?? 60390);
const base = `http://127.0.0.1:${port}`;
function state() {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return undefined;
  }
}
function owned(s) {
  if (!s || !Number.isSafeInteger(s.pid)) return false;
  try {
    return execFileSync("/bin/ps", ["-p", String(s.pid), "-o", "command="], {
      encoding: "utf8",
    }).includes(entry);
  } catch {
    return false;
  }
}
async function status() {
  const saved = state();
  if (!owned(saved)) {
    console.log("明庭已停止");
    return;
  }
  const response = await fetch(base + "/api/bootstrap", {
    signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) throw new Error(`平台响应 ${response.status}`);
  const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  const online = await fetch(base + "/api/harnesses", {
    headers: { cookie },
    signal: AbortSignal.timeout(2500),
  }).then((r) => r.json());
  console.log(
    JSON.stringify(
      { pid: saved.pid, url: base, mcp: base + "/mcp", harnesses: online },
      null,
      2,
    ),
  );
}
if (action === "start") {
  if (owned(state())) {
    await status();
  } else {
    // Refuse to start over a listener already using the requested port.
    let listening = false;
    try {
      await fetch(base + "/api/bootstrap", {
        signal: AbortSignal.timeout(1000),
      });
      listening = true;
    } catch {}
    if (listening) throw new Error("目标端口已有服务，请先确认现有进程");
    mkdirSync(join(root, "var"), { recursive: true, mode: 0o700 });
    const log = openSync(join(root, "var/service.log"), "a", 0o600);
    const child = spawn(
      process.execPath,
      [
        "--env-file-if-exists=.env",
        "--import",
        import.meta.resolve("tsx"),
        entry,
      ],
      {
        cwd: root,
        env: process.env,
        stdio: ["ignore", log, log],
        detached: true,
      },
    );
    child.unref();
    closeSync(log);
    writeFileSync(
      stateFile,
      JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
    let ready = false;
    for (let i = 0; i < 30; i++) {
      await delay(200);
      if (!owned(state())) break;
      try {
        const r = await fetch(base + "/api/bootstrap", {
          signal: AbortSignal.timeout(500),
        });
        if (r.ok) {
          ready = true;
          break;
        }
      } catch {}
    }
    if (!ready) throw new Error("启动失败，请查看 var/service.log");
    await delay(500);
    await status();
  }
} else if (action === "stop") {
  const saved = state();
  if (owned(saved)) {
    process.kill(saved.pid, "SIGTERM");
    for (let i = 0; i < 50 && owned(saved); i++) await delay(200);
    if (owned(saved)) throw new Error("服务尚在停止，请查看日志后重试");
  }
  try {
    unlinkSync(stateFile);
  } catch {}
  console.log("明庭已停止");
} else if (action === "status") await status();
else throw new Error("用法：node scripts/local-service.mjs start|stop|status");
