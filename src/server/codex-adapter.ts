import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { once } from "node:events";
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type JsonRpcId,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { LIMITS } from "../shared/protocol.js";
export type AdapterConfig = {
  command: string;
  args: string[];
  workspace: string;
  env: NodeJS.ProcessEnv;
  authMethod?: "api-key" | "cached_token";
  mode?: "fake" | "codex";
  harnessName?: string;
  sessionMode?: "workspace-write" | "plan" | null;
};
export type RunHooks = {
  session(id: string): void;
  discovery(value: InitializeResponse): void;
  update(value: SessionNotification): void;
  permission(
    id: JsonRpcId,
    request: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse>;
};
export type TaskExecutor = Pick<CodexAdapter, "workspace" | "mode" | "execute">;
export class CodexAdapter {
  constructor(private config: AdapterConfig) {}
  get workspace() {
    return this.config.workspace;
  }
  get mode() {
    return this.config.mode ?? "codex";
  }
  async execute(
    text: string,
    signal: AbortSignal,
    hooks: RunHooks,
  ): Promise<string> {
    signal.throwIfAborted();
    const child = spawn(this.config.command, this.config.args, {
      cwd: this.config.workspace,
      env: this.config.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const name = this.config.harnessName ?? "Codex";
    console.info(`${name} ACP 已启动 pid=${child.pid}`);
    // Drain stderr without exposing credential-bearing adapter diagnostics to the web.
    child.stderr.resume();
    child.stdin.on("error", () => {});
    let sessionId: string | undefined;
    const connection = client({ name: "task-platform-mvp" })
      .onNotification(methods.client.session.update, (ctx) => {
        if (ctx.params.sessionId === sessionId && !signal.aborted)
          hooks.update(ctx.params);
      })
      .onRequest(methods.client.session.requestPermission, (ctx) => {
        if (signal.aborted || ctx.params.sessionId !== sessionId)
          return { outcome: { outcome: "cancelled" } };
        return hooks.permission(ctx.requestId, ctx.params, ctx.signal);
      })
      .connect(
        ndJsonStream(
          Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
          { maxMessageBytes: LIMITS.acpBytes },
        ),
      );
    const failed = new Promise<never>((_, reject) => {
      child.once("error", () =>
        reject(new Error(`无法启动 ${name} ACP 进程，请检查安装及配置。`)),
      );
      child.once("exit", () => reject(new Error("ACP 子进程已退出。")));
    });
    // A rejected background promise must always have a handler, even during shutdown.
    void failed.catch(() => {});
    const abort = () => {
      if (sessionId)
        void connection.agent
          .notify(methods.agent.session.cancel, { sessionId })
          .catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
    });
    try {
      const request = async <T>(
        p: Promise<T>,
        ms: number = LIMITS.initMs,
      ): Promise<T> => {
        let timer: NodeJS.Timeout | undefined;
        try {
          return await Promise.race([
            p,
            failed,
            aborted,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("ACP 请求超时")), ms);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      const init = await request(
        connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "task-platform-mvp", version: "0.2.0" },
        }),
      );
      if (init.protocolVersion !== PROTOCOL_VERSION)
        throw new Error("ACP 协议版本不兼容。");
      hooks.discovery(init);
      if (this.config.authMethod) {
        if (!init.authMethods?.some((m) => m.id === this.config.authMethod))
          throw new Error("适配器不支持所选认证方式");
        await request(
          connection.agent.request(methods.agent.authenticate, {
            methodId: this.config.authMethod,
            ...(this.config.authMethod === "cached_token"
              ? { _meta: { headless: true } }
              : {}),
          }),
        );
      }
      // Existing login is the default. API-key authentication requires an explicit server-side opt-in.
      const session = await request(
        connection.agent.request(methods.agent.session.new, {
          cwd: this.config.workspace,
          mcpServers: [],
        }),
      );
      sessionId = session.sessionId;
      hooks.session(sessionId);
      // Codex defaults to human-reviewed workspace access. Grok's plan policy is fixed at launch.
      const mode =
        this.config.sessionMode === undefined
          ? "workspace-write"
          : this.config.sessionMode;
      if (mode !== null) {
        if (!session.modes?.availableModes.some((m) => m.id === mode))
          throw new Error(`适配器未提供 ${mode} 模式，已停止。`);
        await request(
          connection.agent.request(methods.agent.session.setMode, {
            sessionId,
            modeId: mode,
          }),
        );
      }
      const result = await request(
        connection.agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text }],
        }),
        LIMITS.runMs,
      );
      return result.stopReason;
    } catch (e) {
      if (signal.aborted) throw signal.reason;
      if (
        e instanceof Error &&
        /auth|login|credential|unauth|401/i.test(e.message)
      )
        throw new Error(
          `${name} 需要认证。请检查项目内登录或显式 API key 配置后重试。`,
        );
      throw e;
    } finally {
      signal.removeEventListener("abort", abort);
      child.stdin.end();
      const exited = once(child, "close").then(
        () => true,
        () => true,
      );
      const kill = (sig: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && child.pid)
            process.kill(-child.pid, sig);
          else if (child.exitCode === null && child.signalCode === null)
            child.kill(sig);
        } catch {}
      };
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<boolean>((r) => {
        timer = setTimeout(() => r(false), LIMITS.killMs);
      });
      const stopped =
        child.exitCode !== null ||
        child.signalCode !== null ||
        (await Promise.race([exited, timeout]));
      clearTimeout(timer);
      if (stopped) kill("SIGTERM"); // Clean up any descendant left behind by the ACP leader.
      if (!stopped) {
        kill("SIGTERM");
        const hardKill = setTimeout(() => kill("SIGKILL"), LIMITS.killMs);
        await exited;
        clearTimeout(hardKill);
      }
      connection.close();
    }
  }
}
