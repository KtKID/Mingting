import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { TaskConnector } from "../src/connector/connector.js";
import { AcpAdapter, type AdapterConfig } from "../src/server/acp-adapter.js";
import { CodexAdapter } from "../src/server/codex-adapter.js";
import { deepseekTelemetry } from "../src/server/deepseek-acp-mapping.js";
import { grokTelemetry } from "../src/server/grok-acp-mapping.js";
import { createPlatform } from "../src/server/http.js";
import { zcodeTelemetry } from "../src/server/zcode-acp-mapping.js";
import {
  auditPageSchema,
  bootstrapSchema,
  detailSchema,
  publishResultSchema,
  usageCountsSchema,
} from "../src/shared/protocol.js";
import { acpRunRecordings } from "./fixtures/acp-run-recording.js";

async function waitFor<T>(read: () => T | undefined, label: string) {
  const deadline = Date.now() + 10_000;
  do {
    const value = read();
    if (value !== undefined) return value;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for " + label);
}

for (const data of acpRunRecordings) {
  test(`offline ACP recording · ${data.id}`, async () => {
    const dir = await realpath(
      await mkdtemp(join(tmpdir(), "mingting-acp-replay-")),
    );
    const platform = createPlatform({
      dbPath: join(dir, "tasks.sqlite"),
      workspace: dir,
      mode: "fake",
    });
    const server = createServer(platform.app);
    const config: AdapterConfig = {
      command: process.execPath,
      args: [
        "--import",
        import.meta.resolve("tsx"),
        fileURLToPath(new URL("fixtures/acp-run-replay.ts", import.meta.url)),
        data.id,
      ],
      env: {},
      workspace: dir,
      mode: "fake",
      harnessName: data.harness,
      sessionMode:
        data.harness === "Codex"
          ? "workspace-write"
          : data.harness === "ZCode"
            ? "plan"
            : null,
    };
    const adapter =
      data.harness === "Codex"
        ? new CodexAdapter(config)
        : new AcpAdapter({
            ...config,
            telemetry: {
              Grok: grokTelemetry,
              ZCode: zcodeTelemetry,
              DeepSeek: deepseekTelemetry(dir, dir),
            }[data.harness],
          });
    let connector: TaskConnector | undefined;
    try {
      await new Promise<void>((resolve, reject) =>
        server.once("error", reject).listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const base = `http://127.0.0.1:${address.port}`;
      connector = new TaskConnector(base, adapter, undefined, data.harness);
      connector.start();
      await waitFor(
        () =>
          platform.service
            .harnesses()
            .find(
              (h) =>
                h.harnessName === data.harness &&
                h.capabilities?.models.some(
                  (m) => m.id === data.settings.modelId,
                ),
            ),
        "model discovery",
      );
      const bootstrap = await fetch(base + "/api/bootstrap");
      const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
      assert.ok(cookie);
      const { csrf } = bootstrapSchema.parse(await bootstrap.json());
      const api = async (path: string, body?: unknown) => {
        const response = await fetch(base + "/api" + path, {
          headers: {
            cookie,
            origin: base,
            "x-csrf-token": csrf,
            "content-type": "application/json",
          },
          ...(body === undefined
            ? {}
            : { method: "POST", body: JSON.stringify(body) }),
        });
        assert.ok(response.ok, `${path} returned ${response.status}`);
        return response.json();
      };
      const { taskId } = publishResultSchema.parse(
        await api("/tasks", {
          title: "Recorded ACP read",
          description: "Replay recorded output and tool events",
          publisherName: "Offline test",
          targetHarness: data.harness,
          requestedSettings: data.settings,
          approvalTargets: [],
        }),
      );
      const streamed = new Set<string>();
      platform.service.events.on("changed", () => {
        const run = platform.store.detail(taskId)?.runs[0];
        if (run?.output && !run.endedAt) streamed.add(run.output);
      });
      const expectedApprovals = data.frames.filter(
        (frame) => "permission" in frame,
      );
      for (const frame of expectedApprovals) {
        const approval = await waitFor(
          () =>
            platform.store
              .detail(taskId)
              ?.approvals.find((item) => item.status === "pending"),
          "recorded permission",
        );
        assert.deepEqual(approval.request.options, frame.permission.options);
        assert.equal(
          approval.request.toolCall.toolCallId,
          frame.permission.toolCall.toolCallId,
        );
        await api(`/approvals/${approval.id}/decision`, {
          runId: approval.runId,
          sessionId: approval.sessionId,
          optionId: frame.expectedOption,
        });
      }
      const run = await waitFor(() => {
        const value = platform.store.detail(taskId)?.runs[0];
        return value?.endedAt ? value : undefined;
      }, "terminal run");
      assert.equal(run.status, "succeeded", run.error ?? "Replay failed");
      assert.equal(run.stopReason, "end_turn");
      assert.equal(run.harnessName, data.harness);
      assert.ok(run.sessionId);
      assert.ok(
        [...streamed].some(
          (text) => text !== run.output && run.output.startsWith(text),
        ),
      );
      assert.equal(run.output, data.expected.output);
      assert.equal(run.reasoning, data.expected.reasoning);
      assert.equal(run.settingsReceipt?.status, "applied");
      assert.equal(run.settingsReceipt.modelId, data.settings.modelId);
      assert.equal(
        run.settingsReceipt.reasoningEffort,
        data.settings.reasoningEffort,
      );
      assert.equal(
        run.settingsReceipt.modelWindow?.tokens ?? null,
        data.catalogWindow,
      );
      assert.deepEqual(run.context, data.expected.context);
      assert.ok(run.usage);
      const { source, scope, basis, modelId, ...usage } = run.usage;
      assert.equal(scope, "primary_prompt");
      assert.equal(basis, "token_breakdown_v1");
      assert.equal(modelId, data.settings.modelId);
      assert.equal(source.sessionId, run.sessionId);
      assert.equal(source.method, data.expected.usageMethod);
      assert.equal(source.adapterVersion, data.adapterVersion);
      assert.deepEqual(usage, data.expected.usage);
      if (data.harness === "ZCode")
        assert.equal(source.upstreamSessionId, "replay-native-zcode");

      const detail = detailSchema.parse(await api(`/tasks/${taskId}`));
      assert.equal(detail.usageSummary?.runCount, 1);
      assert.equal(detail.usageSummary.coverage, usage.coverage);
      assert.deepEqual(
        usageCountsSchema.parse(detail.usageSummary),
        usageCountsSchema.parse(usage),
      );
      const audit = auditPageSchema.parse(
        await api(`/tasks/${taskId}/runs/${run.id}/audit`),
      );
      assert.equal(audit.runId, run.id);
      assert.ok(
        audit.entries.every(
          (entry) =>
            entry.runId === run.id && entry.sessionId === run.sessionId,
        ),
      );
      assert.equal(
        audit.entries.length,
        data.frames.filter(
          (frame) =>
            "update" in frame &&
            (frame.update.sessionUpdate.startsWith("tool_call") ||
              frame.update.sessionUpdate === "usage_update" ||
              frame._meta?.totalTokens !== undefined),
        ).length,
      );
      const completed = audit.entries.flatMap((entry) =>
        entry.kind === "tool" && entry.patch.status === "completed"
          ? [entry.toolCallId]
          : [],
      );
      assert.ok(completed.length > 0);
      assert.deepEqual(
        audit.approvals.map((a) => a.optionId),
        expectedApprovals.map((a) => a.expectedOption),
      );
      for (const approval of audit.approvals) {
        assert.equal(approval.runId, run.id);
        assert.equal(approval.sessionId, run.sessionId);
        assert.equal(approval.resolvedBy, "user");
        assert.ok(completed.includes(approval.request.toolCall.toolCallId));
      }
    } finally {
      await platform.service.close();
      await connector?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      platform.store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
