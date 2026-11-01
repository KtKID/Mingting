import type { SessionNotification } from "@agentclientprotocol/sdk";
import { LIMITS, type Run } from "../shared/protocol.js";

function preview(value: unknown): string {
  if (value === undefined || value === null) return "";
  return (
    typeof value === "string" ? value : JSON.stringify(value, null, 2)
  ).slice(0, LIMITS.toolChars);
}

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
  if (update.title != null)
    tool.title = update.title.slice(0, LIMITS.toolChars);
  if (update.kind != null) tool.kind = update.kind;
  if (update.status != null) tool.status = update.status;
  if (update.rawInput != null) tool.input = preview(update.rawInput);
  if (update.rawOutput != null) tool.output = preview(update.rawOutput);
  else if (update.content != null) {
    tool.output = update.content
      .map((c) =>
        c.type === "content" && c.content.type === "text"
          ? c.content.text
          : c.type === "diff"
            ? `${c.path}\n${c.newText}`
            : "",
      )
      .join("\n")
      .slice(0, LIMITS.toolChars);
  }
}
