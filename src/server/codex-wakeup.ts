import { createRequire } from "node:module";
import { resolve } from "node:path";
import { z } from "zod";
import type { InitializeResponse } from "@agentclientprotocol/sdk";
import type {
  WakeupEvent,
  WakeupHostStatus,
  WakeupTarget,
} from "../shared/task-wakeup.js";
import { CodexAdapter } from "./codex-adapter.js";
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
  constructor(config: CodexWakeupConfig) {
    this.adapter = new CodexAdapter({
      ...configSchema.parse(config),
      sessionMode: null,
      harnessName: "Codex 唤醒",
    });
  }
  status() {
    return { ...this.state };
  }
  accepts(target: WakeupTarget) {
    return this.state.available && target.threadId === this.allowedThreadId;
  }
  private failed(error: unknown) {
    this.state = {
      available: false,
      transport: "codex-acp",
      error: error instanceof Error ? error.message : "ACP 会话恢复失败",
    };
    this.allowedThreadId = undefined;
  }
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
  async send(event: WakeupEvent) {
    await this.previous;
    if (!this.accepts(event.target))
      throw new Error(this.state.error ?? "ACP 授权范围限于预检绑定的聊天");
    let agentInfo: InitializeResponse["agentInfo"];
    const receipt = () => ({
      source: "codex-acp/session/prompt",
      result: { sessionId: event.target.threadId, accepted: true, agentInfo },
    });
    let accepted = false;
    let accept: (value: ReturnType<typeof receipt>) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const started = new Promise<ReturnType<typeof receipt>>((yes, no) => {
      accept = yes;
      reject = no;
    });
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
        session: (id) => {
          if (id !== event.target.threadId)
            throw new Error("ACP 原会话身份不匹配");
        },
        discovery: (value) => {
          agentInfo = value.agentInfo;
        },
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
        permission: async () => ({ outcome: { outcome: "cancelled" } }),
      },
      event.target.threadId,
    );
    // ACP prompt 持续到本轮结束；首个模型输出确认投递，后续事件等待该连接收尾。
    this.previous = running
      .then((reason) => {
        if (reason !== "end_turn")
          throw new Error(`ACP 唤醒回合结束：${reason}`);
        admit();
      })
      .catch((error: unknown) => {
        this.failed(error);
        if (!accepted) reject(error);
        else console.error("ACP 唤醒回合失败", this.state.error);
      });
    return started;
  }
  async close() {
    this.stop.abort(new Error("平台关闭，结束 ACP 唤醒连接"));
    await this.previous;
  }
}

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

export async function configuredCodexWakeups(
  env: NodeJS.ProcessEnv = process.env,
): Promise<WakeupDelivery | undefined> {
  if (env.MINGTING_CODEX_WAKEUPS !== "1") return undefined;
  const delivery = new CodexWakeupDelivery(codexWakeupConfig(env));
  await delivery.probe(env.CODEX_THREAD_ID ?? "");
  return delivery;
}
