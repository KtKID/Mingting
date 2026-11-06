import { z } from "zod";
import { detailSchema } from "./protocol.js";

export const recordingSourceSchema = z.object({
  taskId: z.string().uuid(),
  path: z.string(),
  sha256: z.string().length(64),
});
const vote = z.enum(["allow", "deny"]).nullable();
export const scenarioSchema = z.object({
  id: z.string().regex(/^R\d+$/),
  title: z.string(),
  subscriber: vote,
  user: vote,
  refresh: z.boolean().default(false),
  cancel: z.boolean().default(false),
});
export const scenarios = z.array(scenarioSchema).parse([
  { id: "R1", title: "双方同意", subscriber: "allow", user: "allow" },
  {
    id: "R2",
    title: "订阅者同意 · 用户拒绝",
    subscriber: "allow",
    user: "deny",
  },
  {
    id: "R3",
    title: "订阅者拒绝 · 用户同意",
    subscriber: "deny",
    user: "allow",
  },
  { id: "R4", title: "双方拒绝", subscriber: "deny", user: "deny" },
  {
    id: "R5",
    title: "订阅者同意 · 十秒后执行",
    subscriber: "allow",
    user: null,
  },
  {
    id: "R6",
    title: "订阅者拒绝 · 十秒后停止",
    subscriber: "deny",
    user: null,
  },
  { id: "R7", title: "用户先同意", subscriber: null, user: "allow" },
  { id: "R8", title: "用户先拒绝", subscriber: null, user: "deny" },
  {
    id: "R9",
    title: "刷新后继续倒计时 · 用户拒绝",
    subscriber: "allow",
    user: "deny",
    refresh: true,
  },
  {
    id: "R10",
    title: "倒计时内取消任务",
    subscriber: "allow",
    user: null,
    cancel: true,
  },
]);
export const optionFor = (choice: "allow" | "deny") =>
  choice === "allow" ? "allow_once" : "deny";
export const commandSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  action: z.enum(["start", "vote", "note", "finish", "stop"]),
  label: z.string().default(""),
  image: z
    .string()
    .regex(/^[A-Za-z0-9-]+\.png$/)
    .optional(),
});
export const replayCaseSchema = scenarioSchema.extend({
  taskId: z.string(),
  phase: z.string(),
  detail: detailSchema.nullable(),
  originalDeadline: z.string().default(""),
  passed: z.boolean(),
  snapshotPath: z.string().optional(),
  steps: z.array(
    z.object({
      at: z.string(),
      label: z.string(),
      image: z.string().optional(),
      state: z.unknown().optional(),
    }),
  ),
  checks: z.array(z.object({ label: z.string(), passed: z.boolean() })),
});
export const replayReportSchema = z.object({
  runId: z.string().uuid(),
  startedAt: z.string(),
  platform: z.string().url(),
  kind: z.string(),
  sources: z.array(recordingSourceSchema),
  stopped: z.boolean(),
  error: z.string(),
  commandId: z.string(),
  currentCaseId: z.string(),
  cases: z.array(replayCaseSchema),
});
export type ReplayReport = z.infer<typeof replayReportSchema>;

const stageResultSchema = z.object({
  startedAt: z.string(),
  finishedAt: z.string(),
  exitCode: z.number(),
  logPath: z.string(),
});
export const regressionStageSchema = stageResultSchema.extend({
  name: z.enum(["recording", "unit", "build", "approval"]),
});
export const uiRegressionStageSchema = stageResultSchema.extend({
  name: z.literal("ui"),
});
export const approvalBatchSchema = z.object({
  id: z.string().uuid(),
  mode: z.enum(["default", "approval", "manual"]),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  status: z.enum(["running", "passed", "failed", "interrupted"]),
  reportPath: z.string().regex(/^runs\/[a-f0-9-]+\/report\.json$/),
  recordingPath: z.string(),
  recordingSha256: z.string().length(64).nullable(),
  caseCount: z.number().int(),
  passed: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
  stages: z.array(regressionStageSchema),
  uiStage: uiRegressionStageSchema.optional(),
});
export const approvalHistorySchema = z.object({
  version: z.literal(1),
  runs: z.array(approvalBatchSchema),
});
export type ApprovalBatch = z.infer<typeof approvalBatchSchema>;
