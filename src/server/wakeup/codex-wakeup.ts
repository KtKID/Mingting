import { createRequire } from "node:module";
import { resolve } from "node:path";
import { z } from "zod";
import type { InitializeResponse } from "@agentclientprotocol/sdk";
import type {
  WakeupEvent,
  WakeupHostStatus,
  WakeupTarget,
} from "../../shared/task-wakeup.js";
import { CodexAdapter } from "../harness/codex/codex-adapter.js";
import { wakeupMessage, type WakeupDelivery } from "./task-wakeup.js";
export { wakeupMessage } from "./task-wakeup.js";

const HOST_TIMEOUT_MS = 45000;
const WAKEUP_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const configSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
  workspace: z.string().min(1),
  env: z.record(z.string(), z.string().optional()),
});
export type CodexWakeupConfig = z.infer<typeof configSchema>;

/** 事件复用原 Codex 会话；ACP load/prompt 与任务执行使用同一适配器。 */
export class CodexWakeupDelivery implements WakeupDelivery {
  private state: WakeupHostStatus = {
    available: false,
    transport: "codex-acp",
    error: "ACP 原会话加载能力尚待验证",
  };
  private adapter: CodexAdapter;
  private allowedThreadId: string | undefined;
  private previous: Promise<void> = Promise.resolve();
  private stop = new AbortController();
  /** 初始化用于恢复原会话并发送唤醒提示的 Codex ACP 适配器。 */
  constructor(config: CodexWakeupConfig) {
    this.adapter = new CodexAdapter({
      ...configSchema.parse(config),
      sessionMode: null,
      harnessName: "Codex 唤醒",
    });
  }
  /** 返回当前唤醒宿主状态的副本。 */
  status() {
    return { ...this.state };
  }
  /** 只接受预检通过时绑定的原聊天会话。 */
  accepts(target: WakeupTarget) {
    return this.state.available && target.threadId === this.allowedThreadId;
  }
  /** 记录投递故障，并解除当前聊天会话授权。 */
  private failed(error: unknown) {
    this.state = {
      available: false,
      transport: "codex-acp",
      error: error instanceof Error ? error.message : "ACP 会话恢复失败",
    };
    this.allowedThreadId = undefined;
  }
  /** 验证聊天 ID 并实际加载会话，成功后绑定该聊天作为唤醒目标。 */
  async probe(threadId: string) {
    try {
      z.string().uuid().parse(threadId);
      await this.adapter.probeSession(
        threadId,
        AbortSignal.timeout(HOST_TIMEOUT_MS),
      );
      this.state = { available: true, transport: "codex-acp", error: null };
      this.allowedThreadId = threadId;
    } catch (error) {
      this.failed(error);
    }
    return this.status();
  }
  /** 等待上一轮收尾，在原 Codex 会话投递事件并等候接收确认。 */
  async send(event: WakeupEvent) {
    await this.previous;
    if (!this.accepts(event.target))
      throw new Error(this.state.error ?? "ACP 授权范围限于预检绑定的聊天");
    let agentInfo: InitializeResponse["agentInfo"];
    /** 生成含原会话 ID 和执行器信息的 ACP 投递回执。 */
    const receipt = () => ({
      source: "codex-acp/session/prompt",
      result: { sessionId: event.target.threadId, accepted: true, agentInfo },
    });
    let accepted = false;
    /** 在 Promise 绑定前提供接收确认回调的初始占位。 */
    let accept: (value: ReturnType<typeof receipt>) => void = () => {};
    /** 在 Promise 绑定前提供投递失败回调的初始占位。 */
    let reject: (error: unknown) => void = () => {};
    const started = new Promise<ReturnType<typeof receipt>>((yes, no) => {
      // 绑定接收确认和投递失败的 Promise 回调。
      accept = yes;
      reject = no;
    });
    /** 只确认一次投递，并向调用方交付回执。 */
    const admit = () => {
      if (!accepted) {
        accepted = true;
        accept(receipt());
      }
    };
    const running = this.adapter.execute(
      wakeupMessage(event),
      AbortSignal.any([
        this.stop.signal,
        AbortSignal.timeout(WAKEUP_TURN_TIMEOUT_MS),
      ]),
      {
        /** 核对 ACP 实际恢复的会话 ID 与目标一致。 */
        session: (id) => {
          if (id !== event.target.threadId)
            throw new Error("ACP 原会话身份不匹配");
        },
        /** 保留 ACP 初始化返回的执行器信息。 */
        discovery: (value) => {
          agentInfo = value.agentInfo;
        },
        /** 收到模型文本、推理或工具调用时确认原会话已接收。 */
        update: (message) => {
          if (
            [
              "agent_message_chunk",
              "agent_thought_chunk",
              "tool_call",
            ].includes(message.update.sessionUpdate)
          )
            admit();
        },
        /** 唤醒回合中的权限请求一律取消。 */
        permission: async () => ({ outcome: { outcome: "cancelled" } }),
      },
      event.target.threadId,
    );
    // ACP prompt 持续到本轮结束；首个模型输出确认投递，后续事件等待该连接收尾。
    this.previous = running
      .then((reason) => {
        // 正常回合结束时补发接收确认，其他停止原因作为失败处理。
        if (reason !== "end_turn")
          throw new Error(`ACP 唤醒回合结束：${reason}`);
        admit();
      })
      .catch((error: unknown) => {
        // 记录唤醒故障，按接收确认是否已发出选择拒绝回执或记录日志。
        this.failed(error);
        if (!accepted) reject(error);
        else console.error("ACP 唤醒回合失败", this.state.error);
      });
    return started;
  }
  /** 取消正在运行的唤醒连接，并等待队列收尾。 */
  async close() {
    this.stop.abort(new Error("平台关闭，结束 ACP 唤醒连接"));
    await this.previous;
  }
}

/** 组装唤醒专用 Codex ACP 命令、目录和环境配置。 */
export function codexWakeupConfig(env: NodeJS.ProcessEnv = process.env) {
  const require = createRequire(import.meta.url);
  return configSchema.parse({
    command: process.execPath,
    args: [require.resolve("@agentclientprotocol/codex-acp")],
    workspace: resolve(env.MINGTING_CODEX_WORKSPACE ?? process.cwd()),
    env: {
      ...env,
      ...(env.MINGTING_CODEX_HOME
        ? { CODEX_HOME: env.MINGTING_CODEX_HOME }
        : {}),
      ...(env.CODEX_APP_RUNTIME_CLI_PATH
        ? { CODEX_PATH: env.CODEX_APP_RUNTIME_CLI_PATH }
        : {}),
    },
  });
}

/** 仅在显式启用时创建 Codex 唤醒宿主，并预检配置的聊天会话。 */
export async function configuredCodexWakeups(
  env: NodeJS.ProcessEnv = process.env,
): Promise<WakeupDelivery | undefined> {
  if (env.MINGTING_CODEX_WAKEUPS !== "1") return undefined;
  const delivery = new CodexWakeupDelivery(codexWakeupConfig(env));
  await delivery.probe(env.CODEX_THREAD_ID ?? "");
  return delivery;
}
