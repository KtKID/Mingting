import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createPlatform } from "../src/server/http.js";
import { publishTaskSchema } from "../src/shared/protocol.js";
import {
  deepseekTelemetry,
  mapDeepSeekLog,
} from "../src/server/deepseek-acp-mapping.js";
import { grokTelemetry } from "../src/server/grok-acp-mapping.js";
import { zcodeTelemetry } from "../src/server/zcode-acp-mapping.js";

for (const harnessName of ["Grok", "ZCode", "DeepSeek"]) {
  test(`${harnessName} settings, tools and context are recorded under the owned run`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "mingting-harness-audit-"));
    const p = createPlatform({
      dbPath: join(dir, "tasks.sqlite"),
      workspace: dir,
    });
    try {
      const owner = { ownerId: randomUUID(), claimId: randomUUID() };
      const generation = randomUUID();
      const modelId = "model-a";
      p.service.registerHarness(
        { harnessName, ownerId: owner.ownerId },
        generation,
      );
      const task = publishTaskSchema.parse({
        title: "Read",
        description: "Read HELLO.txt",
        publisherName: "Test",
        targetHarness: harnessName,
        requestedSettings: { modelId, reasoningEffort: "high" },
      });
      p.service.reportCapabilities({
        ownerId: owner.ownerId,
        generation,
        capabilities: {
          defaultModelId: modelId,
          source: "acp_session_config",
          models: [
            { id: modelId, name: "A", efforts: [{ id: "high", name: "High" }] },
          ],
        },
      });
      const { taskId } = p.service.publish(task);
      const { run } = p.service.claim(taskId, owner, generation);
      const sessionId = "fresh-session";
      p.service.report(run.id, owner, 1, { type: "session", sessionId });
      assert.throws(
        () =>
          p.service.report(run.id, owner, 2, {
            type: "finished",
            status: "succeeded",
            stopReason: "end_turn",
            error: null,
          }),
        /缺少生效回执/,
      );
      p.service.report(run.id, owner, 2, {
        type: "settings",
        sessionId,
        receipt: {
          status: "applied",
          modelId,
          reasoningEffort: "high",
          confirmedAt: new Date().toISOString(),
          reason: null,
          modelWindow: null,
        },
      });
      p.service.report(run.id, owner, 3, {
        type: "notification",
        notification: {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-1",
            kind: "read",
            title: "Read",
            status: "completed",
          },
        },
      });
      const observation = {
        usedTokens: 25,
        effectiveWindowTokens: 128000,
        source: "acp_usage_update",
      } as const;
      assert.throws(() =>
        p.service.report(run.id, owner, 4, {
          type: "context",
          sessionId: "old",
          observation,
        }),
      );
      p.service.report(run.id, owner, 4, {
        type: "context",
        sessionId,
        observation,
      });
      const { approvalId } = p.service.permission(
        run.id,
        owner,
        "permission-1",
        {
          sessionId,
          toolCall: { toolCallId: "tool-1", title: "Read", kind: "read" },
          options: [{ optionId: "once", name: "Allow", kind: "allow_once" }],
        },
      );
      assert.throws(() =>
        p.service.decide(approvalId, {
          runId: run.id,
          sessionId: "old",
          optionId: "once",
        }),
      );
      p.service.decide(approvalId, {
        runId: run.id,
        sessionId,
        optionId: "once",
      });
      assert.deepEqual(p.service.permissionResult(run.id, owner, approvalId), {
        status: "resolved",
        response: { outcome: { outcome: "selected", optionId: "once" } },
      });
      p.service.report(run.id, owner, 5, {
        type: "finished",
        status: "succeeded",
        stopReason: "end_turn",
        error: null,
      });
      const result = p.store.detail(taskId);
      assert.equal(result?.runs[0]?.settingsReceipt?.modelId, modelId);
      assert.deepEqual(result?.runs[0]?.context, observation);
      assert.deepEqual(
        p.store.runAudit(run.id, 0, 10).map((row) => row.kind),
        ["tool", "context"],
      );
      assert.equal(p.store.approvals(run.id)[0].resolvedBy, "user");
      assert.equal(result?.usageSummary?.coverage, "missing");
    } finally {
      await p.service.close();
      p.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("Grok partitions input and retains independently observed context and cost", () => {
  const result = grokTelemetry.usage(
    {
      _meta: {
        usage: {
          inputTokens: 34638,
          cachedReadTokens: 18816,
          cacheCreationTokens: 0,
          outputTokens: 282,
          reasoningTokens: 222,
          totalTokens: 34920,
          costUsdTicks: 427440000,
        },
      },
    },
    "grok-4.7",
    "s",
    "unknown",
    1,
  )!.usage;
  assert.equal(result.uncachedInputTokens, 15822);
  assert.equal(result.totalTokens, 34920);
  assert.equal(result.coverage, "complete");
  assert.deepEqual(result.cost, { currency: "USD", amount: 0.042744 });
  const notification = {
    sessionId: "s",
    _meta: { totalTokens: 17492 },
    update: {
      sessionUpdate: "agent_message_chunk" as const,
      content: { type: "text" as const, text: "hello" },
    },
  };
  const session = {
    models: {
      availableModels: [
        { modelId: "grok-4.7", _meta: { totalContextTokens: 256000 } },
      ],
    },
  };
  assert.equal(grokTelemetry.modelWindow!("grok-4.7", session)?.tokens, 256000);
  assert.equal(grokTelemetry.modelWindow!("unknown", session), null);
  assert.deepEqual(grokTelemetry.context!(notification, "grok-4.7", session), {
    usedTokens: 17492,
    effectiveWindowTokens: null,
    source: "grok_acp_session_meta",
  });
});

test("ZCode keeps its upstream session and rejects usage from a no-request snapshot", () => {
  const raw = {
    sessionId: "native-s",
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    reasoningTokens: 10,
    cacheReadTokens: 60,
    cacheCreationTokens: 5,
    modelRequestCount: 2,
    modelErrorCount: 0,
  };
  const map = (value: typeof raw) =>
    zcodeTelemetry.usage(
      { _meta: { "mingting.zcode/turnUsage": value } },
      "GLM-5.3",
      "s",
      "3",
      1,
    )!.usage;
  assert.equal(map(raw).uncachedInputTokens, 35);
  assert.equal(map(raw).source.upstreamSessionId, "native-s");
  assert.equal(map({ ...raw, modelRequestCount: 0 }).coverage, "missing");
  assert.equal(map({ ...raw, modelErrorCount: 1 }).coverage, "partial");
  assert.equal(map({ ...raw, totalTokens: 121 }).inconsistent, true);
});

test("DeepSeek uses one complete native turn and counts each committed step once", () => {
  const missing = deepseekTelemetry().usage(
    { stopReason: "end_turn" },
    "v4-flash",
    "ds-session",
    "0.0.1",
    1,
  )!.usage;
  const header = {
    type: "session",
    version: 4,
    id: "ds-session",
    cwd: "/work",
    isSeeded: false,
    delegationDepth: 0,
  };
  const usage = {
    inputTokens: 15,
    outputTokens: 8,
    totalTokens: 44,
    cacheReadTokens: 21,
    cacheWriteTokens: 0,
    reasoningTokens: 2,
  };
  const turn = [
    { type: "turn/start", data: { turn: 1 } },
    ...[1, 2].flatMap((step) => [
      { type: "step/start", data: { turn: 1, step } },
      {
        type: "assistant/message",
        data: { turn: 1, step, usage, stream: [{ chunk: { usage } }] },
      },
      { type: "step/end", data: { turn: 1, step } },
    ]),
    { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
  ];
  const map = (events = turn, session = header) =>
    mapDeepSeekLog(
      [session, ...events.map((item, seq) => ({ ...item, seq }))]
        .map((item) => JSON.stringify(item))
        .join("\n"),
      missing,
      "/work",
    );
  assert.equal(missing.coverage, "missing");
  assert.equal(map()?.usage.totalTokens, 88);
  assert.equal(map()?.usage.cachedReadTokens, 42);
  assert.equal(map()?.usage.coverage, "complete");
  assert.equal(map()?.usage.source.method, "dsh/session-log");
  assert.equal(map(turn.slice(0, -1)), undefined);
  assert.equal(map(turn, { ...header, id: "other-session" }), undefined);
  assert.equal(
    map([...turn.slice(0, 2), turn[2], ...turn.slice(2)]),
    undefined,
  );
  assert.equal(
    map([
      ...turn.slice(0, 2),
      { type: "llm/retry", data: { turn: 1, step: 1 } },
      ...turn.slice(2),
    ]),
    undefined,
  );
});
