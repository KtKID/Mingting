import { z } from "zod";
import { usageCountsSchema, type RunUsage } from "../../../shared/protocol.js";

export const rpcRecord = z.record(z.string(), z.unknown());
export const tokenCount = usageCountsSchema.shape.totalTokens.unwrap();

/** 整理主回合用量，标记字段覆盖程度与计数矛盾，并保留数据来源。 */
export function normalizeUsage(
  counts: z.infer<typeof usageCountsSchema>,
  source: RunUsage["source"],
  modelId: string | null,
  missingReason: string,
): RunUsage {
  const {
    uncachedInputTokens,
    cachedReadTokens,
    cachedWriteTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
  } = counts;
  const parts = [
    uncachedInputTokens,
    cachedReadTokens,
    cachedWriteTokens,
    outputTokens,
  ];
  const inconsistent =
    (totalTokens !== null &&
      parts.every(
        /* 确认总数校验所需的各项计数齐全。 */ (part) => part !== null,
      ) &&
      parts.reduce(
        /* 用大整数精确累加输入、缓存和输出计数。 */ (total, part) =>
          total + BigInt(part),
        0n,
      ) !== BigInt(totalTokens)) ||
    (reasoningTokens !== null &&
      outputTokens !== null &&
      reasoningTokens > outputTokens);
  const reported = Object.values(counts).filter(
    /* 统计执行器实际报告的字段，保留已报告的零值。 */ (count) =>
      count !== null,
  ).length;
  return {
    ...counts,
    scope: "primary_prompt",
    basis: "token_breakdown_v1",
    coverage: reported === 6 ? "complete" : reported ? "partial" : "missing",
    inconsistent,
    modelId,
    source: {
      ...source,
    },
    ...(!reported ? { missingReason } : {}),
  };
}
