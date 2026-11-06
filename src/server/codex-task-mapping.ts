import { normalizeUsage, rpcRecord, tokenCount } from "./acp-usage.js";
import { usageCountsSchema, type SettingsReceipt } from "../shared/protocol.js";

const fields = {
  uncachedInputTokens: "inputTokens",
  cachedReadTokens: "cachedReadTokens",
  cachedWriteTokens: "cachedWriteTokens",
  outputTokens: "outputTokens",
  reasoningTokens: "thoughtTokens",
  totalTokens: "totalTokens",
} as const;

export function codexUsage(
  result: unknown,
  modelId: string | null,
  sessionId: string,
  adapterVersion: string,
  protocolVersion: number,
) {
  const response = rpcRecord.safeParse(result).data;
  const primary = rpcRecord.safeParse(response?.usage).data;
  const quota = rpcRecord.safeParse(response?._meta).data?.quota;
  const counts = usageCountsSchema.parse(
    Object.fromEntries(
      Object.entries(fields).map(([key, field]) => [
        key,
        tokenCount.safeParse(primary?.[field]).data ?? null,
      ]),
    ),
  );
  const usage = normalizeUsage(
    counts,
    {
      wireFormat: "codex_acp_prompt_v1",
      adapterVersion,
      protocolVersion,
      method: "session/prompt",
      fieldPath: "result.usage",
      sessionId,
    },
    modelId,
    quota
      ? "仅有 quota 别名，缺少主回合 Usage"
      : result
        ? "Codex 未报告主回合 Usage"
        : "未收到原 prompt 回包",
  );
  const evidence = primary
    ? Object.fromEntries(
        Object.values(fields).map((field) => [
          field,
          typeof primary[field] === "number" ? primary[field] : null,
        ]),
      )
    : null;
  return { usage, evidence };
}

export function codexModelWindow(
  modelId: string | null,
): SettingsReceipt["modelWindow"] {
  if (modelId !== "gpt-6.1-sol") return null;
  return {
    tokens: 1_050_000,
    modelId,
    provider: "OpenAI",
    basis: "API 标称窗口",
    observedOn: "2026-11-05",
    sourceUrl: "https://developers.openai.com/api/docs/models/gpt-6.1-sol",
  };
}
