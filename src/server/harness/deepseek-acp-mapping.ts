import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { normalizeUsage, tokenCount } from "./acp/acp-usage.js";
import type { AcpTelemetry } from "./acp/acp-adapter.js";
import type { RunUsage } from "../../shared/protocol.js";

const decompress = promisify(execFile);
const maxLogBytes = 32 * 1024 * 1024;
const logHeader = z.object({
  type: z.literal("session"),
  version: z.literal(4),
  id: z.string(),
  cwd: z.string(),
  isSeeded: z.literal(false),
  delegationDepth: z.literal(0),
});
const event = z.object({
  type: z.string(),
  seq: tokenCount,
  data: z.unknown(),
});
const turnData = z.object({
  turn: tokenCount,
  reason: z.object({ kind: z.string() }).optional(),
});
const stepData = z.object({
  turn: tokenCount.optional(),
  step: tokenCount.optional(),
  usage: z.unknown().optional(),
  interrupted: z.boolean().optional(),
});
const stepUsage = z.object({
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  totalTokens: tokenCount,
  cacheReadTokens: tokenCount.optional(),
  cacheWriteTokens: tokenCount.optional(),
  reasoningTokens: tokenCount.optional(),
});

/** 核对工作目录和会话身份，从完整且无重试的首回合日志恢复用量。 */
export function mapDeepSeekLog(
  text: string,
  missing: RunUsage,
  workspace: string,
) {
  try {
    const [first, ...lines] = text.trimEnd().split("\n");
    const header = logHeader.parse(JSON.parse(first));
    if (header.id !== missing.source.sessionId || header.cwd !== workspace)
      return;
    const events = lines.map(
      /* 逐行解析并校验 DSH 会话事件。 */ (line) =>
        event.parse(JSON.parse(line)),
    );
    const start = events.filter(
      /* 找出回合开始事件。 */ ({ type }) => type === "turn/start",
    );
    const end = events.filter(
      /* 找出回合结束事件。 */ ({ type }) => type === "turn/end",
    );
    if (
      start.length !== 1 ||
      end.length !== 1 ||
      turnData.parse(start[0].data).turn !== 1
    )
      return;
    const finish = turnData.parse(end[0].data);
    if (finish.turn !== 1 || finish.reason?.kind !== "completed") return;
    const steps = new Map<number, z.infer<typeof stepUsage> | null>();
    const completed: {
      seq: number;
      step: number;
      usage: z.infer<typeof stepUsage>;
    }[] = [];
    let previousSeq = -1;
    for (const { type, seq, data: raw } of events) {
      if (seq <= previousSeq) return;
      previousSeq = seq;
      if (type === "assistant/attempt" || type.startsWith("llm/retry")) return;
      if (!["step/start", "step/end", "assistant/message"].includes(type))
        continue;
      const data = stepData.parse(raw);
      const { step } = data;
      if (
        data.turn !== 1 ||
        step === undefined ||
        seq <= start[0].seq ||
        seq >= end[0].seq
      )
        return;
      if (type === "step/start") {
        if (steps.has(step)) return;
        steps.set(step, null);
      } else if (type === "assistant/message") {
        if (steps.get(step) !== null || data.interrupted) return;
        const usage = stepUsage.parse(data.usage);
        const known =
          BigInt(usage.inputTokens) +
          BigInt(usage.outputTokens) +
          BigInt(usage.cacheReadTokens ?? 0) +
          BigInt(usage.cacheWriteTokens ?? 0);
        if (
          known > BigInt(usage.totalTokens) ||
          (usage.cacheReadTokens !== undefined &&
            usage.cacheWriteTokens !== undefined &&
            known !== BigInt(usage.totalTokens)) ||
          (usage.reasoningTokens ?? 0) > usage.outputTokens
        )
          return;
        steps.set(step, usage);
        completed.push({ seq, step, usage });
      } else {
        if (!steps.get(step)) return;
        steps.delete(step);
      }
    }
    if (
      !completed.length ||
      steps.size ||
      new Set(
        completed.map(
          /* 取已完成步骤的编号，用于检查是否重复。 */ ({ step }) => step,
        ),
      ).size !== completed.length
    )
      return;
    /** 累加已完成步骤的指定用量字段，字段缺失时保留空值。 */
    const sum = (key: keyof z.infer<typeof stepUsage>) => {
      const values = completed.map(
        /* 读取每个已完成步骤的同一项计数。 */ ({ usage }) => usage[key],
      );
      if (
        values.some(
          /* 检查是否有步骤缺报该字段。 */ (value) => value === undefined,
        )
      )
        return null;
      return tokenCount.parse(
        values.reduce(
          /* 把各步骤的计数汇总为回合总数。 */ (total: number, value) =>
            total + (value ?? 0),
          0,
        ),
      );
    };
    const usage = normalizeUsage(
      {
        uncachedInputTokens: sum("inputTokens"),
        cachedReadTokens: sum("cacheReadTokens"),
        cachedWriteTokens: sum("cacheWriteTokens"),
        outputTokens: sum("outputTokens"),
        reasoningTokens: sum("reasoningTokens"),
        totalTokens: sum("totalTokens"),
      },
      {
        ...missing.source,
        wireFormat: "deepseek_session_jsonl_v4",
        method: "dsh/session-log",
        fieldPath: "turn[1].assistant/message.data.usage",
      },
      missing.modelId,
      "",
    );
    return { usage, evidence: { turn: 1, steps: completed } };
  } catch {
    return undefined;
  }
}

