import { z } from "zod";
import type { SessionNotification } from "@agentclientprotocol/sdk";

// Native ZCode 0.17.1 session events, shaped by the official mapSessionEvent.
const envelope = z.object({
  type: z.string(),
  sessionId: z.string().optional(),
  payload: z.unknown().optional(),
});
const model = z.object({ kind: z.string(), delta: z.string().optional() });
const tool = z.object({
  toolCallId: z.string().min(1),
  kind: z.string(),
  toolName: z.string().optional(),
  input: z.unknown().optional(),
  result: z
    .object({ success: z.boolean(), content: z.unknown().optional() })
    .optional(),
});
const result = z.object({
  type: z.literal("result"),
  sessionId: z.string().min(1),
  response: z.string(),
  projection: z.object({ status: z.literal("idle") }),
});
export function translateZcodeLine(
  value: unknown,
  sessionId: string,
): { update?: SessionNotification; result?: z.infer<typeof result> } {
  const event = envelope.parse(value);
  if (event.type === "result") return { result: result.parse(value) };
  if (event.type === "permission.resolved") {
    const payload = z
      .object({
        toolCallId: z.string().min(1),
        decision: z.string(),
        reason: z.string().optional(),
      })
      .parse(event.payload);
    if (payload.decision !== "deny") return {};
    return {
      update: {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: payload.toolCallId,
          status: "failed",
          rawOutput: payload.reason ?? "审批拒绝，操作已停止",
        },
      },
    };
  }
  if (event.type === "model.streaming") {
    const payload = model.parse(event.payload);
    if (payload.kind !== "text_delta" && payload.kind !== "reasoning_delta")
      return {};
    if (payload.delta === undefined) throw new Error("ZCode 增量缺少内容");
    return {
      update: {
        sessionId,
        update: {
          sessionUpdate:
            payload.kind === "text_delta"
              ? "agent_message_chunk"
              : "agent_thought_chunk",
          content: { type: "text", text: payload.delta },
        },
      },
    };
  }
  if (event.type === "tool.updated") {
    const { kind } = z.object({ kind: z.string() }).parse(event.payload);
    if (!["scheduled", "started", "result"].includes(kind)) return {};
    const payload = tool.parse(event.payload);
    if (payload.kind === "scheduled")
      return {
        update: {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: payload.toolCallId,
            title: payload.toolName ?? "工具操作",
            kind: "read",
            status: "pending",
            rawInput: payload.input,
          },
        },
      };
    if (payload.kind === "started")
      return {
        update: {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: payload.toolCallId,
            status: "in_progress",
          },
        },
      };
    if (payload.kind === "result") {
      if (!payload.result) throw new Error("ZCode 工具事件缺少结果");
      return {
        update: {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: payload.toolCallId,
            status: payload.result.success ? "completed" : "failed",
            rawOutput: payload.result.content,
          },
        },
      };
    }
  }
  return {};
}
