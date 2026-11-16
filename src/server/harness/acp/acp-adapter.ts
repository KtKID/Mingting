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
  contextObservationSchema,
} from "../../../shared/protocol.js";
import {
  applySettings,
  choices,
  selectOption,
  type SetOption,
} from "./acp-settings.js";
import { stopAcpProcess } from "./acp-process.js";
export type AcpTelemetry = {
  usage(
    result: unknown,
    modelId: string | null,
    sessionId: string,
    adapterVersion: string,
    protocolVersion: number,
  ): { usage: RunUsage; evidence: unknown } | undefined;
  recoverUsage?(
    usage: RunUsage,
  ): Promise<{ usage: RunUsage; evidence: unknown } | undefined>;
  modelWindow?(
    modelId: string | null,
    session: unknown,
  ): SettingsReceipt["modelWindow"];
  context?(
    notification: SessionNotification,
    modelId: string | null,
    session: unknown,
  ): ContextObservation | undefined;
};
export type AdapterConfig = {
  command: string;
  args: string[];
  workspace: string;
  env: NodeJS.ProcessEnv;
  authMethod?: "api-key" | "cached_token";
  mode?: "fake" | "codex";
  harnessName?: string;
  sessionMode?: "workspace-write" | "plan" | null;
  telemetry?: AcpTelemetry;
  evidence?: (event: {
    method: string;
    sessionId: string;
    data: unknown;
    at: string;
  }) => void;
};
export type RunHooks = {
  diagnosticContext?: {
    taskId: string;
    runId: string;
    taskTurn: number | null;
  };
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
export type TaskExecutor = Pick<AcpAdapter, "workspace" | "mode" | "execute"> &
  Partial<Pick<AcpAdapter, "probeCapabilities" | "executeTask">>;
export class AcpAdapter {
  /** 保存 ACP 子进程、会话及用量审计配置。 */
  constructor(private config: AdapterConfig) {}
  /** 返回 ACP 会话使用的工作目录。 */
  get workspace() {
    return this.config.workspace;
  }
  /** 返回适配器模式，配置缺省时使用 Codex 模式。 */
  get mode() {
    return this.config.mode ?? "codex";
  }
  /** 沿用适配器配置创建副本，接入本次运行的证据收集器。 */
  withEvidence(evidence: AdapterConfig["evidence"]) {
    return new AcpAdapter({ ...this.config, evidence });
  }
  /** 向配置的证据收集器提交带时间戳的会话记录。 */
  private record(method: string, sessionId: string, data: unknown) {
    this.config.evidence?.({
      method,
      sessionId,
      data,
      at: new Date().toISOString(),
    });
  }
  /** 通过 ACP 发送提示，可指定要恢复的原会话。 */
  async execute(
    text: string,
    signal: AbortSignal,
    hooks: RunHooks,
    existingSessionId?: string,
  ): Promise<string> {
    return this.run(text, signal, hooks, existingSessionId);
  }
  /** 运行正式任务，在发送提示前回报设置，并收集或恢复主回合用量。 */
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
    let sessionDetails: unknown;
    /** 补齐窗口信息和确认时间，提交设置回执并记录证据。 */
    const send = async (
      receipt: Omit<SettingsReceipt, "confirmedAt" | "modelWindow">,
    ) => {
      receiptAttempted = true;
      const confirmed = {
        ...receipt,
        modelWindow:
          this.config.telemetry?.modelWindow?.(
            receipt.modelId,
            sessionDetails,
          ) ?? null,
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
          /** 保存本次运行的会话 ID，并通知上层。 */
          session: (id) => {
            sessionId = id;
            hooks.session(id);
          },
        },
        undefined,
        async (options, setOption, session) => {
          // 应用会话设置并回读模型与推理强度，再发送设置回执。
          sessionDetails = session;
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
          // 提取主回合用量并保存对应的原始计数证据。
          const mapped = this.config.telemetry?.usage(
            result,
            modelId,
            id,
            init.agentInfo?.version ?? "unknown",
            init.protocolVersion,
          );
          if (!mapped) return;
          usage = mapped.usage;
          this.record("session/prompt.result", id, {
            stopReason: result?.stopReason ?? null,
            usage: mapped.evidence,
            adapterVersion: usage.source.adapterVersion,
            protocolVersion: init.protocolVersion,
          });
        },
        /* 提供回读确认后的模型 ID，用于解释会话中的用量更新。 */ () => modelId,
      );
      if (stopReason === "end_turn" && usage?.coverage === "missing") {
        const recovered = await this.config.telemetry?.recoverUsage?.(usage);
        if (recovered) {
          usage = recovered.usage;
          this.record(
            usage.source.method,
            usage.source.sessionId,
            recovered.evidence,
          );
        }
      }
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
              : "ACP 设置失败",
        });
      throw error;
    }
  }
  /** 加载原会话，验证其可恢复并返回初始化能力信息。 */
  async probeSession(sessionId: string, signal: AbortSignal) {
    let discovery: InitializeResponse | undefined;
    await this.run(
      undefined,
      signal,
      {
        /** 会话身份由加载请求指定，无需另外处理会话通知。 */
        session: () => {},
        /** 保存初始化阶段返回的执行器能力。 */
        discovery: (value) => {
          discovery = value;
        },
        /** 探测阶段忽略会话进度通知。 */
        update: () => {},
        /** 探测阶段收到的权限请求一律取消。 */
        permission: async () => ({ outcome: { outcome: "cancelled" } }),
      },
      sessionId,
    );
    if (!discovery) throw new Error("ACP 能力响应缺失");
    return discovery;
  }
  /** 建立有超时限制的探测会话，逐个回读模型和可选推理强度。 */
  async probeCapabilities(
    signal: AbortSignal,
  ): Promise<CapabilitySnapshot | undefined> {
    let snapshot: CapabilitySnapshot | undefined;
    await this.run(
      undefined,
      AbortSignal.any([signal, AbortSignal.timeout(LIMITS.initMs)]),
      {
        /** 能力探测无需向上层报告临时会话 ID。 */
        session: () => {},
        /** 能力快照从会话设置生成，忽略初始化通知。 */
        discovery: () => {},
        /** 能力探测忽略会话进度通知。 */
        update: () => {},
        /** 能力探测收到的权限请求一律取消。 */
        permission: async () => ({ outcome: { outcome: "cancelled" } }),
      },
      undefined,
      async (options, setOption) => {
        // 逐个切换并回读模型，收集每个模型提供的推理强度。
        const model = selectOption(options, "model");
        if (!model) return;
        const models = [];
        for (const choice of choices(model)) {
          if (choice.id !== selectOption(options, "model")?.currentValue)
            options = await setOption(model.id, choice.id);
          if (selectOption(options, "model")?.currentValue !== choice.id)
            throw new Error("ACP 探测未确认所选模型");
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
  /** 启动并管理 ACP 子进程，完成初始化、会话配置、提示执行与进程清理。 */
  private async run(
    text: string | undefined,
    signal: AbortSignal,
    hooks: RunHooks,
    existingSessionId?: string,
    inspect?: (
      options: SessionConfigOption[] | undefined,
      setOption: SetOption,
      session: unknown,
    ) => Promise<void>,
    complete?: (
      result: PromptResponse | undefined,
      sessionId: string,
      init: InitializeResponse,
    ) => void,
    currentModel?: () => string | null,
  ): Promise<string> {
    signal.throwIfAborted();
    const child = spawn(this.config.command, this.config.args, {
      cwd: this.config.workspace,
      env: this.config.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const exited = once(child, "exit").then(
      () => {},
      () => {},
    );
    const name = this.config.harnessName ?? "Codex";
    const log = (event: string, fields: Record<string, unknown> = {}) => {
      console.info(
        JSON.stringify({
          event,
          at: new Date().toISOString(),
          harness: name,
          acpPid: child.pid ?? null,
          ...hooks.diagnosticContext,
          ...fields,
        }),
      );
    };
    log("acp.process.spawn");
    // Drain stderr without exposing credential-bearing adapter diagnostics to the web.
    child.stderr.resume();
    child.stdin.on(
      "error",
      /* 吸收关闭连接时输入管道可能发出的错误事件。 */ () => {},
    );
    let sessionId: string | undefined;
    let sessionDetails: unknown;
    let promptStarted = false;
    let requestSeq = 0;
    let previousContext: ContextObservation | undefined;
    const connection = client({ name: "task-platform-mvp" })
      .onNotification(methods.client.session.update, (ctx) => {
        // 接收当前会话的进度，分流上下文用量并去重执行器自定义观测。
        if (ctx.params.sessionId !== sessionId || signal.aborted) return;
        const update = ctx.params.update;
        if (complete && sessionId && promptStarted) {
          const observation =
            update.sessionUpdate === "usage_update"
              ? contextObservationSchema.safeParse({
                  usedTokens: update.used,
                  effectiveWindowTokens: update.size,
                  source: "acp_usage_update",
                }).data
              : this.config.telemetry?.context?.(
                  ctx.params,
                  currentModel?.() ?? null,
                  sessionDetails,
                );
          if (
            observation &&
            (observation.source === "acp_usage_update" ||
              observation.usedTokens !== previousContext?.usedTokens ||
              observation.effectiveWindowTokens !==
                previousContext?.effectiveWindowTokens ||
              observation.source !== previousContext?.source)
          ) {
            previousContext = observation;
            this.record("session/update.usage_update", sessionId, {
              used: observation.usedTokens,
              size: observation.effectiveWindowTokens,
              source: observation.source,
            });
            hooks.context?.(sessionId, observation);
          }
        }
        if (!complete || update.sessionUpdate !== "usage_update")
          hooks.update(ctx.params);
      })
      .onRequest(methods.client.session.requestPermission, async (ctx) => {
        // 把当前会话的审批交给上层，记录审批选项及最终结果。
        if (signal.aborted || ctx.params.sessionId !== sessionId)
          return { outcome: { outcome: "cancelled" } };
        if (complete && sessionId)
          this.record("session/request_permission", sessionId, {
            requestId: ctx.requestId,
            toolCallId: ctx.params.toolCall.toolCallId,
            options: ctx.params.options.map(
              /* 审计只保留审批选项 ID 和类别。 */ ({ optionId, kind }) => ({
                optionId,
                kind,
              }),
            ),
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
      // 将子进程启动失败或退出转成请求可感知的失败信号。
      child.once(
        "error",
        /* 报告启动失败，引导检查执行器安装和配置。 */ () =>
          reject(new Error(`无法启动 ${name} ACP 进程，请检查安装及配置。`)),
      );
      child.once(
        "exit",
        /* 子进程退出时结束仍在等待的 ACP 请求。 */ () =>
          reject(new Error("ACP 子进程已退出。")),
      );
    });
    // A rejected background promise must always have a handler, even during shutdown.
    void failed.catch(/* 为后台进程失败预先挂接拒绝处理。 */ () => {});
    /** 收到取消信号时通知当前 ACP 会话。 */
    const abort = () => {
      if (sessionId)
        void connection.agent
          .notify(methods.agent.session.cancel, { sessionId })
          .catch(/* 取消通知采用尽力投递，连接关闭时忽略发送失败。 */ () => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    const aborted = new Promise<never>((_, reject) => {
      // 把取消信号转换为可参与请求竞速的拒绝结果。
      if (signal.aborted) reject(signal.reason);
      else
        signal.addEventListener(
          "abort",
          /* 在取消发生时携带原始原因结束等待。 */ () => reject(signal.reason),
          {
            once: true,
          },
        );
    });
    try {
      /** 同时等待协议响应、进程退出、取消和超时，结束后清理计时器。 */
      const request = async <T>(
        method: string,
        send: () => Promise<T>,
        ms: number = LIMITS.initMs,
      ): Promise<T> => {
        const fields = { method, requestSeq: ++requestSeq, timeoutMs: ms };
        const startedAt = performance.now();
        let outcome = "error";
        let timer: NodeJS.Timeout | undefined;
        log("acp.request.started", fields);
        try {
          const result = await Promise.race([
            send(),
            failed,
            aborted,
            new Promise<never>((_, reject) => {
              // 为当前请求安排独立的超时上限。
              timer = setTimeout(() => {
                outcome = "timeout";
                reject(new Error("ACP 请求超时"));
              }, ms);
            }),
          ]);
          outcome = "ok";
          return result;
        } finally {
          clearTimeout(timer);
          log("acp.request.finished", {
            ...fields,
            elapsedMs: Math.round(performance.now() - startedAt),
            outcome: signal.aborted ? "aborted" : outcome,
            promptStarted,
          });
        }
      };
      const init = await request(methods.agent.initialize, () =>
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
      log("acp.initialized", {
        adapterVersion: init.agentInfo?.version?.slice(0, 64) ?? null,
        protocolVersion: init.protocolVersion,
      });
      hooks.discovery(init);
      if (this.config.authMethod) {
        if (
          !init.authMethods?.some(
            /* 确认执行器支持配置中指定的认证方式。 */ (m) =>
              m.id === this.config.authMethod,
          )
        )
          throw new Error("适配器不支持所选认证方式");
        await request(methods.agent.authenticate, () =>
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
        // 有原会话 ID 时加载该会话，否则在当前工作目录新建会话。
        if (existingSessionId)
          return {
            ...(await request(methods.agent.session.load, () =>
              connection.agent.request(methods.agent.session.load, {
                sessionId: existingSessionId,
                cwd: this.config.workspace,
                mcpServers: [],
              }),
            )),
            sessionId: existingSessionId,
          };
        return request(methods.agent.session.new, () =>
          connection.agent.request(methods.agent.session.new, {
            cwd: this.config.workspace,
            mcpServers: [],
          }),
        );
      })();
      sessionId = session.sessionId;
      sessionDetails = session;
      log("acp.session.ready", { sessionId: sessionId.slice(0, 128) });
      hooks.session(sessionId);
      /** 将会话设置、写入选项的方法和会话元数据交给检查回调。 */
      const configure = () =>
        inspect?.(
          session.configOptions ?? undefined,
          /* 写入指定的 ACP 设置，并返回执行器回读的选项。 */ async (
            configId,
            value,
          ) =>
            (
              await request(methods.agent.session.setConfigOption, () =>
                connection.agent.request(
                  methods.agent.session.setConfigOption,
                  { sessionId: session.sessionId, configId, value },
                ),
              )
            ).configOptions,
          session,
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
        if (
          !session.modes?.availableModes.some(
            /* 确认会话提供即将设置的执行模式。 */ (m) => m.id === mode,
          )
        )
          throw new Error(`适配器未提供 ${mode} 模式，已停止。`);
        await request(methods.agent.session.setMode, () =>
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
      promptStarted = true;
      const prompt = connection.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text }],
      });
      let result: PromptResponse;
      try {
        result = await request(
          methods.agent.session.prompt,
          () => prompt,
          LIMITS.runMs,
        );
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
          ]).catch(
            /* 在取消后的收尾等待中将连接失败视为缺少最终响应。 */ () =>
              undefined,
          );
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
      const cleanupStartedAt = performance.now();
      let outcome = "error";
      const cleanupFields = {
        sessionId: sessionId?.slice(0, 128) ?? null,
        promptStarted,
      };
      log("acp.cleanup.started", cleanupFields);
      try {
        await stopAcpProcess(child, exited);
        outcome = "ok";
      } finally {
        connection.close();
        log("acp.cleanup.finished", {
          ...cleanupFields,
          outcome,
          elapsedMs: Math.round(performance.now() - cleanupStartedAt),
          exitCode: child.exitCode,
          signal: child.signalCode,
        });
      }
    }
  }
}
