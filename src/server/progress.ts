import type { SessionNotification } from "@agentclientprotocol/sdk";
import { LIMITS, type Run } from "../shared/protocol.js";

const secretField =
  /^(authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)$/i;

// Materialized projection: bounded raw history can expire while the current view survives.
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
  const preview = (value: unknown) => {
    const text =
      typeof value === "string"
        ? value
        : JSON.stringify(
            value,
            (key, item: unknown) => {
              if (!secretField.test(key)) return item;
              redacted = true;
              return "[已脱敏]";
            },
            2,
          );
    const safe = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, () => {
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
        .map((c) =>
          c.type === "content" && c.content.type === "text"
            ? c.content.text
            : c.type === "diff"
              ? `${c.path}\n${c.newText}`
              : "",
        )
        .join("\n"),
    );
  }

  let tool = run.tools.find((t) => t.id === update.toolCallId);
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
