import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { z } from "zod";
import {
  contextObservationSchema,
  usageCountsSchema,
  type RequestedSettings,
  type RunUsage,
  type SettingsReceipt,
} from "../shared/protocol.js";

export function selectOption(
  options: SessionConfigOption[] | undefined,
  id: string,
) {
  const option = options?.find((item) => item.id === id);
  return option?.type === "select" ? option : undefined;
}

export function choices(option: ReturnType<typeof selectOption>) {
  return (option?.options ?? [])
    .flatMap((choice) => ("group" in choice ? choice.options : [choice]))
    .map(({ value, name }) => ({ id: value, name }));
}

export type SetOption = (
  id: string,
  value: string,
) => Promise<SessionConfigOption[]>;

export async function applySettings(
  options: SessionConfigOption[] | undefined,
  setOption: SetOption,
  settings?: RequestedSettings,
) {
  if (settings?.modelId) {
    const model = selectOption(options, "model");
    if (
      !model ||
      !choices(model).some((choice) => choice.id === settings.modelId)
    )
      throw new Error("正式会话未提供所选模型");
    options = await setOption(model.id, settings.modelId);
  }
  if (settings?.reasoningEffort) {
    const effort = selectOption(options, "reasoning_effort");
    if (
      !effort ||
      !choices(effort).some((choice) => choice.id === settings.reasoningEffort)
    )
      throw new Error("正式会话的模型未提供所选思考档位");
    options = await setOption(effort.id, settings.reasoningEffort);
  }
  const modelId = selectOption(options, "model")?.currentValue ?? null;
  const reasoningEffort =
    selectOption(options, "reasoning_effort")?.currentValue ?? null;
  if (
    (settings?.modelId && settings.modelId !== modelId) ||
    (settings?.reasoningEffort && settings.reasoningEffort !== reasoningEffort)
  )
    throw new Error("Codex 回读值与任务设置不一致");
  return { modelId, reasoningEffort };
}

const object = z.record(z.string(), z.unknown());
const countSchema = usageCountsSchema.shape.totalTokens.unwrap();
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
  const response = object.safeParse(result).data;
  const primary = object.safeParse(response?.usage).data;
  const quota = object.safeParse(response?._meta).data?.quota;
  const counts = usageCountsSchema.parse(
    Object.fromEntries(
      Object.entries(fields).map(([key, field]) => [
        key,
        countSchema.safeParse(primary?.[field]).data ?? null,
      ]),
    ),
  );
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
  const usage: RunUsage = {
    ...counts,
    scope: "primary_prompt",
    basis: "token_breakdown_v1",
    coverage: reported === 6 ? "complete" : reported ? "partial" : "missing",
    inconsistent,
    modelId,
    source: {
      wireFormat: "codex_acp_prompt_v1",
      adapterVersion,
      protocolVersion,
      method: "session/prompt",
      fieldPath: "result.usage",
      sessionId,
    },
    ...(!reported
      ? {
          missingReason: quota
            ? "仅有 quota 别名，缺少主回合 Usage"
            : result
              ? "Codex 未报告主回合 Usage"
              : "未收到原 prompt 回包",
        }
      : {}),
  };
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

export function codexContext(update: { used: number; size: number }) {
  return contextObservationSchema.safeParse({
    usedTokens: update.used,
    effectiveWindowTokens: update.size,
    source: "acp_usage_update",
  }).data;
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
