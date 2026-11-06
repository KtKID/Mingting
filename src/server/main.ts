import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createPlatform } from "./http.js";
import { runtime, executableHarnessSchema } from "./runtime.js";
import { configuredCodexWakeups } from "./codex-wakeup.js";
import { configuredDshWakeupHost } from "./dsh-wakeup.js";
const port = Number(process.env.PORT ?? 60390);
if (!Number.isInteger(port) || port < 60001 || port > 65535)
  throw new Error("PORT 必须在 60001–65535 之间");
const config = runtime();
const wakeupDelivery = await configuredCodexWakeups();
if (wakeupDelivery)
  console.log("聊天唤醒宿主", JSON.stringify(wakeupDelivery.status()));
const platform = createPlatform({
  dbPath: resolve(process.env.TASK_DB ?? "var/tasks.sqlite"),
  workspace: config.workspace,
  mode: config.mode,
  wakeupDelivery,
  dshWakeupHost: configuredDshWakeupHost(),
});
const server = createServer(platform.app);
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.timeout = 30000;
const children: ReturnType<typeof spawn>[] = [];
let stopping = false;
server.listen(port, "127.0.0.1", () => {
  console.log(
    `任务台 http://127.0.0.1:${port} | ${config.mode === "fake" ? "FAKE ACP（测试子进程）" : "Codex ACP"} | MCP /mcp | 订阅 /connector/events`,
  );
  if (process.env.TASK_CONNECTOR !== "manual") {
    const harnesses = (process.env.TASK_HARNESSES ?? "Codex")
      .split(",")
      .map((name) => executableHarnessSchema.parse(name.trim()));
    for (const harnessName of new Set(harnesses)) {
      const child = spawn(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          resolve("src/connector/main.ts"),
        ],
        {
          cwd: process.cwd(),
          stdio: ["ignore", "inherit", "inherit"],
          env: {
            ...process.env,
            TASK_PLATFORM_URL: `http://127.0.0.1:${port}`,
            TASK_WORKSPACE: config.workspace,
            TASK_HARNESS: harnessName,
          },
        },
      );
      children.push(child);
      child.once("exit", (code) => {
        if (!stopping)
          console.error(
            `${harnessName} 订阅连接器已退出（${code}）；排队任务保留。可手动重启 npm run connector。`,
          );
      });
    }
  }
});
async function stop() {
  if (stopping) return;
  stopping = true;
  await platform.service.close();
  for (const child of children) child.kill("SIGTERM");
  server.close(() => {
    platform.store.close();
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
