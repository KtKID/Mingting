import { statSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { CodexAdapter } from "./codex-adapter.js";
import { CliAdapter } from "./cli-adapter.js";
import { z } from "zod";
export const executableHarnessSchema = z.enum(["Codex", "ZCode", "Grok"]);
export function runtime() {
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
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
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
  const harnessName = executableHarnessSchema.parse(
    process.env.TASK_HARNESS ?? "Codex",
  );
  if (process.env.TASK_DIRECT_NETWORK === "1") {
    for (const key of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
    ])
      delete env[key];
  }
  const nativeEnv: NodeJS.ProcessEnv = { ...env };
  // Existing CLI accounts remain in their own login store. Only explicit runtime overrides pass through.
  for (const key of [
    "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
    "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
    "ZCODE_STORAGE_DIR",
    "ZCODE_SESSION_DB_PATH",
    "ZCODE_DATA_BASE_DIR",
    "ZCODE_HOME",
  ])
    if (process.env[key]) nativeEnv[key] = process.env[key];
  const adapter =
    !fake && harnessName !== "Codex"
      ? new CliAdapter({
          harnessName,
          workspace,
          env: nativeEnv,
          command: harnessName === "Grok" ? "grok" : "zcode",
          args:
            harnessName === "Grok"
              ? [
                  "--cwd",
                  workspace,
                  "--tools",
                  "",
                  "--no-subagents",
                  "--disable-web-search",
                  "--max-turns",
                  "1",
                  "--output-format",
                  "json",
                  "-p",
                ]
              : [
                  "--cwd",
                  workspace,
                  "--mode",
                  "plan",
                  "--workflow-mode",
                  "disabled",
                  "--disallowed-tools",
                  "Bash,Edit,Write,Read,Glob,Grep,WebSearch,WebFetch,Task",
                  "--json",
                  "-p",
                ],
        })
      : new CodexAdapter({
          mode: fake ? "fake" : "codex",
          command: process.execPath,
          args: fake
            ? [
                "--import",
                import.meta.resolve("tsx"),
                resolve("tests/fake-acp.ts"),
              ]
            : [require.resolve("@agentclientprotocol/codex-acp")],
          workspace,
          authMethod: !fake && auth === "api-key" ? "api-key" : undefined,
          env: fake ? { PATH: process.env.PATH } : env,
        });
  return {
    workspace,
    adapter,
    mode: fake ? ("fake" as const) : ("codex" as const),
    harnessName,
  };
}
