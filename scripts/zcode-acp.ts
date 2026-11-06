// Project ACP bridge to ZCode's native, bidirectional app-server protocol.
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionNotification,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";
import { LIMITS } from "../src/shared/protocol.js";
import { translateZcodeLine } from "../src/server/zcode-stream.js";
import {
  ZcodeNative,
  nativeSessionSchema,
  mapZcodePermission,
  nativeDeferred,
} from "../src/server/zcode-native.js";
import { loadZcodeAccount } from "../src/server/zcode-account.js";
import { z } from "zod";

const workspace = realpathSync(
  resolve(process.env.TASK_WORKSPACE ?? process.cwd()),
);
const sessionId = randomUUID();
let created = false,
  used = false;
let active: AbortController | undefined;
const modes = {
  currentModeId: "plan",
  availableModes: [{ id: "plan", name: "只读工具 · 明庭审批" }],
};
const modelReference = z.object({
  providerId: z.string(),
  modelId: z.string(),
  options: z.record(z.string(), z.unknown()).optional(),
});
const nativeSettings = z.object({
  settings: z.object({
    model: z.object({
      current: modelReference,
      available: z.array(
        z.object({
          ref: modelReference,
          label: z.string(),
          contextWindow: z.number().int().positive().optional(),
          reasoning: z
            .object({
              defaultLevel: z.string().optional(),
              levels: z.array(
                z.object({ value: z.string(), label: z.string() }),
              ),
            })
            .optional(),
        }),
      ),
    }),
    thoughtLevel: z
      .object({
        current: z.string().nullish(),
        available: z.array(z.object({ value: z.string(), label: z.string() })),
      })
      .optional(),
  }),
});
type NativeSettings = z.infer<typeof nativeSettings>["settings"];
const nativeUsage = z.object({
  sessionId: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  modelRequestCount: z.number().int().nonnegative(),
  modelErrorCount: z.number().int().nonnegative(),
});
const nativeContext = z.object({
  projection: z.object({
    contextUsed: z.number().int().nonnegative(),
    contextWindow: z.number().int().positive(),
  }),
});

let native: ZcodeNative | undefined;
let nativeSessionId: string | undefined;
let account: Awaited<ReturnType<typeof loadZcodeAccount>>;
let snapshot: NativeSettings | undefined;
let catalog: NativeSettings["model"]["available"] = [];
let onRequest:
  ((method: string, params: unknown) => Promise<unknown>) | undefined;
let onEvent:
  | ((
      event: z.infer<
        typeof import("../src/server/zcode-native.js").nativeEventSchema
      >,
    ) => Promise<void>)
  | undefined;

const readOnlyPreferences = {
  nativeSearchEnhancementsEnabled: false,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: false,
  subagentRuntimeConfigEnabled: false,
  toolSearchMode: "off",
};

function readSnapshot(raw: unknown, required = false) {
  const settings = nativeSettings.safeParse(raw).data?.settings;
  if (!settings) {
    if (required) throw new Error("ZCode 设置回读缺失");
    return;
  }
  snapshot = settings;
  // session/create returns the catalog; later readback may expose only the active model.
  for (const model of settings.model.available) {
    const index = catalog.findIndex(
      (entry) =>
        entry.ref.providerId === model.ref.providerId &&
        entry.ref.modelId === model.ref.modelId,
    );
    if (index < 0) catalog.push(model);
  }
}

function configOptions(): SessionConfigOption[] {
  if (!snapshot) return [];
  const current = snapshot.model.current;
  const available = catalog.filter(
    (item) => item.ref.providerId === current.providerId,
  );
  const result: SessionConfigOption[] = [
    {
      id: "model",
      name: "Model",
      type: "select",
      category: "model",
      currentValue: current.modelId,
      options: available.map(({ ref, label }) => ({
        value: ref.modelId,
        name: label,
      })),
    },
  ];
  const thought = snapshot.thoughtLevel;
  const currentEffort =
    thought?.current ??
    z.string().safeParse(current.options?.reasoningLevel).data ??
    snapshot.model.available.find(
      (item) => item.ref.modelId === current.modelId,
    )?.reasoning?.defaultLevel;
  if (currentEffort && thought?.available.length)
    result.push({
      id: "reasoning_effort",
      name: "Reasoning effort",
      type: "select",
      category: "thought_level",
      currentValue: currentEffort,
      options: thought.available.map(({ value, label }) => ({
        value,
        name: label,
      })),
    });
  return result;
}

