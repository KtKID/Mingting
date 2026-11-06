import { statSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir, userInfo } from "node:os";
import { createRequire } from "node:module";
import { CodexAdapter } from "./codex-adapter.js";
import { AcpAdapter, type AdapterConfig } from "./acp-adapter.js";
import { z } from "zod";
import { grokTelemetry } from "./grok-acp-mapping.js";
import { projectDirectory as localRoot, projectPath } from "./local-path.js";
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
  for (const key of [
    "CODEX_HOME",
    "CODEX_API_KEY",
    "OPENAI_API_KEY",
    "CODEX_CONFIG",
    "INITIAL_AGENT_MODE",
  ])
    delete nativeEnv[key];
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
  if (!fake) {
    if (harnessName === "Grok") {
      const root = localRoot(process.env.TASK_GROK_HOME ?? "var/grok-local");
      Object.assign(nativeEnv, {
        HOME: localRoot(resolve(root, "home")),
        GROK_HOME: root,
        GROK_AUTH_PATH: projectPath(resolve(root, "auth.json")),
        GROK_CONFIG_PATH: projectPath(resolve(root, "config.toml")),
        GROK_DISABLE_AUTOUPDATER: "1",
        GROK_AUTO_UPDATE: "0",
      });
    } else if (harnessName === "ZCode") {
      const root = localRoot(
        nativeEnv.ZCODE_DATA_BASE_DIR ?? "var/zcode-local",
      );
      const state = localRoot(nativeEnv.ZCODE_HOME ?? resolve(root, ".zcode"));
      Object.assign(nativeEnv, {
        HOME: root,
        USERPROFILE: root,
        XDG_CONFIG_HOME: localRoot(resolve(root, "xdg")),
        ZCODE_HOME: state,
        ZCODE_DATA_BASE_DIR: root,
        ZCODE_STORAGE_DIR: state,
        ZCODE_SESSION_DB_PATH: projectPath(
          nativeEnv.ZCODE_SESSION_DB_PATH ?? resolve(state, "cli/db/db.sqlite"),
        ),
        ZCODE_CREDENTIAL_SECRET:
          process.env.ZCODE_CREDENTIAL_SECRET ??
          `zcode-credential-fallback:${process.platform}:${homedir()}:${userInfo().username}`,
      });
      for (const key of [
        "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
        "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
      ]) {
        const path = nativeEnv[key];
        if (!path)
          throw new Error("ZCode 需要项目内的 builtin/personal 模型配置");
        nativeEnv[key] = projectPath(path);
      }
    } else {
      env.CODEX_HOME = localRoot(process.env.CODEX_HOME ?? "var/codex-local");
      projectPath(resolve(env.CODEX_HOME, "auth.json"));
      env.HOME = localRoot("var/codex-local/home");
    }
  }
  const config: AdapterConfig = {
    mode: fake ? "fake" : "codex",
    harnessName,
    command: !fake && harnessName === "Grok" ? "grok" : process.execPath,
    args: fake
      ? ["--import", import.meta.resolve("tsx"), resolve("tests/fake-acp.ts")]
      : harnessName === "Grok"
        ? [
            "--cwd",
            workspace,
            "--tools",
            "Read",
            "--no-subagents",
            "--disable-web-search",
            "--permission-mode",
            "plan",
            "agent",
            "--no-leader",
            "stdio",
          ]
        : harnessName === "ZCode"
          ? [
              "--import",
              import.meta.resolve("tsx"),
              resolve("scripts/zcode-acp.ts"),
            ]
          : [require.resolve("@agentclientprotocol/codex-acp")],
    workspace,
    authMethod:
      !fake && harnessName === "Grok"
        ? "cached_token"
        : !fake && harnessName === "Codex" && auth === "api-key"
          ? "api-key"
          : undefined,
    sessionMode:
      !fake && harnessName === "Grok"
        ? null
        : !fake && harnessName === "ZCode"
          ? "plan"
          : "workspace-write",
    env: fake
      ? { PATH: process.env.PATH }
      : harnessName === "Codex"
        ? env
        : nativeEnv,
  };
  const adapter =
    harnessName === "Codex"
      ? new CodexAdapter(config)
      : new AcpAdapter({
          ...config,
          telemetry: harnessName === "Grok" ? grokTelemetry : undefined,
        });
  return {
    workspace,
    adapter,
    mode: fake ? ("fake" as const) : ("codex" as const),
    harnessName,
  };
}
