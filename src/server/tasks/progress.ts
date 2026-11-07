import type { SessionNotification } from "@agentclientprotocol/sdk";
import { LIMITS, type Run } from "../../shared/protocol.js";

const secretField =
  /^(authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)$/i;

/** 把 ACP 增量合并到当前运行视图，即使早期原始事件被清理，视图仍可单独展示。 */
export function applyProgress(run: Run, notification: SessionNotification) {
  const update = notification.update;
  if (
    update.sessionUpdate === "agent_message_chunk" &&
    update.content.type === "text"
  )
    run.output = (run.output + update.content.text).slice(-LIMITS.outputChars);
  if (
    update.sessionUpdate === "agent_thought_chunk" &&
    update.content.type === "text"
  )
    run.reasoning = (run.reasoning + update.content.text).slice(
      -LIMITS.outputChars,
    );
  if (
    update.sessionUpdate !== "tool_call" &&
    update.sessionUpdate !== "tool_call_update"
  )
    return;

  let truncated = false;
  let redacted = false;
  /** 把工具数据转为有长度上限的安全预览，并记录脱敏与截断状态。 */
  const preview = (value: unknown) => {
    const text =
      typeof value === "string"
        ? value
        : JSON.stringify(
            value,
            (key, item: unknown) => {
              // 序列化对象时替换敏感字段的值。
              if (!secretField.test(key)) return item;
              redacted = true;
              return "[已脱敏]";
            },
            2,
          );
    const safe = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, () => {
      // 隐藏文本中匹配到的 Bearer 令牌。
      redacted = true;
      return "Bearer [已脱敏]";
    });
    truncated ||= safe.length > LIMITS.toolChars;
    return safe.slice(0, LIMITS.toolChars);
  };
  const patch: Partial<Omit<Run["tools"][number], "id">> = {};
  if (update.title != null) patch.title = preview(update.title);
  if (update.kind != null) patch.kind = update.kind;
  if (update.status != null) patch.status = update.status;
  if (update.rawInput != null) patch.input = preview(update.rawInput);
  if (update.rawOutput != null) patch.output = preview(update.rawOutput);
  else if (update.content != null) {
    patch.output = preview(
      update.content
        .map(
          /* 从工具内容中提取文本或带路径的文件变更。 */ (c) =>
            c.type === "content" && c.content.type === "text"
              ? c.content.text
              : c.type === "diff"
                ? `${c.path}\n${c.newText}`
                : "",
        )
        .join("\n"),
    );
  }

  let tool = run.tools.find(
    /* 按工具调用 ID 找到要更新的现有条目。 */ (t) =>
      t.id === update.toolCallId,
  );
  if (!tool) {
    tool = {
      id: update.toolCallId,
      title: "工具操作",
      kind: "other",
      status: "pending",
      input: "",
      output: "",
    };
    run.tools.push(tool);
    if (run.tools.length > LIMITS.tools) run.tools.shift();
  }
  Object.assign(tool, patch);
  return { toolCallId: update.toolCallId, patch, truncated, redacted };
}
