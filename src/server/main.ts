import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createPlatform } from "./transport/http.js";
import { runtime, executableHarnessSchema } from "./harness/runtime.js";
import { configuredCodexWakeups } from "./wakeup/codex-wakeup.js";
import { configuredWakeupHosts } from "./transport/host-wakeup.js";
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
  wakeupHosts: configuredWakeupHosts(),
});
const server = createServer(platform.app);
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.timeout = 30000;
const children: ReturnType<typeof spawn>[] = [];
let stopping = false;
server.listen(port, "127.0.0.1", () => {
  // 服务开始监听后按配置启动各执行器的订阅连接器。
  console.log(
    `任务台 http://127.0.0.1:${port} | ${config.mode === "fake" ? "FAKE ACP（测试子进程）" : "Codex ACP"} | MCP /mcp | 订阅 /connector/events`,
  );
  if (process.env.TASK_CONNECTOR !== "manual") {
    const harnesses = (process.env.TASK_HARNESSES ?? "Codex")
      .split(",")
      .map(
        /* 清理配置中的名称并校验每种执行器。 */ (name) =>
          executableHarnessSchema.parse(name.trim()),
      );
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
        // 报告连接器的意外退出，提示排队任务仍可认领。
        if (!stopping)
          console.error(
            `${harnessName} 订阅连接器已退出（${code}）；排队任务保留。可手动重启 npm run connector。`,
          );
      });
    }
  }
});
/** 幂等关闭任务服务和连接器，随后停止监听并释放数据库。 */
async function stop() {
  if (stopping) return;
  stopping = true;
  await platform.service.close();
  for (const child of children) child.kill("SIGTERM");
  server.close(() => {
    // 监听器关闭后释放 SQLite 连接并退出进程。
    platform.store.close();
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.once("SIGINT", /* 收到中断信号时开始关闭服务。 */ () => void stop());
process.once("SIGTERM", /* 收到终止信号时开始关闭服务。 */ () => void stop());
