import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createPlatform } from "../src/server/http.js";
import { publishTaskSchema } from "../src/shared/protocol.js";
import { grokTelemetry } from "../src/server/grok-acp-mapping.js";

for (const harnessName of ["Grok"]) {
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
