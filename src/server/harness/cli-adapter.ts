import { spawn } from "node:child_process";
import { once } from "node:events";
import { z } from "zod";
import { LIMITS } from "../../shared/protocol.js";
import type { RunHooks, TaskExecutor } from "./codex/codex-adapter.js";

const grokResultSchema = z.object({
  text: z.string().trim().min(1),
  stopReason: z.literal("end_turn"),
  sessionId: z.string().min(1),
});
const zcodeResultSchema = z.object({
  response: z.string().trim().min(1),
  sessionId: z.string().min(1),
  projection: z.object({ status: z.literal("idle") }),
});
export type CliConfig = {
  harnessName: "Grok" | "ZCode";
  command: string;
  args: string[];
  workspace: string;
  env: NodeJS.ProcessEnv;
};

// Native single-prompt CLIs; final JSON is validated independently of ACP discovery.
export class CliAdapter implements TaskExecutor {
  readonly mode = "codex" as const; // Existing platform wire name for real execution.
  /** 保存原生 CLI 的启动参数、工作目录和环境配置。 */
  constructor(private config: CliConfig) {}
  /** 返回 CLI 命令的工作目录。 */
  get workspace() {
    return this.config.workspace;
  }
  /** 运行单次 CLI 提示，在取消或超限时结束进程，并校验最终 JSON 结果。 */
  async execute(
    text: string,
    signal: AbortSignal,
    hooks: RunHooks,
  ): Promise<string> {
    signal.throwIfAborted();
    signal = AbortSignal.any([signal, AbortSignal.timeout(LIMITS.cliMs)]);
    const child = spawn(this.config.command, [...this.config.args, text], {
      cwd: this.workspace,
      env: this.config.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    console.info(
      `${this.config.harnessName} CLI 已启动 pid=${child.pid} command=${this.config.command}`,
    );
    let output = "",
      errorLine = "",
      errorLineDone = false,
      overflow = false;
    /** 向子进程或其进程组发送信号，允许进程已提前退出。 */
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* Process already exited. */
      }
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      // 累积标准输出，超过字符上限时中止执行。
      if (output.length + chunk.length > LIMITS.outputChars) {
        overflow = true;
        abort();
      } else output += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      // 保留标准错误首行的有限前缀，用于报告执行错误。
      if (!errorLineDone && errorLine.length < 500) {
        errorLineDone = chunk.includes("\n");
        errorLine = (errorLine + chunk).slice(0, 500).split("\n")[0] ?? "";
      }
    });
    let hardKill: NodeJS.Timeout | undefined;
    /** 先发送终止信号，再安排超时强制退出。 */
    const abort = () => {
      if (hardKill) return;
      kill("SIGTERM");
      hardKill = setTimeout(
        /* 宽限期结束后强制终止子进程。 */ () => kill("SIGKILL"),
        LIMITS.killMs,
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) abort();
      const [code] = await once(child, "close");
      signal.throwIfAborted();
      if (overflow) throw new Error("CLI 输出超限");
      if (code !== 0) {
        const safeLine = /token|bearer|authorization|api.?key|secret/i.test(
          errorLine,
        )
          ? ""
          : errorLine;
        throw new Error(
          `${this.config.harnessName} CLI 退出码 ${code}${safeLine ? `：${safeLine}` : ""}`,
        );
      }
      let final: unknown;
      try {
        final = JSON.parse(output);
      } catch {
        const lines = output.trim().split("\n");
        const last = lines.at(-1);
        if (last) {
          try {
            final = JSON.parse(last);
          } catch {
            /* Schema below reports invalid result. */
          }
        }
      }
      const result =
        this.config.harnessName === "Grok"
          ? grokResultSchema.parse(final)
          : zcodeResultSchema.parse(final);
      const response = "text" in result ? result.text : result.response;
      hooks.session(result.sessionId);
      hooks.update({
        sessionId: result.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: response },
        },
      });
      return "end_turn";
    } finally {
      signal.removeEventListener("abort", abort);
      clearTimeout(hardKill);
      kill("SIGTERM");
    }
  }
}
