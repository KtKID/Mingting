import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { auditPageSchema, detailSchema } from "../src/shared/protocol.js";

const evidenceSchema = z.object({
  detail: detailSchema,
  audit: auditPageSchema,
  trace: z.array(
    z.object({
      method: z.string(),
      sessionId: z.string(),
      data: z.unknown(),
      at: z.iso.datetime(),
    }),
  ),
  browser: z.array(
    z.object({
      runId: z.string(),
      endedAt: z.string().nullable(),
      outputChars: z.number(),
    }),
  ),
  toolMarker: z.string().nullable(),
});
const rawUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedReadTokens: z.number().int().nonnegative(),
  cachedWriteTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  thoughtTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});
const readbackSchema = z.object({
  modelId: z.string(),
  reasoningEffort: z.string(),
});
const usageUpdate = z.object({
  used: z.number().int().nonnegative(),
  size: z.number().int().positive(),
});

const input = process.argv[2];
if (!input)
  throw new Error(
    "用法：node --import tsx scripts/verify-codex-task-usage.ts <evidence.json>",
  );
const { detail, audit, trace, browser, toolMarker } = evidenceSchema.parse(
  JSON.parse(await readFile(input, "utf8")),
);
const run = detail.runs.find((item) => item.id === audit.runId);
assert.ok(run?.sessionId, "审计必须关联到一个实际 ACP 会话");
assert.equal(detail.runs.length, 1, "验收任务只有一次运行");
assert.equal(detail.task.currentRunId, run.id);
assert.equal(run.status, "succeeded");
assert.ok(run.endedAt);
const signals = trace.filter((event) => event.sessionId === run.sessionId);
const readback = signals.findIndex(
  (event) => event.method === "session/config_readback",
);
const committed = signals.findIndex(
  (event) => event.method === "mingting/settings_committed",
);
const prompt = signals.findIndex((event) => event.method === "session/prompt");
assert.ok(
  readback >= 0 && readback < committed && committed < prompt,
  "必须先回读、提交回执，再发出 prompt",
);
assert.equal(
  signals.filter((event) => event.method === "session/prompt").length,
  1,
);
const confirmed = readbackSchema.parse(signals[readback]?.data);
assert.equal(run.settingsReceipt?.status, "applied");
assert.deepEqual(confirmed, {
  modelId: run.settingsReceipt.modelId,
  reasoningEffort: run.settingsReceipt.reasoningEffort,
});
assert.deepEqual(confirmed, detail.task.requestedSettings);
const chunks = new Set(
  browser
    .filter(
      (entry) =>
        entry.runId === run.id && !entry.endedAt && entry.outputChars > 0,
    )
    .map((entry) => entry.outputChars),
);
assert.ok(chunks.size >= 2, "浏览器必须在运行结束前看到至少两段不同长度的正文");
const allowed = audit.approvals.find(
  (approval) =>
    approval.runId === run.id &&
    approval.sessionId === run.sessionId &&
    approval.resolvedBy === "user" &&
    approval.request.options.some(
      (option) =>
        option.optionId === approval.optionId &&
        option.kind.startsWith("allow"),
    ),
);
assert.ok(allowed?.resolvedAt, "缺少真实网页工具审批结果");
const toolCallId = allowed.request.toolCall.toolCallId;
assert.ok(
  audit.entries.some(
    (event) =>
      event.kind === "tool" &&
      event.toolCallId === toolCallId &&
      event.patch.status === "completed",
  ),
  "审批所对应的工具必须有实际完成事件",
);
const request = z.object({ requestId: z.unknown(), toolCallId: z.string() });
const approvalWire = signals
  .filter((event) => event.method === "session/request_permission")
  .map((event) => request.parse(event.data))
  .find((event) => event.toolCallId === toolCallId);
assert.equal(
  approvalWire?.requestId,
  allowed.requestId,
  "实际 ACP 请求 ID 必须与明庭审批一致",
);
const outcome = signals
  .filter((event) => event.method === "session/request_permission.result")
  .map((event) =>
    z
      .object({
        requestId: z.unknown(),
        outcome: z.object({
          outcome: z.string(),
          optionId: z.string().optional(),
        }),
      })
      .parse(event.data),
  )
  .find((event) => event.requestId === approvalWire?.requestId);
assert.deepEqual(outcome?.outcome, {
  outcome: "selected",
  optionId: allowed.optionId,
});
assert.equal(toolMarker, "mingting-codex-acp-verified");

const terminal = signals.filter(
  (event) => event.method === "session/prompt.result",
);
assert.equal(terminal.length, 1);
const source = z
  .object({
    stopReason: z.literal("end_turn"),
    usage: rawUsage,
    adapterVersion: z.string(),
    protocolVersion: z.number(),
  })
  .parse(terminal[0]?.data);
const wire = source.usage;
assert.ok(run.usage);
assert.equal(run.usage.coverage, "complete");
assert.equal(run.usage.inconsistent, false);
assert.equal(run.usage.scope, "primary_prompt");
assert.equal(run.usage.source.sessionId, run.sessionId);
assert.equal(run.usage.source.adapterVersion, source.adapterVersion);
const fields = {
  uncachedInputTokens: wire.inputTokens,
  cachedReadTokens: wire.cachedReadTokens,
  cachedWriteTokens: wire.cachedWriteTokens,
  outputTokens: wire.outputTokens,
  reasoningTokens: wire.thoughtTokens,
  totalTokens: wire.totalTokens,
};
for (const key of Object.keys(fields) as Array<keyof typeof fields>) {
  assert.equal(run.usage[key], fields[key], key);
  assert.equal(detail.usageSummary?.[key], fields[key], `任务汇总 ${key}`);
}
assert.equal(
  wire.totalTokens,
  wire.inputTokens +
    wire.cachedReadTokens +
    wire.cachedWriteTokens +
    wire.outputTokens,
);
assert.ok(wire.thoughtTokens <= wire.outputTokens);
assert.equal(detail.usageSummary?.runCount, 1);
const observed = signals
  .filter((event) => event.method === "session/update.usage_update")
  .map((event) => usageUpdate.parse(event.data));
assert.ok(observed.length);
const stored = audit.entries.filter((entry) => entry.kind === "context");
assert.deepEqual(
  stored.map(({ observation }) => ({
    used: observation.usedTokens,
    size: observation.effectiveWindowTokens,
  })),
  observed,
);
assert.equal(run.context?.usedTokens, observed.at(-1)?.used);
assert.equal(run.context?.effectiveWindowTokens, observed.at(-1)?.size);
assert.equal(run.settingsReceipt.modelWindow?.modelId, confirmed.modelId);
assert.ok(run.settingsReceipt.modelWindow?.sourceUrl);
console.log(
  JSON.stringify(
    {
      runId: run.id,
      sessionId: run.sessionId,
      settings: confirmed,
      preEndOutputUpdates: chunks.size,
      publicThoughtReported: Boolean(run.reasoning),
      toolCallId,
      approvalId: allowed.id,
      usage: fields,
      context: observed.at(-1),
      contextObservations: observed.length,
      nominalWindow: run.settingsReceipt.modelWindow,
    },
    null,
    2,
  ),
);
