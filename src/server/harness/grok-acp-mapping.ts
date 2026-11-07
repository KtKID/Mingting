import { z } from "zod";
import { normalizeUsage, rpcRecord, tokenCount } from "./acp/acp-usage.js";
import type { AcpTelemetry } from "./acp/acp-adapter.js";

const grokModels = z.object({
  models: z.object({
    availableModels: z.array(
      z.object({
        modelId: z.string(),
        _meta: z
          .object({ totalContextTokens: tokenCount.positive() })
          .optional(),
      }),
    ),
  }),
});

/** 把有效的 Grok 计数读为整数，其余值记为空值。 */
const count = (value: unknown) => tokenCount.safeParse(value).data ?? null;

export const grokTelemetry: AcpTelemetry = {
  /** 映射 Grok 主回合的用量和费用，保留原始字段并标记分项矛盾。 */
  usage(result, modelId, sessionId, adapterVersion, protocolVersion) {
    const response = rpcRecord.safeParse(result).data;
    const meta = rpcRecord.safeParse(response?._meta).data;
    const raw = rpcRecord.safeParse(meta?.usage).data;
    const input = count(raw?.inputTokens);
    const cachedReadTokens = count(raw?.cachedReadTokens);
    const cachedWriteTokens = count(raw?.cacheCreationTokens);
    const outputTokens = count(raw?.outputTokens);
    const totalTokens = count(raw?.totalTokens);
    const partitions =
      input !== null && cachedReadTokens !== null && cachedWriteTokens !== null;
    const uncachedInputTokens =
      partitions && input >= cachedReadTokens + cachedWriteTokens
        ? input - cachedReadTokens - cachedWriteTokens
        : null;
    const usage = normalizeUsage(
      {
        uncachedInputTokens,
        cachedReadTokens,
        cachedWriteTokens,
        outputTokens,
        reasoningTokens: count(raw?.reasoningTokens),
        totalTokens,
      },
      {
        wireFormat: "grok_acp_prompt_meta_v1",
        adapterVersion,
        protocolVersion,
        sessionId,
        method: "session/prompt",
        fieldPath: "result._meta.usage",
      },
      modelId,
      result ? "Grok 未报告回合用量" : "未收到原 prompt 回包",
    );
    const cost = count(raw?.costUsdTicks);
    if (cost !== null) usage.cost = { currency: "USD", amount: cost / 1e10 };
    if (partitions && uncachedInputTokens === null) usage.inconsistent = true;
    return {
      usage,
      evidence: raw
        ? {
            inputTokens: input,
            cachedReadTokens,
            cacheCreationTokens: cachedWriteTokens,
            outputTokens,
            reasoningTokens: usage.reasoningTokens,
            totalTokens,
            costUsdTicks: cost,
          }
        : null,
    };
  },
  /** 从 Grok 会话的模型目录读取当前模型的上下文窗口及来源。 */
  modelWindow(modelId, session) {
    if (!modelId) return null;
    const tokens = grokModels
      .safeParse(session)
      .data?.models.availableModels.find(
        /* 定位会话实际选中的模型。 */ (item) => item.modelId === modelId,
      )?._meta?.totalContextTokens;
    return tokens
      ? {
          tokens,
          provider: "Grok",
          modelId,
          basis: "Grok ACP 模型目录",
          observedOn: new Date().toISOString().slice(0, 10),
          sourceUrl:
            "https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md",
        }
      : null;
  },
  /** 从会话通知提取已使用的上下文 token 数。 */
  context(notification) {
    const meta = rpcRecord.safeParse(notification._meta).data;
    const used = count(meta?.totalTokens);
    if (used === null) return;
    return {
      usedTokens: used,
      effectiveWindowTokens: null,
      source: "grok_acp_session_meta",
    };
  },
};
