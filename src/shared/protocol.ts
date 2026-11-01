import { z } from "zod";
import type {
  InitializeResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
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
  cliMs: 90000,
  approvalMs: 10 * 60000,
  killMs: 2000,
  sessions: 64,
  sessionMs: 12 * 3600000,
  httpConcurrent: 24,
  subscribers: 8,
  subscriptionHeartbeatMs: 10000,
  reconnectMs: 500,
  leaseMs: 8000,
  heartbeatMs: 1000,
  connectorHttpMs: 2500,
  approvalPollMs: 250,
  sweepMs: 250,
  pendingReports: 256,
});
export const harnessNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/);
export const harnessSubscriptionSchema = z
  .object({
    ownerId: z.string().uuid(),
    harnessName: harnessNameSchema,
  })
  .strict();
export const harnessListSchema = z.array(harnessSubscriptionSchema);
export type HarnessSubscription = z.infer<typeof harnessSubscriptionSchema>;
export const publishTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(16000),
    publisherName: z.string().trim().min(1).max(80),
    targetHarness: harnessNameSchema.optional(),
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
  ownerId: z.string().nullable().default(null),
  harnessName: harnessNameSchema.nullable().default(null),
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

// Task subscription is an application transport, distinct from ACP session/update and MCP.
export const deliveryEventSchema = z
  .object({
    id: z.number().int().positive(),
    type: z.literal("task.available"),
    taskId: z.string().uuid(),
    createdAt: z.string(),
  })
  .strict();
export const claimTaskSchema = z
  .object({
    taskId: z.string().uuid(),
    ownerId: z.string().uuid(),
    claimId: z.string().uuid(),
  })
  .strict();
export const ownerSchema = claimTaskSchema.omit({ taskId: true });
export const claimResultSchema = z.object({
  task: taskSchema,
  run: runSchema,
  ownerId: z.string().uuid(),
  claimId: z.string().uuid(),
  leaseMs: z.number(),
  workspace: z.string(),
  mode: z.enum(["fake", "codex"]),
});
export const connectorUpdateSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session"), sessionId: z.string().min(1) }),
  z.object({
    type: z.literal("discovery"),
    discovery: z.custom<InitializeResponse>(),
  }),
  z.object({
    type: z.literal("notification"),
    notification: z.custom<SessionNotification>(),
  }),
  z.object({
    type: z.literal("finished"),
    status: z.enum(["succeeded", "failed", "cancelled", "interrupted"]),
    stopReason: z.string().nullable(),
    error: z.string().max(2000).nullable(),
  }),
]);
export const reportSchema = ownerSchema
  .extend({ seq: z.number().int().positive(), update: connectorUpdateSchema })
  .strict();
export const permissionSubmissionSchema = ownerSchema
  .extend({
    requestId: z.union([z.string(), z.number(), z.null()]),
    request: z.custom<RequestPermissionRequest>(),
  })
  .strict();
export type DeliveryEvent = z.infer<typeof deliveryEventSchema>;
export type Claim = z.infer<typeof claimResultSchema>;
export type Owner = z.infer<typeof ownerSchema>;
export type ConnectorUpdate = z.infer<typeof connectorUpdateSchema>;

export const heartbeatResultSchema = z.object({
  status: taskStatusSchema,
  cancelRequested: z.boolean(),
  leaseMs: z.number(),
});
export const approvalCreatedSchema = z.object({
  approvalId: z.string().uuid(),
});
export const permissionResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({
    status: z.literal("resolved"),
    response: z.custom<RequestPermissionResponse>(),
  }),
]);
