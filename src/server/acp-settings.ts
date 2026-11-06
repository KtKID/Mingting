import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { RequestedSettings } from "../shared/protocol.js";

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
    if (selectOption(options, "model")?.currentValue !== settings.modelId)
      throw new Error("执行器回读值与任务设置不一致");
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
    throw new Error("执行器回读值与任务设置不一致");
  return { modelId, reasoningEffort };
}
