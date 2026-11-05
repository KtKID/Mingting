import { z } from "zod";

export const wakeupTargetSchema = z
  .object({
    threadId: z.string().uuid(),
    originTurnId: z.string().uuid(),
  })
  .strict();
export const wakeupEventSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(["approval.requested", "task.completed"]),
    taskId: z.string().uuid(),
    runId: z.string().uuid(),
    approvalId: z.string().uuid().nullable(),
    target: wakeupTargetSchema,
    createdAt: z.string().datetime(),
    status: z.enum([
      "pending",
      "sending",
      "delivered",
      "failed",
      "acknowledged",
      "superseded",
    ]),
    attempts: z.number().int().nonnegative(),
    deliveredAt: z.string().datetime().nullable(),
    receipt: z.unknown().nullable(),
    error: z.string().nullable(),
    resumedTurnId: z.string().uuid().nullable(),
    acknowledgedAt: z.string().datetime().nullable(),
  })
  .strict();
export const wakeupHostStatusSchema = z
  .object({
    available: z.boolean(),
    transport: z.string(),
    error: z.string().nullable(),
  })
  .strict();
export const wakeupAcknowledgementSchema = z
  .object({
    eventId: z.string().min(1),
    threadId: z.string().uuid(),
    turnId: z.string().uuid(),
  })
  .strict();
export type WakeupTarget = z.infer<typeof wakeupTargetSchema>;
export type WakeupEvent = z.infer<typeof wakeupEventSchema>;
export type WakeupHostStatus = z.infer<typeof wakeupHostStatusSchema>;
export type WakeupAcknowledgement = z.infer<typeof wakeupAcknowledgementSchema>;
