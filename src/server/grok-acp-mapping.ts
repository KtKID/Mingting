import { z } from "zod";
import { normalizeUsage, rpcRecord, tokenCount } from "./acp-usage.js";
import type { AcpTelemetry } from "./acp-adapter.js";

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

const count = (value: unknown) => tokenCount.safeParse(value).data ?? null;

export const grokTelemetry: AcpTelemetry = {
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
  modelWindow(modelId, session) {
    if (!modelId) return null;
    const tokens = grokModels
      .safeParse(session)
      .data?.models.availableModels.find((item) => item.modelId === modelId)
      ?._meta?.totalContextTokens;
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
