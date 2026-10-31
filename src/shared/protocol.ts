import { z } from "zod";
import type {
  InitializeResponse,
  RequestPermissionRequest,
  SessionNotification,
} from "@agentclientprotocol/sdk";

export const LIMITS = Object.freeze({
  queue: 100,
  list: 200,
  runsPerTask: 20,
  events: 300,
  approvalsPerRun: 100,
  pendingApprovals: 16,
  outputChars: 64000,
  httpBytes: 128 * 1024,
  acpBytes: 1024 * 1024,
  initMs: 30000,
  runMs: 30 * 60000,
  approvalMs: 10 * 60000,
  killMs: 2000,
  sessions: 64,
  sessionMs: 12 * 3600000,
  httpConcurrent: 16,
});
export const publishTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(16000),
    publisherName: z.string().trim().min(1).max(80),
  })
  .strict();
export const taskStatusSchema = z.enum([
  "queued",
  "running",
  "awaiting_approval",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
export const taskSchema = publishTaskSchema.extend({
  id: z.string(),
  status: taskStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  currentRunId: z.string().nullable(),
});
export const runSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  status: taskStatusSchema,
  sessionId: z.string().nullable(),
  createdAt: z.string(),
  endedAt: z.string().nullable(),
  output: z.string(),
  error: z.string().nullable(),
  stopReason: z.string().nullable(),
  discovery: z.custom<InitializeResponse>().nullable(),
});
// ACP payloads are validated by the official SDK at the transport boundary. No handwritten ACP wire schema.
export const approvalSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  runId: z.string(),
  sessionId: z.string(),
  requestId: z.union([z.string(), z.number(), z.null()]),
  request: z.custom<RequestPermissionRequest>(),
  status: z.enum(["pending", "decided", "expired"]),
  optionId: z.string().nullable(),
  createdAt: z.string(),
});
export const eventSchema = z.object({
  id: z.number(),
  runId: z.string(),
  createdAt: z.string(),
  notification: z.custom<SessionNotification>(),
});
export const detailSchema = z.object({
  task: taskSchema,
  runs: z.array(runSchema),
  approvals: z.array(approvalSchema),
  events: z.array(eventSchema),
});
export const decisionSchema = z
  .object({
    runId: z.string().min(1),
    sessionId: z.string().min(1),
    optionId: z.string().min(1),
  })
  .strict();
export const bootstrapSchema = z.object({
  csrf: z.string(),
  mode: z.enum(["codex", "fake"]),
  workspace: z.string(),
});
export const publishResultSchema = z.object({ taskId: z.string() });
export type PublishTask = z.infer<typeof publishTaskSchema>;
export type Task = z.infer<typeof taskSchema>;
export type Run = z.infer<typeof runSchema>;
export type Approval = z.infer<typeof approvalSchema>;
export type TaskDetail = z.infer<typeof detailSchema>;
export type Decision = z.infer<typeof decisionSchema>;
export type Bootstrap = z.infer<typeof bootstrapSchema>;
