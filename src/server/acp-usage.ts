import { z } from "zod";
import { usageCountsSchema, type RunUsage } from "../shared/protocol.js";

export const rpcRecord = z.record(z.string(), z.unknown());
export const tokenCount = usageCountsSchema.shape.totalTokens.unwrap();

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
      parts.every((part) => part !== null) &&
      parts.reduce((total, part) => total + BigInt(part), 0n) !==
        BigInt(totalTokens)) ||
    (reasoningTokens !== null &&
      outputTokens !== null &&
      reasoningTokens > outputTokens);
  const reported = Object.values(counts).filter(
    (count) => count !== null,
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
