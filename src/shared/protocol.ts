import { z } from "zod";
import { wakeupTargetSchema } from "./task-wakeup.js";
import { dshTaskFields } from "./dsh-wakeup.js";
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
  approvalGraceMs: 10000,
  approvalWaitMs: 25000,
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
  tools: 100,
  toolChars: 8000,
  browserSubscribers: 8,
  browserFlushMs: 40,
});
export const harnessNameSchema = dshTaskFields.targetHarness.unwrap();
export const harnessSubscriptionSchema = z
  .object({
    ownerId: z.string().uuid(),
    harnessName: harnessNameSchema,
  })
  .strict();
export const auditedHarnessSchema = z.enum([
  "Codex",
  "Grok",
  "ZCode",
  "DeepSeek",
]);
export const isAuditedHarness = (
  name: unknown,
): name is z.infer<typeof auditedHarnessSchema> =>
  auditedHarnessSchema.safeParse(name).success;

const capabilityOptionSchema = z.strictObject({
  id: z.string().min(1).max(160),
  name: z.string().min(1).max(160),
});
export const capabilitySnapshotSchema = z.strictObject({
  models: z
    .array(
      capabilityOptionSchema.extend({
        efforts: z.array(capabilityOptionSchema).max(LIMITS.list),
      }),
    )
    .min(1)
    .max(LIMITS.list),
  defaultModelId: z.string().min(1).max(160).nullable(),
  source: z.literal("acp_session_config"),
});
export const capabilityReportSchema = z.strictObject({
  ownerId: z.uuid(),
  generation: z.uuid(),
  capabilities: capabilitySnapshotSchema,
});
export const harnessViewSchema = harnessSubscriptionSchema.extend({
  capabilities: capabilitySnapshotSchema.optional(),
});
export const harnessListSchema = z.array(harnessViewSchema);
export type HarnessIdentity = z.infer<typeof harnessSubscriptionSchema>;
export type HarnessSubscription = z.infer<typeof harnessViewSchema>;
export type CapabilitySnapshot = z.infer<typeof capabilitySnapshotSchema>;
export type CapabilityReport = z.infer<typeof capabilityReportSchema>;
export const approvalTargetSchema = z.enum(["subscriber", "third_party"]);
export const approvalTargetsSchema = z
  .array(approvalTargetSchema)
  .max(2)
  .refine((targets) => new Set(targets).size === targets.length);
const optionId = z.string().trim().min(1).max(160);
const tokens = z.number().int().nonnegative();
export const requestedSettingsSchema = z
  .strictObject({
    modelId: optionId.optional(),
    reasoningEffort: optionId.optional(),
  })
  .refine(
    (value) =>
      value.modelId !== undefined || value.reasoningEffort !== undefined,
  );
export const modelWindowSchema = z.object({
  tokens: tokens.positive(),
  provider: z.string(),
  modelId: optionId,
  basis: z.string(),
  observedOn: z.string(),
  sourceUrl: z.url(),
});
export const settingsReceiptSchema = z.strictObject({
  status: z.enum(["applied", "default", "rejected"]),
  modelId: optionId.nullable(),
  reasoningEffort: optionId.nullable(),
  confirmedAt: z.iso.datetime(),
  reason: z.string().max(2000).nullable(),
  modelWindow: modelWindowSchema.nullable(),
});
export const usageCountsSchema = z.object({
  uncachedInputTokens: tokens.nullable(),
  cachedReadTokens: tokens.nullable(),
  cachedWriteTokens: tokens.nullable(),
  outputTokens: tokens.nullable(),
  reasoningTokens: tokens.nullable(),
  totalTokens: tokens.nullable(),
});
export const runUsageSchema = usageCountsSchema.extend({
  scope: z.literal("primary_prompt"),
  basis: z.literal("token_breakdown_v1"),
  coverage: z.enum(["complete", "partial", "missing"]),
  inconsistent: z.boolean(),
  cost: z
    .object({ currency: z.literal("USD"), amount: z.number().nonnegative() })
    .optional(),
  modelId: optionId.nullable(),
  missingReason: z.string().optional(),
  source: z.object({
    wireFormat: z.string(),
    adapterVersion: z.string(),
    protocolVersion: z.number().int().positive(),
    method: z.string(),
    fieldPath: z.string(),
    sessionId: z.string().min(1),
    upstreamSessionId: z.string().min(1).optional(),
  }),
});
export const contextObservationSchema = z.strictObject({
  usedTokens: tokens,
  effectiveWindowTokens: tokens.positive().nullable(),
  source: z.enum(["acp_usage_update", "grok_acp_session_meta"]),
});
export type RequestedSettings = z.infer<typeof requestedSettingsSchema>;
export type SettingsReceipt = z.infer<typeof settingsReceiptSchema>;
export type RunUsage = z.infer<typeof runUsageSchema>;
export type ContextObservation = z.infer<typeof contextObservationSchema>;