async function createNativeSession() {
  account = await loadZcodeAccount();
  native = new ZcodeNative(
    workspace,
    async (method, params) => {
      if (method === "session/requestRuntimePreferences")
        return readOnlyPreferences;
      if (!onRequest) throw new Error("ZCode 当前没有活跃任务");
      return onRequest(method, params);
    },
    async (event) => {
      await onEvent?.(event);
    },
  );
  if (account)
    await native.request("provider/updateAccountConfig", account.overlay);
  const raw = await native.request("session/create", {
    workspace: { workspacePath: workspace, workspaceKey: workspace },
    mode: "plan",
    toolAllowlist: ["Read"],
    toolDenylist: [
      "Bash",
      "Edit",
      "Write",
      "Agent",
      "Task",
      "Glob",
      "Grep",
      "WebSearch",
      "WebFetch",
    ],
    dynamicWorkflowEnabled: false,
    titleGenerationEnabled: false,
    mcpServers: [],
    ...(account ? { model: account.selection } : {}),
  });
  nativeSessionId = nativeSessionSchema.parse(raw).session.sessionId;
  readSnapshot(raw);
  const preferred = z
    .string()
    .safeParse(account?.selection.options?.reasoningLevel).data;
  if (
    preferred &&
    snapshot?.thoughtLevel?.available.some((item) => item.value === preferred)
  ) {
    readSnapshot(
      await native.request("session/setThoughtLevel", {
        sessionId: nativeSessionId,
        thoughtLevel: preferred,
        persistAsWorkspaceLastUsed: false,
      }),
      true,
    );
  }
}

