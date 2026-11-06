import { z } from "zod";
import { normalizeUsage, rpcRecord, tokenCount } from "./acp-usage.js";
import type { AcpTelemetry } from "./acp-adapter.js";

const nativeUsage = z.object({
  sessionId: z.string().min(1),
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  reasoningTokens: tokenCount,
  cacheCreationTokens: tokenCount,
  cacheReadTokens: tokenCount,
  totalTokens: tokenCount,
  modelRequestCount: tokenCount.positive(),
  modelErrorCount: tokenCount,
});
const modelWindows = z.object({
  models: z.object({
    availableModels: z.array(
      z.object({
        modelId: z.string(),
        _meta: z
          .object({ contextWindow: tokenCount.positive().optional() })
          .optional(),
      }),
    ),
  }),
});

export const zcodeTelemetry: AcpTelemetry = {
  usage(result, modelId, sessionId, adapterVersion, protocolVersion) {
    const meta = rpcRecord.safeParse(
      rpcRecord.safeParse(result).data?._meta,
    ).data;
    const native = nativeUsage.safeParse(
      meta?.["mingting.zcode/turnUsage"],
    ).data;
    const partition =
      native &&
      native.inputTokens - native.cacheReadTokens - native.cacheCreationTokens;
    const usage = normalizeUsage(
      {
        uncachedInputTokens:
          partition !== undefined && partition >= 0 ? partition : null,
        cachedReadTokens: native?.cacheReadTokens ?? null,
        cachedWriteTokens: native?.cacheCreationTokens ?? null,
        outputTokens: native?.outputTokens ?? null,
        reasoningTokens: native?.reasoningTokens ?? null,
        totalTokens: native?.totalTokens ?? null,
      },
      {
        wireFormat: "mingting_zcode_native_session_usage_v1",
        adapterVersion,
        protocolVersion,
        sessionId,
        method: "session/usage",
        fieldPath: 'result._meta["mingting.zcode/turnUsage"]',
        upstreamSessionId: native?.sessionId,
      },
      modelId,
      "ZCode 原生会话未报告有效任务用量",
    );
    if (native?.modelErrorCount && usage.coverage === "complete")
      usage.coverage = "partial";
    if (partition !== undefined && partition < 0) usage.inconsistent = true;
    return { usage, evidence: native ?? null };
  },
  modelWindow(modelId, session) {
    if (!modelId) return null;
    const window = modelWindows
      .safeParse(session)
      .data?.models.availableModels.find((item) => item.modelId === modelId)
      ?._meta?.contextWindow;
    return window
      ? {
          tokens: window,
          provider: "ZCode",
          modelId,
          basis: "ZCode 原生模型目录",
          observedOn: new Date().toISOString().slice(0, 10),
          sourceUrl: "https://zcode.z.ai/en/docs/configuration",
        }
      : null;
  },
};