const publishFieldsSchema = z
  .object({
    ...dshTaskFields,
    requestedSettings: requestedSettingsSchema.optional(),
    approvalTargets: approvalTargetsSchema.optional(),
    wakeup: wakeupTargetSchema.optional(),
  })
  .strict();
export const publishTaskSchema = publishFieldsSchema.refine(
  (task) => !task.requestedSettings || isAuditedHarness(task.targetHarness),
  { path: ["targetHarness"], message: "显式模型设置需要指定支持设置的执行器" },
);
export const taskStatusSchema = z.enum([
  "queued",
  "running",
  "awaiting_approval",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
export const taskSchema = publishFieldsSchema.omit({ wakeup: true }).extend({
  approvalTargets: approvalTargetsSchema.default(["subscriber"]),
  id: z.string(),
  status: taskStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  currentRunId: z.string().nullable(),
});
export const toolSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "failed"]),
  input: z.string(),
  output: z.string(),
});
const auditKeySchema = z.object({
  runId: z.string().min(1),
  seq: z.number().int().positive(),
  sessionId: z.string().min(1),
  createdAt: z.iso.datetime(),
});
export const runAuditSchema = z.discriminatedUnion("kind", [
  auditKeySchema.extend({
    kind: z.literal("tool"),
    toolCallId: z.string().min(1),
    patch: toolSchema.omit({ id: true }).partial(),
    truncated: z.boolean(),
    redacted: z.boolean(),
  }),
  auditKeySchema.extend({
    kind: z.literal("context"),
    observation: contextObservationSchema,
  }),
]);
export type RunAudit = z.infer<typeof runAuditSchema>;
export const runSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  status: taskStatusSchema,
  sessionId: z.string().nullable(),
  createdAt: z.string(),
  endedAt: z.string().nullable(),
  output: z.string(),
  reasoning: z.string().default(""),
  tools: z.array(toolSchema).default([]),
  error: z.string().nullable(),
  stopReason: z.string().nullable(),
  discovery: z.custom<InitializeResponse>().nullable(),
  ownerId: z.string().nullable().default(null),
  harnessName: harnessNameSchema.nullable().default(null),
  settingsReceipt: settingsReceiptSchema.optional(),
  usage: runUsageSchema.optional(),
  context: contextObservationSchema.optional(),
});
// ACP payloads are validated by the official SDK at the transport boundary. No handwritten ACP wire schema.
export const approvalChoiceSchema = z.object({
  optionId: z.string(),
  decidedAt: z.string(),
});
export const approvalPromptSchema = z.object({
  title: z.string(),
  description: z.string(),
});
export const approvalSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  runId: z.string(),
  sessionId: z.string(),
  requestId: z.union([z.string(), z.number(), z.null()]),
  request: z.custom<RequestPermissionRequest>(),
  prompt: approvalPromptSchema.optional(),
  status: z.enum(["pending", "decided", "expired"]),
  optionId: z.string().nullable(),
  createdAt: z.string(),
  resolvedAt: z.iso.datetime().nullable().optional(),
  reviewerDecisions: z
    .array(approvalChoiceSchema.extend({ target: approvalTargetSchema }))
    .default([]),
  userDecision: approvalChoiceSchema.nullable().default(null),
  fallbackAt: z.string().nullable().default(null),
  resolvedBy: z
    .enum(["user", "subscriber", "third_party"])
    .nullable()
    .default(null),
});
export const eventSchema = z.object({
  id: z.number(),
  runId: z.string(),
  createdAt: z.string(),
  notification: z.custom<SessionNotification>(),
});
export const auditPageSchema = z.object({
  runId: z.string(),
  entries: z.array(runAuditSchema),
  approvals: z.array(approvalSchema),
  nextCursor: z.string().nullable(),
});
export type AuditPage = z.infer<typeof auditPageSchema>;
export const detailSchema = z.object({
  task: taskSchema,
  runs: z.array(runSchema),
  approvals: z.array(approvalSchema),
  events: z.array(eventSchema),
  usageSummary: usageCountsSchema
    .extend({
      scope: runUsageSchema.shape.scope,
      basis: runUsageSchema.shape.basis,
      coverage: runUsageSchema.shape.coverage,
      runCount: z.number().int().positive(),
      overflow: z.array(usageCountsSchema.keyof()),
    })
    .optional(),
});
export const browserSnapshotSchema = z.object({
  tasks: z.array(taskSchema),
  harnesses: harnessListSchema,
  detail: detailSchema.nullable(),
  pendingApprovals: z.array(approvalSchema).default([]),
  serverTime: z.number().optional(),
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
export const approvalSubscriptionSchema = z.object({
  taskId: z.string().uuid(),
  subscriptionToken: z.string().regex(/^[a-f0-9]{64}$/),
});
export const publishResultSchema = z.object({
  taskId: z.string(),
  approvalSubscription: approvalSubscriptionSchema.optional(),
  wakeup: wakeupTargetSchema.optional(),
});
export const subscriberDecisionSchema = approvalSubscriptionSchema
  .extend({
    approvalId: z.string().uuid(),
    ...decisionSchema.shape,
  })
  .strict();
export const approvalWaitSchema = approvalSubscriptionSchema
  .extend({
    waitMs: z
      .number()
      .int()
      .min(0)
      .max(LIMITS.approvalWaitMs)
      .default(LIMITS.approvalWaitMs),
  })
  .strict();
export const approvalSnapshotSchema = z.object({
  type: z.literal("approval.snapshot"),
  taskId: z.string(),
  taskStatus: taskStatusSchema,
  approvals: z.array(approvalSchema),
});
export type PublishTask = z.infer<typeof publishTaskSchema>;
export type Task = z.infer<typeof taskSchema>;
export type Run = z.infer<typeof runSchema>;
export type Approval = z.infer<typeof approvalSchema>;
export type TaskDetail = z.infer<typeof detailSchema>;
export type Decision = z.infer<typeof decisionSchema>;
export type SubscriberDecision = z.infer<typeof subscriberDecisionSchema>;
export type ApprovalSubscription = z.infer<typeof approvalSubscriptionSchema>;
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
  z.strictObject({
    type: z.literal("settings"),
    sessionId: z.string().min(1).nullable(),
    receipt: settingsReceiptSchema,
  }),
  z.object({
    type: z.literal("discovery"),
    discovery: z.custom<InitializeResponse>(),
  }),
  z.object({
    type: z.literal("notification"),
    notification: z.custom<SessionNotification>(),
  }),
  z.strictObject({
    type: z.literal("context"),
    sessionId: z.string().min(1),
    observation: contextObservationSchema,
  }),
  z.object({
    type: z.literal("finished"),
    status: z.enum(["succeeded", "failed", "cancelled", "interrupted"]),
    stopReason: z.string().nullable(),
    error: z.string().max(2000).nullable(),
    usage: runUsageSchema.optional(),
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