const connection = agent({ name: "mingting-zcode-native-acp" })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: {
      name: "ZCode · Mingting native app-server ACP bridge",
      version: "3",
    },
    agentCapabilities: {},
    authMethods: [],
  }))
  .onRequest(methods.agent.session.new, async (ctx) => {
    if (
      created ||
      realpathSync(resolve(ctx.params.cwd)) !== workspace ||
      ctx.params.mcpServers.length
    )
      throw new Error("桥接器仅支持固定项目目录的一次会话");
    created = true;
    await createNativeSession();
    const models = snapshot
      ? {
          currentModelId: snapshot.model.current.modelId,
          availableModels: catalog
            .filter(
              (item) =>
                item.ref.providerId === snapshot?.model.current.providerId,
            )
            .map(({ ref, label, contextWindow }) => ({
              modelId: ref.modelId,
              name: label,
              _meta: { contextWindow },
            })),
        }
      : undefined;
    return { sessionId, modes, configOptions: configOptions(), models };
  })
  .onRequest(methods.agent.session.setMode, (ctx) => {
    if (
      !created ||
      ctx.params.sessionId !== sessionId ||
      ctx.params.modeId !== "plan"
    )
      throw new Error("桥接器要求 plan 模式");
    return {};
  })
  .onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
    if (
      !native ||
      !nativeSessionId ||
      !snapshot ||
      used ||
      params.sessionId !== sessionId
    )
      throw new Error("ZCode 设置会话无效");
    const allowed = configOptions().find((item) => item.id === params.configId);
    if (
      allowed?.type !== "select" ||
      !allowed.options.some(
        (option) => "value" in option && option.value === params.value,
      )
    )
      throw new Error("ZCode 不提供此设置选项");
    if (params.configId === "model") {
      const model = catalog.find(
        (item) =>
          item.ref.modelId === params.value &&
          item.ref.providerId === snapshot?.model.current.providerId,
      );
      if (!model) throw new Error("ZCode 模型不属于当前账户");
      if (model.ref.modelId !== snapshot.model.current.modelId)
        readSnapshot(
          await native.request("session/setModel", {
            sessionId: nativeSessionId,
            model: {
              ...model.ref,
              ...(model.reasoning?.defaultLevel
                ? {
                    options: {
                      ...model.ref.options,
                      reasoningLevel: model.reasoning.defaultLevel,
                    },
                  }
                : {}),
            },
            persistAsWorkspaceLastUsed: false,
          }),
          true,
        );
    } else if (params.configId === "reasoning_effort") {
      readSnapshot(
        await native.request("session/setThoughtLevel", {
          sessionId: nativeSessionId,
          thoughtLevel: params.value,
          persistAsWorkspaceLastUsed: false,
        }),
        true,
      );
    }
    return { configOptions: configOptions() };
  })
  .onNotification(methods.agent.session.cancel, (ctx) => {
    if (ctx.params.sessionId === sessionId) active?.abort();
  })
  .onRequest(methods.agent.session.prompt, async (ctx) => {
    if (
      !created ||
      !native ||
      !nativeSessionId ||
      used ||
      ctx.params.sessionId !== sessionId ||
      ctx.params.prompt.some((p) => p.type !== "text")
    )
      throw new Error("桥接器仅支持一次文本回合");
    used = true;
    const controller = new AbortController();
    active = controller;
    // Platform run/approval deadlines own this lifecycle, including human wait time.
    const signal = AbortSignal.any([controller.signal, ctx.signal]);
    const client = native;
    const upstreamSessionId = nativeSessionId;
    const turn = nativeDeferred<"end_turn">();
    void turn.promise.catch(() => {});
    const approvals = new Map<
      string,
      { fingerprint: string; result: Promise<unknown> }
    >();
    let pending: SessionNotification | undefined;
    let flushTimer: NodeJS.Timeout | undefined;
    let hasOutput = false;
    let emissions = Promise.resolve();
    const flush = async () => {
      clearTimeout(flushTimer);
      flushTimer = undefined;
      const next = pending;
      pending = undefined;
      if (next) await ctx.client.notify(methods.client.session.update, next);
    };
    const emit = async (value: SessionNotification) => {
      const update = value.update,
        previous = pending?.update;
      if (
        (update.sessionUpdate === "agent_message_chunk" ||
          update.sessionUpdate === "agent_thought_chunk") &&
        update.content.type === "text"
      ) {
        if (update.sessionUpdate === "agent_message_chunk")
          hasOutput ||= update.content.text.length > 0;
        if (
          previous?.sessionUpdate === update.sessionUpdate &&
          previous.content.type === "text" &&
          previous.content.text.length < LIMITS.toolChars
        ) {
          previous.content.text += update.content.text;
          return;
        }
        await flush();
        pending = value;
        flushTimer = setTimeout(() => {
          emissions = emissions
            .then(flush)
            .catch((error: unknown) => turn.reject(error));
        }, LIMITS.browserFlushMs);
      } else {
        await flush();
        await ctx.client.notify(methods.client.session.update, value);
      }
    };
    onRequest = async (method, params) => {
      if (
        method === "interaction/requestProviderRuntimeHeaders" &&
        account &&
        nativeSessionId
      )
        return account.headers(params, nativeSessionId);
      if (
        method !== "interaction/requestPermission" ||
        !nativeSessionId ||
        signal.aborted
      )
        throw new Error("未支持的 ZCode 反向请求");
      const mapped = mapZcodePermission(params, nativeSessionId, sessionId);
      if (mapped.native.toolName !== "Read")
        return { decision: "deny", reason: "明庭 ZCode 仅开放 Read" };
      const fingerprint = JSON.stringify(mapped.native);
      const existing = approvals.get(mapped.native.requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new Error("ZCode 重复审批内容变化");
        return existing.result;
      }
      if (approvals.size >= LIMITS.approvalsPerRun)
        throw new Error("ZCode 审批数量超限");
      const result = (async () => {
        await emissions;
        await flush();
        const response = await ctx.client.request(
          methods.client.session.requestPermission,
          mapped.request,
          { cancellationSignal: signal },
        );
        if (signal.aborted || response.outcome.outcome !== "selected")
          return { decision: "deny", reason: "明庭审批取消，停止本次操作" };
        const optionId = response.outcome.optionId;
        const choice = mapped.choices.find(
          (option) => option.optionId === optionId,
        );
        return (
          choice?.response ?? {
            decision: "deny",
            reason: "明庭返回的审批选项无效",
          }
        );
      })();
      approvals.set(mapped.native.requestId, { fingerprint, result });
      return result;
    };
    onEvent = async (event) => {
      if (event.sessionId !== nativeSessionId || signal.aborted) return;
      if (event.type === "turn.completed") {
        const terminal = z
          .object({
            resultType: z.string().optional(),
            response: z.string().optional(),
          })
          .parse(event.payload);
        if (
          terminal.resultType &&
          !["success", "completed"].includes(terminal.resultType)
        ) {
          turn.reject(new Error("ZCode 回合结束：" + terminal.resultType));
          return;
        }
        await emissions;
        if (!hasOutput && terminal.response)
          await emit({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: terminal.response },
            },
          });
        await flush();
        turn.resolve("end_turn");
      } else if (event.type === "turn.failed") {
        const failure = z
          .object({
            error: z
              .union([z.string(), z.object({ message: z.string() })])
              .optional(),
            message: z.string().optional(),
          })
          .safeParse(event.payload).data;
        const detail =
          typeof failure?.error === "string"
            ? failure.error
            : (failure?.error?.message ?? failure?.message);
        turn.reject(
          new Error(
            "ZCode 原生回合失败" + (detail ? " · " + detail.slice(0, 400) : ""),
          ),
        );
      } else {
        const translated = translateZcodeLine(event, sessionId);
        if (translated.update) {
          const update = translated.update;
          emissions = emissions.then(() => emit(update));
          await emissions;
        }
      }
    };
    const abort = () => {
      turn.reject(signal.reason ?? new Error("ZCode 执行已取消"));
      void client
        .request("session/stop", { sessionId: upstreamSessionId })
        .catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await client.request("session/subscribe", {
        sessionId: upstreamSessionId,
        deliveryKind: "desktop-continuous",
        includeSnapshot: false,
      });
      await client.request("session/send", {
        sessionId: upstreamSessionId,
        ...(snapshot
          ? { modelSelection: snapshot.model.current }
          : account
            ? { modelSelection: account.selection }
            : {}),
        content: ctx.params.prompt
          .map((p) => (p.type === "text" ? p.text : ""))
          .join("\n"),
      });
      const stopReason = await Promise.race([turn.promise, client.failed]);
      const rawUsage = snapshot
        ? await client
            .request("session/usage", { sessionId: upstreamSessionId })
            .catch(() => undefined)
        : undefined;
      const usage = nativeUsage.safeParse(rawUsage).data;
      const finalState = snapshot
        ? await client
            .request("session/read", {
              sessionId: upstreamSessionId,
              messageLimit: 1,
              deliveryKind: "desktop-continuous",
            })
            .catch(() => undefined)
        : undefined;
      const context = nativeContext.safeParse(finalState).data?.projection;
      if (context)
        await emit({
          sessionId,
          update: {
            sessionUpdate: "usage_update",
            used: context.contextUsed,
            size: context.contextWindow,
          },
        });
      return {
        stopReason,
        ...(usage?.sessionId === upstreamSessionId &&
        usage.modelRequestCount > 0
          ? { _meta: { "mingting.zcode/turnUsage": usage } }
          : {}),
      };
    } catch (error) {
      if (signal.aborted) return { stopReason: "cancelled" };
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      clearTimeout(flushTimer);
      await client.close();
      active = undefined;
    }
  })
  .connect(
    ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
      { maxMessageBytes: LIMITS.acpBytes },
    ),
  );
process.stdin.once("end", () => {
  active?.abort();
  connection.close();
  void native?.close();
});
