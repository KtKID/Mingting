import { z } from "zod";

export const publishTaskToolName = "mcp-mingting-tool";
export const taskCommandDescription =
  "同一任务的后续沟通使用 append，填写该任务已有的 taskId 和本轮要执行的内容。独立的新任务使用 new，填写标题、发布者和任务内容。后续追加沿用原任务编号。收到本轮结果后，由发布者决定是否继续追加。";

export const dshTaskFields = {
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(16000),
  publisherName: z.string().trim().min(1).max(80),
  targetHarness: z
    .string()
    .trim()
    .regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/)
    .optional(),
};

export const appendTaskSchema = z.strictObject({
  action: z.literal("append"),
  taskId: z.uuid(),
  description: dshTaskFields.description,
});
export const dshTaskCommandSchema = z.union([
  z.strictObject({ ...dshTaskFields, action: z.literal("new").optional() }),
  appendTaskSchema,
]);

export const dshSessionFields = {
  // DSH stores the native ID as one path segment and may mint `session-<uuid>`.
  sessionId: z.string().min(1).max(255),
  originTurn: z.int().positive(),
};
export const publisherContextKey = "mingting.local/publisher-context";
export const dshPublisherContextSchema = z.strictObject({
  ...dshSessionFields,
  targetSessionId: dshSessionFields.sessionId.optional(),
  publishRequestId: z.string().min(1).max(128),
});
export const dshWakeupTargetSchema = z.strictObject({
  hostId: z.uuid(),
  ...dshSessionFields,
  publisherSessionId: dshSessionFields.sessionId.optional(),
});
export const resultSubscriptionSchema = z.object({
  taskId: z.uuid(),
  subscriptionToken: z.string().regex(/^[a-f0-9]{64}$/),
});
export const appendReceiptSchema = z.object({
  taskId: z.uuid(),
  taskUrl: z.url(),
  taskTurn: z.int().positive(),
});
export const resultReceiptSchema = z.object({
  taskId: z.uuid(),
  taskUrl: z.url(),
  resultSubscription: resultSubscriptionSchema,
  taskTurn: z.int().positive().optional(),
});
export const terminalTaskStatuses = [
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export const taskResultEventSchema = z.strictObject({
  eventId: z.string().regex(/^task\.completed:[a-f0-9-]{36}$/),
  taskId: z.uuid(),
  runId: z.uuid(),
  status: z.enum(terminalTaskStatuses),
  output: z.string(),
  error: z.string().nullable(),
  endedAt: z.iso.datetime(),
});
export const wakeupResultHeader = "x-mingting-wakeup-result";

export const dshPublishSchema = z.strictObject({
  ...dshTaskFields,
  ...dshSessionFields,
  publishRequestId: z.string().min(1).max(128),
});
export const dshPublishResultSchema = z.strictObject({ taskId: z.uuid() });
export const dshReadySchema = z.strictObject({ hostId: z.uuid() });
export const dshCompletionSchema = z.strictObject({
  eventId: taskResultEventSchema.shape.eventId,
  taskId: taskResultEventSchema.shape.taskId,
  runId: taskResultEventSchema.shape.runId,
  ...dshSessionFields,
  completedAt: z.iso.datetime(),
  taskTurn: z.int().positive().optional(),
  result: taskResultEventSchema
    .pick({ status: true, output: true, error: true })
    .extend({
      truncated: z.boolean(),
    })
    .optional(),
});
const ackFields = {
  eventId: dshCompletionSchema.shape.eventId,
  sessionId: dshSessionFields.sessionId,
};
export const dshAckSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ ...ackFields, outcome: z.literal("accepted") }),
  z.strictObject({
    ...ackFields,
    outcome: z.literal("rejected"),
    reason: z.enum(["session-unavailable"]),
  }),
]);
export const dshAckResultSchema = z.strictObject({ ok: z.literal(true) });
export type DshPublish = z.infer<typeof dshPublishSchema>;
export type DshPublisherContext = z.infer<typeof dshPublisherContextSchema>;
export type DshCompletion = z.infer<typeof dshCompletionSchema>;
export type DshAck = z.infer<typeof dshAckSchema>;
