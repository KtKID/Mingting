import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { createPlatform } from "../src/server/transport/http.js";
import {
  appendReceiptSchema,
  dshCompletionSchema,
  publisherContextKey,
  resultReceiptSchema,
  wakeupResultHeader,
} from "../src/shared/dsh-wakeup.js";
import {
  claimResultSchema,
  deliveryEventSchema,
  detailSchema,
} from "../src/shared/protocol.js";

async function eventStream(response: Response) {
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  return async (name: string): Promise<unknown> => {
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (
          frame.startsWith(`event: ${name}\n`) ||
          frame.includes(`\nevent: ${name}\n`)
        ) {
          const data = frame
            .split("\n")
            .find((line) => line.startsWith("data: "));
          assert.ok(data);
          return JSON.parse(data.slice(6));
        }
        continue;
      }
      const chunk = await reader.read();
      assert.ok(!chunk.done, `missing ${name}`);
      buffer += chunk.value;
    }
  };
}

test(
  "MCP new and append execute four rounds on one task with continuous communication and per-turn wakeups",
  { timeout: 10_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "mingting-turns-"));
    const abort = new AbortController();
    const hostId = randomUUID();
    const token = "a".repeat(64);
    const publisher = { authorization: `Bearer ${token}` };
    const platform = createPlatform({
      dbPath: join(dir, "tasks.sqlite"),
      workspace: dir,
      mode: "fake",
      dshWakeupHost: { hostId, token },
    });
    const server = createServer(platform.app);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const origin = `http://127.0.0.1:${address.port}`;
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(7000)]);
      const post = (path: string, body: unknown, headers?: HeadersInit) =>
        fetch(origin + path, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
          signal,
        });
      async function mcp(method: string, params: unknown) {
        const response = await post(
          "/mcp",
          { jsonrpc: "2.0", id: randomUUID(), method, params },
          {
            ...publisher,
            accept: "application/json, text/event-stream",
          },
        );
        assert.equal(response.status, 200);
        return z.object({ result: z.unknown() }).parse(await response.json())
          .result;
      }
      const { tools } = z
        .object({
          tools: z.array(
            z.object({
              name: z.string(),
              description: z.string().optional(),
              inputSchema: z.object({
                properties: z.record(z.string(), z.unknown()),
              }),
            }),
          ),
        })
        .parse(await mcp("tools/list", {}));
      const publishingTool = tools.find(
        (tool) => tool.name === "mcp-mingting-tool",
      );
      assert.match(
        publishingTool?.description ?? "",
        /同一任务的后续沟通使用 append/,
      );
      assert.ok(publishingTool?.inputSchema.properties.taskId);
      const sessionId = `session-${randomUUID()}`;
      async function publish(
        command: object,
        originTurn: number,
        publishRequestId: string,
        sourceSessionId = sessionId,
      ) {
        return z
          .object({
            isError: z.boolean().optional(),
            structuredContent: z.unknown().optional(),
          })
          .parse(
            await mcp("tools/call", {
              name: "mcp-mingting-tool",
              arguments: command,
              _meta: {
                [publisherContextKey]: {
                  sessionId: sourceSessionId,
                  originTurn,
                  publishRequestId,
                },
              },
            }),
          );
      }
      const wakeups = await eventStream(
        await fetch(origin + "/wakeup-host/events", {
          headers: { ...publisher, [wakeupResultHeader]: "2" },
          signal,
        }),
      );
      assert.deepEqual(await wakeups("ready"), { hostId });
      const ownerId = randomUUID();
      const dispatches = await eventStream(
        await fetch(origin + "/connector/events", {
          headers: { "x-owner-id": ownerId, "x-harness-name": "Codex" },
          signal,
        }),
      );
      const description = [
        "信息采集",
        "生成行程方案",
        "冲突核对与最终计划",
        "补上地铁换乘备注",
      ];
      const created = resultReceiptSchema.parse(
        (
          await publish(
            {
              action: "new",
              title: "杭州周末出行规划",
              description: description[0],
              publisherName: "孔明",
              targetHarness: "Codex",
              approvalTargets: [],
            },
            4,
            "turn-1",
          )
        ).structuredContent,
      );
      const { taskId } = created;
      assert.equal(created.taskTurn, 1);
      const results = await eventStream(
        await fetch(
          origin + `/subscriber/events?taskId=${taskId}&view=result`,
          {
            headers: {
              authorization: `Bearer ${created.resultSubscription.subscriptionToken}`,
            },
            signal,
          },
        ),
      );
      await results("task.status");
      let firstDelivery: number | undefined;
      for (const [index, text] of description.entries()) {
        const taskTurn = index + 1;
        if (index) {
          const command = { action: "append", taskId, description: text };
          const originTurn = index + 4;
          const requestId = `turn-${taskTurn}`;
          const expected = { taskId, taskTurn, taskUrl: created.taskUrl };
          assert.equal(
            (
              await publish(
                command,
                originTurn,
                "other-session",
                `session-${randomUUID()}`,
              )
            ).isError,
            true,
          );
          assert.deepEqual(
            appendReceiptSchema.parse(
              (await publish(command, originTurn, requestId)).structuredContent,
            ),
            expected,
          );
          if (taskTurn === 2) {
            assert.deepEqual(
              appendReceiptSchema.parse(
                (await publish(command, originTurn, requestId))
                  .structuredContent,
              ),
              expected,
            );
            assert.equal(
              (await publish(command, originTurn, "busy")).isError,
              true,
            );
            assert.equal(
              (
                await post("/connector/claim", {
                  taskId,
                  deliveryId: firstDelivery,
                  ownerId,
                  claimId: randomUUID(),
                })
              ).status,
              410,
            );
          }
        }
        const delivery = deliveryEventSchema.parse(
          await dispatches("task.available"),
        );
        assert.equal(delivery.taskId, taskId);
        firstDelivery ??= delivery.id;
        const owner = { ownerId, claimId: randomUUID() };
        const claimed = claimResultSchema.parse(
          await (
            await post("/connector/claim", {
              ...owner,
              taskId,
              deliveryId: delivery.id,
            })
          ).json(),
        );
        assert.equal(claimed.run.taskTurn, taskTurn);
        assert.equal(claimed.task.description, text);
        const runId = claimed.run.id;
        const session = randomUUID();
        const report = (seq: number, update: object) =>
          post(`/connector/runs/${runId}/report`, { ...owner, seq, update });
        assert.equal(
          (await post(`/connector/runs/${runId}/heartbeat`, owner)).status,
          200,
        );
        assert.equal(
          (await report(1, { type: "session", sessionId: session })).status,
          200,
        );
        assert.equal(
          (
            await report(2, {
              type: "notification",
              notification: {
                sessionId: session,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text },
                },
              },
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await report(3, {
              type: "finished",
              status: "succeeded",
              error: null,
              stopReason: "end_turn",
            })
          ).status,
          200,
        );
        const completion = dshCompletionSchema.parse(
          await wakeups("task.completed"),
        );
        assert.equal(completion.taskId, taskId);
        assert.equal(completion.taskTurn, taskTurn);
        assert.equal(completion.originTurn, index + 4);
        assert.equal(completion.sessionId, sessionId);
        assert.equal(completion.result?.output, text);
        assert.equal(
          (
            await post(
              "/wakeup-host/ack",
              { eventId: completion.eventId, sessionId, outcome: "accepted" },
              publisher,
            )
          ).status,
          200,
        );
        const result = z
          .object({ runId: z.uuid(), output: z.string() })
          .parse(await results("task.completed"));
        assert.deepEqual(result, { runId, output: text });
        assert.equal(platform.store.list().length, 1);
      }
      const detail = detailSchema.parse(platform.store.detail(taskId, 0));
      assert.deepEqual(
        detail.turns?.map((turn) => [
          turn.taskTurn,
          turn.source?.publisherSessionId,
          turn.source?.originTurn,
        ]),
        [1, 2, 3, 4].map((turn) => [turn, sessionId, turn + 3]),
      );
      const page = detail.communications;
      assert.ok(page);
      assert.equal(page.lastSeq, page.entries.length);
      assert.deepEqual(
        page.entries.map((entry) => entry.seq),
        page.entries.map((_, index) => index + 1),
      );
      assert.equal(page.entries[0]?.type, "new");
      for (const type of [
        "new.response",
        "task.available",
        "claim",
        "claim.response",
        "heartbeat",
        "heartbeat.response",
        "report",
        "report.response",
        "task.completed",
        "wakeup",
        "wakeup.ack",
        "wakeup.ack.response",
        "append",
        "append.response",
      ]) {
        assert.ok(
          page.entries.some((entry) => entry.type === type),
          type,
        );
      }
      assert.equal(
        page.entries.filter((entry) => entry.type === "wakeup").length,
        4,
      );
      assert.equal(
        page.entries.filter((entry) => entry.type === "task.completed").length,
        4,
      );
      assert.ok(
        !JSON.stringify(page).includes(
          created.resultSubscription.subscriptionToken,
        ),
      );
      assert.throws(
        () =>
          platform.store.transaction(() => {
            platform.store.communication(
              taskId,
              4,
              "publisher",
              "mingting",
              "rollback",
              {},
            );
            throw new Error("roll back");
          }),
        /roll back/,
      );
      assert.equal(
        platform.store.communications(taskId, 1).lastSeq,
        page.lastSeq,
      );
      assert.equal(platform.store.communications(taskId, 1).entries[0]?.seq, 2);
    } finally {
      abort.abort();
      await platform.service.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      platform.store.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
