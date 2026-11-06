import { z } from "zod";

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

export const dshSessionFields = {
  // DSH stores the native ID as one path segment and may mint `session-<uuid>`.
  sessionId: z.string().min(1).max(255),
  originTurn: z.int().positive(),
};

export const dshPublishSchema = z.strictObject({
  ...dshTaskFields,
  ...dshSessionFields,
  publishRequestId: z.string().min(1).max(128),
});
export const dshPublishResultSchema = z.strictObject({ taskId: z.uuid() });
export const dshReadySchema = z.strictObject({ hostId: z.uuid() });
export const dshCompletionSchema = z.strictObject({
  eventId: z.string().regex(/^task\.completed:[a-f0-9-]{36}$/),
  taskId: z.uuid(),
  runId: z.uuid(),
  ...dshSessionFields,
  completedAt: z.iso.datetime(),
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
export type DshCompletion = z.infer<typeof dshCompletionSchema>;
export type DshAck = z.infer<typeof dshAckSchema>;
