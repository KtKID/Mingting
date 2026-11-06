import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
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
  type SessionConfigOption,
  type PromptResponse,
} from "@agentclientprotocol/sdk";
import {
  capabilitySnapshotSchema,
  LIMITS,
  type CapabilitySnapshot,
  type RequestedSettings,
  type SettingsReceipt,
  type RunUsage,
  type ContextObservation,
} from "../shared/protocol.js";
import {
  applySettings,
  choices,
  codexContext,
  codexModelWindow,
  codexUsage,
  selectOption,
  type SetOption,
} from "./codex-task-mapping.js";
export type AdapterConfig = {
  command: string;
  args: string[];
  workspace: string;
  env: NodeJS.ProcessEnv;
  authMethod?: "api-key" | "cached_token";
  mode?: "fake" | "codex";
  harnessName?: string;
  sessionMode?: "workspace-write" | "plan" | null;
  evidence?: (event: {
    method: string;
    sessionId: string;
    data: unknown;
    at: string;
  }) => void;
};
export type RunHooks = {
  session(id: string): void;
  discovery(value: InitializeResponse): void;
  update(value: SessionNotification): void;
  context?(sessionId: string, observation: ContextObservation): void;
  permission(
    id: JsonRpcId,
    request: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse>;
};
export type TaskExecutor = Pick<
  CodexAdapter,
  "workspace" | "mode" | "execute"
> &
  Partial<Pick<CodexAdapter, "probeCapabilities" | "executeTask">>;
export class CodexAdapter {
  constructor(private config: AdapterConfig) {}
  get workspace() {
    return this.config.workspace;
  }
  get mode() {
    return this.config.mode ?? "codex";
  }
  withEvidence(evidence: AdapterConfig["evidence"]) {
    return new CodexAdapter({ ...this.config, evidence });
  }
  private record(method: string, sessionId: string, data: unknown) {
    this.config.evidence?.({
      method,
      sessionId,
      data,
      at: new Date().toISOString(),
    });
  }
  async execute(
    text: string,
    signal: AbortSignal,
    hooks: RunHooks,
    existingSessionId?: string,
  ): Promise<string> {
    return this.run(text, signal, hooks, existingSessionId);
  }
  async executeTask(
    text: string,
    signal: AbortSignal,
    hooks: RunHooks,
    settings: RequestedSettings | undefined,
    acknowledge: (
      sessionId: string | null,
      receipt: SettingsReceipt,
    ) => Promise<void>,
  ) {
    let sessionId: string | null = null;
    let receiptAttempted = false;
    let modelId: string | null = null;
    let usage: RunUsage | undefined;
    const send = async (
      receipt: Omit<SettingsReceipt, "confirmedAt" | "modelWindow">,
    ) => {
      receiptAttempted = true;
      const confirmed = {
        ...receipt,
        modelWindow: codexModelWindow(receipt.modelId),
        confirmedAt: new Date().toISOString(),
      };
      await acknowledge(sessionId, confirmed);
      if (sessionId)
        this.record("mingting/settings_committed", sessionId, confirmed);
    };
    try {
      const stopReason = await this.run(
        text,
        signal,
        {
          ...hooks,
          session: (id) => {
            sessionId = id;
            hooks.session(id);
          },
        },
        undefined,
        async (options, setOption) => {
          const applied = await applySettings(options, setOption, settings);
          modelId = applied.modelId;
          if (sessionId)
            this.record("session/config_readback", sessionId, applied);
          await send({
            ...applied,
            status: settings ? "applied" : "default",
            reason: null,
          });
        },
        (result, id, init) => {
          const mapped = codexUsage(
            result,
            modelId,
            id,
            init.agentInfo?.version ?? "unknown",
            init.protocolVersion,
          );
          usage = mapped.usage;
          this.record("session/prompt.result", id, {
            stopReason: result?.stopReason ?? null,
            usage: mapped.evidence,
            adapterVersion: usage.source.adapterVersion,
            protocolVersion: init.protocolVersion,
          });
        },
      );
      return { stopReason, usage };
    } catch (error) {
      if (usage)
        return {
          stopReason: null,
          usage,
          error:
            error instanceof Error
              ? error.message.slice(0, 2000)
              : "ACP 执行失败",
        };
      if (!receiptAttempted && settings && !signal.aborted)
        await send({
          status: "rejected",
          modelId: null,
          reasoningEffort: null,
          reason:
            error instanceof Error
              ? error.message.slice(0, 2000)
              : "Codex 设置失败",
        });
      throw error;
    }
  }
  async probeSession(sessionId: string, signal: AbortSignal) {
    let discovery: InitializeResponse | undefined;
    await this.run(
      undefined,
      signal,
      {
        session: () => {},
        discovery: (value) => {
          discovery = value;
        },
        update: () => {},
        permission: async () => ({ outcome: { outcome: "cancelled" } }),
      },
      sessionId,
    );
    if (!discovery) throw new Error("ACP 能力响应缺失");
    return discovery;
  }
  async probeCapabilities(
    signal: AbortSignal,
  ): Promise<CapabilitySnapshot | undefined> {
    let snapshot: CapabilitySnapshot | undefined;
    await this.run(
      undefined,
      AbortSignal.any([signal, AbortSignal.timeout(LIMITS.initMs)]),
      {
        session: () => {},
        discovery: () => {},
        update: () => {},
        permission: async () => ({ outcome: { outcome: "cancelled" } }),
      },
      undefined,
      async (options, setOption) => {
        const model = selectOption(options, "model");
        if (!model) return;
        const models = [];
        for (const choice of choices(model)) {
          if (choice.id !== selectOption(options, "model")?.currentValue)
            options = await setOption(model.id, choice.id);
          if (selectOption(options, "model")?.currentValue !== choice.id)
            throw new Error("Codex 探测未确认所选模型");
          models.push({
            ...choice,
            efforts: choices(selectOption(options, "reasoning_effort")),
          });
        }
        snapshot = capabilitySnapshotSchema.parse({
          models,
          defaultModelId: model.currentValue,
          source: "acp_session_config",
        });
      },
    );
    return snapshot;
  }
  private async run(
    text: string | undefined,
    signal: AbortSignal,
    hooks: RunHooks,
    existingSessionId?: string,
    inspect?: (
      options: SessionConfigOption[] | undefined,
      setOption: SetOption,
    ) => Promise<void>,
    complete?: (
      result: PromptResponse | undefined,
      sessionId: string,
      init: InitializeResponse,
    ) => void,
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
        if (ctx.params.sessionId !== sessionId || signal.aborted) return;
        const update = ctx.params.update;
        if (complete && sessionId && update.sessionUpdate === "usage_update") {
          const observation = codexContext(update);
          if (observation) {
            this.record("session/update.usage_update", sessionId, {
              used: update.used,
              size: update.size,
            });
            hooks.context?.(sessionId, observation);
          }
          return;
        }
        hooks.update(ctx.params);
      })
      .onRequest(methods.client.session.requestPermission, async (ctx) => {
        if (signal.aborted || ctx.params.sessionId !== sessionId)
          return { outcome: { outcome: "cancelled" } };
        if (complete && sessionId)
          this.record("session/request_permission", sessionId, {
            requestId: ctx.requestId,
            toolCallId: ctx.params.toolCall.toolCallId,
            options: ctx.params.options.map(({ optionId, kind }) => ({
              optionId,
              kind,
            })),
          });
        const result = await hooks.permission(
          ctx.requestId,
          ctx.params,
          ctx.signal,
        );
        if (complete && sessionId)
          this.record("session/request_permission.result", sessionId, {
            requestId: ctx.requestId,
            outcome: result.outcome,
          });
        return result;
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
      if (existingSessionId && !init.agentCapabilities?.loadSession)
        throw new Error("ACP 适配器缺少原会话加载能力");
      const session = await (async () => {
        if (existingSessionId)
          return {
            ...(await request(
              connection.agent.request(methods.agent.session.load, {
                sessionId: existingSessionId,
                cwd: this.config.workspace,
                mcpServers: [],
              }),
            )),
            sessionId: existingSessionId,
          };
        return request(
          connection.agent.request(methods.agent.session.new, {
            cwd: this.config.workspace,
            mcpServers: [],
          }),
        );
      })();
      sessionId = session.sessionId;
      hooks.session(sessionId);
      const configure = () =>
        inspect?.(
          session.configOptions ?? undefined,
          async (configId, value) =>
            (
              await request(
                connection.agent.request(
                  methods.agent.session.setConfigOption,
                  { sessionId: session.sessionId, configId, value },
                ),
              )
            ).configOptions,
        );
      if (text === undefined) {
        await configure();
        return "ready";
      }
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
      await configure();
      signal.throwIfAborted();
      if (complete)
        this.record("session/prompt", sessionId, { turnOrdinal: 1 });
      const prompt = connection.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text }],
      });
      let result: PromptResponse;
      try {
        result = await request(prompt, LIMITS.runMs);
      } catch (error) {
        if (!complete) throw error;
        if (!signal.aborted) {
          complete(undefined, sessionId, init);
          throw error;
        }
        const wait = new AbortController();
        try {
          const cancelled = await Promise.race([
            prompt,
            failed,
            delay(LIMITS.killMs, undefined, { signal: wait.signal }),
          ]).catch(() => undefined);
          complete(cancelled, sessionId, init);
          return "cancelled";
        } finally {
          wait.abort();
        }
      }
      complete?.(result, sessionId, init);
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