/** 按 DSH v4 的目录规则生成长度受限的工作区标识。 */
function projectKey(workspace: string) {
  // DSH v4 groups logs under a bounded, readable workspace key.
  const slug =
    workspace
      .replace(/[/\\:]+/g, "-")
      .replace(
        /[^A-Za-z0-9._-]/g,
        /* 用大写十六进制编码工作区标识中的特殊字符。 */ (ch) =>
          "~" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0"),
      )
      .replace(/^-+/, "") || "root";
  return "--" + slug.slice(0, 251) + "--";
}

/** 构造 DeepSeek 用量映射，并绑定会话日志所在目录。 */
export function deepseekTelemetry(
  home?: string,
  workspace?: string,
): AcpTelemetry {
  return {
    /** 查找指定会话的本地日志，尝试恢复主回合用量。 */
    async recoverUsage(missing) {
      if (
        !home ||
        !workspace ||
        !/^[0-9a-f-]{36}$/i.test(missing.source.sessionId)
      )
        return;
      const folder = join(
        home,
        "sessions",
        projectKey(workspace),
        missing.source.sessionId,
      );
      for (const name of ["session.v4.jsonl.zstd", "session.v4.jsonl"]) {
        const path = join(folder, name);
        try {
          if (
            (await realpath(path)) !== path ||
            (await stat(path)).size > maxLogBytes
          )
            continue;
          const text = name.endsWith(".zstd")
            ? (
                await decompress("zstd", ["-dc", "--", path], {
                  encoding: "utf8",
                  maxBuffer: maxLogBytes,
                  timeout: 3000,
                })
              ).stdout
            : await readFile(path, "utf8");
          return mapDeepSeekLog(text, missing, workspace);
        } catch {
          // Missing files, unsupported compression and uncommitted logs preserve missing Usage.
        }
      }
    },
    /** 建立缺失用量记录，供后续按会话日志补齐。 */
    usage(result, modelId, sessionId, adapterVersion, protocolVersion) {
      const usage = normalizeUsage(
        {
          uncachedInputTokens: null,
          cachedReadTokens: null,
          cachedWriteTokens: null,
          outputTokens: null,
          reasoningTokens: null,
          totalTokens: null,
        },
        {
          wireFormat: "deepseek_official_acp_v1",
          adapterVersion,
          protocolVersion,
          sessionId,
          method: "session/prompt",
          fieldPath: "result",
        },
        modelId,
        result
          ? "官方 ACP 回包缺少任务用量，且原生日志未取得可对账的完整回合"
          : "未收到原 prompt 回包",
      );
      return { usage, evidence: null };
    },
  };
}
