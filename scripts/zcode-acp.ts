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
const connection = agent({ name: "mingting-zcode-native-acp" })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: {
      name: "ZCode · Mingting native app-server ACP bridge",
      version: "2",
    },
    agentCapabilities: {},
    authMethods: [],
  }))
  .onRequest(methods.agent.session.new, (ctx) => {
    if (
      created ||
      realpathSync(resolve(ctx.params.cwd)) !== workspace ||
      ctx.params.mcpServers.length
    )
      throw new Error("桥接器仅支持固定项目目录的一次会话");
    created = true;
    return { sessionId, modes };
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
  .onNotification(methods.agent.session.cancel, (ctx) => {
    if (ctx.params.sessionId === sessionId) active?.abort();
  })
  .onRequest(methods.agent.session.prompt, async (ctx) => {
    if (
      !created ||
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
    const account = await loadZcodeAccount();
    let nativeSessionId: string | undefined;
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
    const native = new ZcodeNative(
      workspace,
      async (method, params) => {
        if (method === "session/requestRuntimePreferences")
          return {
            nativeSearchEnhancementsEnabled: false,
            memoryEnabled: false,
            askUserQuestionAutoResolutionEnabled: false,
            subagentRuntimeConfigEnabled: false,
            toolSearchMode: "off",
          };
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
      },
      async (event) => {
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
        } else if (event.type === "turn.failed")
          turn.reject(new Error("ZCode 原生回合失败"));
        else {
          const translated = translateZcodeLine(event, sessionId);
          if (translated.update) {
            const update = translated.update;
            emissions = emissions.then(() => emit(update));
            await emissions;
          }
        }
      },
    );
    const abort = () => {
      turn.reject(signal.reason ?? new Error("ZCode 执行已取消"));
      if (nativeSessionId)
        void native
          .request("session/stop", { sessionId: nativeSessionId })
          .catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      if (account)
        await native.request("provider/updateAccountConfig", account.overlay);
      const session = nativeSessionSchema.parse(
        await native.request("session/create", {
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
        }),
      );
      nativeSessionId = session.session.sessionId;
      await native.request("session/subscribe", {
        sessionId: nativeSessionId,
        deliveryKind: "desktop-continuous",
        includeSnapshot: false,
      });
      await native.request("session/send", {
        sessionId: nativeSessionId,
        ...(account ? { modelSelection: account.selection } : {}),
        content: ctx.params.prompt
          .map((p) => (p.type === "text" ? p.text : ""))
          .join("\n"),
      });
      const stopReason = await Promise.race([turn.promise, native.failed]);
      return { stopReason };
    } catch (error) {
      if (signal.aborted) return { stopReason: "cancelled" };
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      clearTimeout(flushTimer);
      await native.close();
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
});
