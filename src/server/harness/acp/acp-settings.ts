import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { RequestedSettings } from "../../../shared/protocol.js";

/** 按 ID 查找 ACP 设置，只接收可枚举的选择项。 */
export function selectOption(
  options: SessionConfigOption[] | undefined,
  id: string,
) {
  const option = options?.find(
    /* 匹配所请求的设置 ID。 */ (item) => item.id === id,
  );
  return option?.type === "select" ? option : undefined;
}

/** 将分组或单独的选项统一整理为 ID 和显示名称。 */
export function choices(option: ReturnType<typeof selectOption>) {
  return (option?.options ?? [])
    .flatMap(
      /* 展开分组中的选项，保留单个选项。 */ (choice) =>
        "group" in choice ? choice.options : [choice],
    )
    .map(
      /* 将协议的选项值和名称映射为设置选项。 */ ({ value, name }) => ({
        id: value,
        name,
      }),
    );
}

export type SetOption = (
  id: string,
  value: string,
) => Promise<SessionConfigOption[]>;

/** 校验并应用请求的模型与推理强度，返回更新后的 ACP 选项。 */
export async function applySettings(
  options: SessionConfigOption[] | undefined,
  setOption: SetOption,
  settings?: RequestedSettings,
) {
  if (settings?.modelId) {
    const model = selectOption(options, "model");
    if (
      !model ||
      !choices(model).some(
        /* 确认正式会话提供请求的模型。 */ (choice) =>
          choice.id === settings.modelId,
      )
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
      !choices(effort).some(
        /* 确认正式会话提供请求的推理强度。 */ (choice) =>
          choice.id === settings.reasoningEffort,
      )
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
