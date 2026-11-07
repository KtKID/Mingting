import { normalizeUsage, rpcRecord, tokenCount } from "../acp/acp-usage.js";
import {
  usageCountsSchema,
  type SettingsReceipt,
} from "../../../shared/protocol.js";

const fields = {
  uncachedInputTokens: "inputTokens",
  cachedReadTokens: "cachedReadTokens",
  cachedWriteTokens: "cachedWriteTokens",
  outputTokens: "outputTokens",
  reasoningTokens: "thoughtTokens",
  totalTokens: "totalTokens",
} as const;

/** 从 Codex 主回合响应提取标准用量和原字段证据，区分主回合用量与配额信息。 */
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
      Object.entries(fields).map(
        /* 读取单项有效计数并写入平台字段，缺失或无效时记为空值。 */ ([
          key,
          field,
        ]) => [key, tokenCount.safeParse(primary?.[field]).data ?? null],
      ),
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
        Object.values(fields).map(
          /* 保留响应中各原字段的数值，供审计对照。 */ (field) => [
            field,
            typeof primary[field] === "number" ? primary[field] : null,
          ],
        ),
      )
    : null;
  return { usage, evidence };
}

/** 返回已记录的 GPT-6.1-Sol 标称上下文窗口与来源。 */
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
