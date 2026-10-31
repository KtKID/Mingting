import { createServer } from "node:http";
import { statSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { createPlatform } from "./http.js";
import { CodexAdapter } from "./codex-adapter.js";
const port = Number(process.env.PORT ?? 60390);
if (!Number.isInteger(port) || port < 60001 || port > 65535)
  throw new Error("PORT 必须在 60001–65535 之间");
const fake = process.env.FAKE_ACP === "1";
const auth = process.env.TASK_AUTH ?? "existing";
if (!["existing", "api-key"].includes(auth))
  throw new Error("TASK_AUTH 仅支持 existing 或 api-key");
if (
  !fake &&
  auth === "api-key" &&
  !process.env.CODEX_API_KEY &&
  !process.env.OPENAI_API_KEY
)
  throw new Error("api-key 模式需要显式提供 API key");
if (!fake && !process.env.TASK_WORKSPACE)
  throw new Error("真实运行前请显式设置 TASK_WORKSPACE");
const workspace = resolve(process.env.TASK_WORKSPACE ?? "var/demo-workspace");
if (fake) mkdirSync(workspace, { recursive: true, mode: 0o700 });
if (!statSync(workspace).isDirectory())
  throw new Error("TASK_WORKSPACE 必须是已存在的目录");
const env: NodeJS.ProcessEnv = {};
// Only explicitly needed adapter environment; do not forward arbitrary provider/config overrides.
for (const key of [
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "CODEX_HOME",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
])
  if (process.env[key]) env[key] = process.env[key];
env.NO_BROWSER = "1";
env.INITIAL_AGENT_MODE = "workspace-write";
env.CODEX_CONFIG = JSON.stringify({
  approval_policy: "on-request",
  approvals_reviewer: "user",
  sandbox_mode: "workspace-write",
});
const require = createRequire(import.meta.url);
const adapter = new CodexAdapter({
  command: process.execPath,
  args: fake
    ? ["--import", import.meta.resolve("tsx"), resolve("tests/fake-acp.ts")]
    : [require.resolve("@agentclientprotocol/codex-acp")],
  workspace,
  authMethod: !fake && auth === "api-key" ? "api-key" : undefined,
  env: fake ? { PATH: process.env.PATH } : env,
});
const platform = createPlatform({
  dbPath: resolve(process.env.TASK_DB ?? "var/tasks.sqlite"),
  workspace,
  adapter,
  mode: fake ? "fake" : "codex",
});
const server = createServer(platform.app);
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.timeout = 30000;
server.listen(port, "127.0.0.1", () =>
  console.log(
    `任务台 http://127.0.0.1:${port} | ${fake ? "FAKE ACP（演示，无真实模型）" : "Codex ACP"} | MCP /mcp`,
  ),
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await platform.service.close();
  server.close(() => {
    platform.store.close();
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
