import { z } from "zod";

export const recordPhaseSchema = z.enum([
  "not_started",
  "in_progress",
  "awaiting_review",
  "completed",
  "unknown",
]);
export const recordPhaseLabels = {
  not_started: "待开始",
  in_progress: "进行中",
  awaiting_review: "待验收",
  completed: "已完成",
  unknown: "待核对",
} satisfies Record<z.infer<typeof recordPhaseSchema>, string>;
export const recordSourceSchema = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  label: z.string(),
  excerpt: z.string(),
});
export const recordStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["pending", "active", "passed", "failed", "unknown"]),
});
export const recordedTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  path: z.string(),
  phase: recordPhaseSchema,
  blocker: z.string().nullable(),
  summary: z.string(),
  steps: z.array(recordStepSchema),
  sources: z.array(recordSourceSchema),
  statusSource: recordSourceSchema.nullable(),
});
export const recordedSpecSchema = z.object({
  id: z.string(),
  title: z.string(),
  path: z.string(),
  goal: z.string(),
  phase: recordPhaseSchema,
  tasks: z.array(recordedTaskSchema),
});
export const projectRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  root: z.string(),
  specs: z.array(recordedSpecSchema),
  sourceVersion: z.string(),
  observedAt: z.iso.datetime(),
  changedAt: z.iso.datetime(),
  syncError: z.string().nullable(),
});
export const projectRecordsSchema = z.array(projectRecordSchema);
export const syncProjectRecordsSchema = z
  .object({
    projectRoot: z.string().trim().min(1).max(4096),
    projectName: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
export const projectDirectoryChoiceSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("cancelled") }),
  z.object({
    status: z.literal("selected"),
    projectRoot: z.string().min(1),
    projectName: z.string().min(1),
  }),
]);
export const syncProjectRecordsReceiptSchema = z.object({
  projectId: z.string(),
  specCount: z.number().int().nonnegative(),
  taskCount: z.number().int().nonnegative(),
  observedAt: z.iso.datetime(),
});
export const recordDocumentSchema = z.object({
  path: z.string(),
  content: z.string(),
});
export type RecordPhase = z.infer<typeof recordPhaseSchema>;
export type RecordSource = z.infer<typeof recordSourceSchema>;
export type RecordStep = z.infer<typeof recordStepSchema>;
export type RecordedTask = z.infer<typeof recordedTaskSchema>;
export type RecordedSpec = z.infer<typeof recordedSpecSchema>;
export type ProjectRecord = z.infer<typeof projectRecordSchema>;

/** Spec 汇总沿用 Task 的阶段，资料不足保持可见。 */
export function aggregateRecordPhase(tasks: RecordedTask[]): RecordPhase {
  if (!tasks.length || tasks.some((t) => t.phase === "unknown"))
    return "unknown";
  if (tasks.every((t) => t.phase === "completed")) return "completed";
  if (tasks.some((t) => t.phase === "in_progress" || t.blocker))
    return "in_progress";
  if (tasks.some((t) => t.phase === "awaiting_review"))
    return "awaiting_review";
  return tasks.every((t) => t.phase === "not_started")
    ? "not_started"
    : "in_progress";
}
