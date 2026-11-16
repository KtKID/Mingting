import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createPlatform } from "../src/server/transport/http.js";
import {
  configuredWakeupHosts,
  hostWakeupRouter,
} from "../src/server/transport/host-wakeup.js";
import {
  hostCompletionSchema,
  hostPublisherContextSchema,
} from "../src/shared/host-wakeup.js";
import { browserSnapshotSchema } from "../src/shared/protocol.js";

async function readSseFrame(reader: ReadableStreamDefaultReader<string>) {
  let buffer = "";
  while (!buffer.includes("\n\n")) {
    const part = await reader.read();
    assert.ok(!part.done);
    buffer += part.value;
  }
  return buffer.slice(0, buffer.indexOf("\n\n"));
}

test("the host contract accepts bare UUID session IDs and native turn references", () => {
  const sessionId = randomUUID();
  const input = hostPublisherContextSchema.parse({
    sessionId,
    originTurn: "turn-native",
    publishRequestId: "existing-call",
  });
  assert.equal(input.sessionId, sessionId);
  assert.equal(input.originTurn, "turn-native");
});

test("platform rejects an invalid wakeup result text limit at startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mingting-config-"));
  const configPath = join(dir, "config.yaml");
  try {
    for (const value of ["0", "-5", "1.5", '"5000"']) {
      await writeFile(
        configPath,
        `tasks:\n  wakeupResultTextLimit: ${value}\n`,
      );
      assert.throws(
        () =>
          createPlatform({ dbPath: ":memory:", workspace: dir, configPath }),
        /无法读取明庭配置.*config\.yaml[\s\S]*wakeupResultTextLimit/,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("host configuration loads separate tokens and rejects ambiguous credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mingting-wakeup-config-"));
  const platform = createPlatform({
    dbPath: join(dir, "tasks.sqlite"),
    workspace: dir,
  });
  try {
    assert.deepEqual(configuredWakeupHosts({}), []);
    const file = join(dir, "hosts.json");
    const hosts = Array.from({ length: 2 }, () => ({
      hostId: randomUUID(),
      token: randomBytes(32).toString("hex"),
    }));
    await Promise.all([
      ...hosts.map((host) =>
        writeFile(join(dir, host.hostId), host.token + "\n", { mode: 0o600 }),
      ),
      writeFile(
        file,
        JSON.stringify(
          hosts.map(({ hostId }) => ({ hostId, tokenFile: hostId })),
        ),
      ),
    ]);
    assert.deepEqual(
      configuredWakeupHosts({ MINGTING_WAKEUP_HOSTS_FILE: file }),
      hosts,
    );
    assert.throws(
      () =>
        hostWakeupRouter(
          platform.service,
          [hosts[0], { ...hosts[1], token: hosts[0].token }],
          5,
        ),
      /必须各自唯一/,
    );
    assert.throws(
      () =>
        hostWakeupRouter(
          platform.service,
          [hosts[0], { ...hosts[1], hostId: hosts[0].hostId }],
          5,
        ),
      /必须各自唯一/,
    );
  } finally {
    await platform.service.close();
    platform.store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "retired DSH publishing cannot create tasks and accepted legacy tasks still deliver and replay completion",
  { timeout: 10_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "mingting-wakeup-host-"));
    const token = randomBytes(32).toString("hex");
    const hostId = randomUUID();
    const configPath = join(dir, "config.yaml");
    await writeFile(configPath, "tasks:\n  wakeupResultTextLimit: 3\n");
    const dbPath = join(dir, "tasks.sqlite");
    const platform = createPlatform({
      dbPath,
      workspace: dir,
      mode: "fake",
      wakeupHosts: [{ hostId, token }],
      configPath,
    });
    const server = createServer(platform.app);
    const signal = AbortSignal.timeout(7_500);
    const readers = new Set<ReadableStreamDefaultReader<string>>();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const base = `http://127.0.0.1:${address.port}`;
      const headers = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      };
      const post = (path: string, data: object) =>
        fetch(base + "/wakeup-host/" + path, {
          method: "POST",
          headers,
          body: JSON.stringify(data),
          signal,
        });
      const connect = async () => {
        const stream = () =>
          fetch(base + "/wakeup-host/events", {
            headers,
            signal,
          });
        let response = await stream();
        while (response.status === 409) {
          await response.body?.cancel();
          await delay(25, undefined, { signal });
          response = await stream();
        }
        assert.equal(response.status, 200);
        assert.ok(response.body);
        const reader = response.body
          .pipeThrough(new TextDecoderStream())
          .getReader();
        readers.add(reader);
        let buffer = "";
        return {
          async read(name: string) {
            for (;;) {
              const end = buffer.indexOf("\n\n");
              if (end >= 0) {
                const frame = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                if (frame.startsWith(`event: ${name}\ndata: `))
                  return JSON.parse(frame.slice(frame.indexOf("\ndata: ") + 7));
                continue;
              }
              const part = await reader.read();
              assert.ok(!part.done, `expected ${name} frame`);
              buffer += part.value;
            }
          },
          close: () => reader.cancel(),
        };
      };
      assert.equal(
        (await fetch(base + "/wakeup-host/events", { signal })).status,
        401,
      );
      const input = {
        title: "Read a fixture",
        description: "Read HELLO.txt",
        publisherName: "DSH",
        sessionId: "session-134db72b-dd0e-4779-9a7b-00ba74aced55",
        originTurn: 7,
        publishRequestId: "call-a",
      };
      assert.equal((await post("publish", input)).status, 404);
      assert.equal(platform.store.list().length, 0);
      const first = await connect();
      assert.deepEqual(await first.read("ready"), { hostId });
      assert.equal((await post("publish", input)).status, 404);
      assert.equal(platform.store.list().length, 0);
      const { sessionId, originTurn, publishRequestId, ...taskInput } = input;
      const taskId = platform.store.transaction(() => {
        const task = platform.store.publish(
          { ...taskInput, approvalTargets: [] },
          {
            wakeupTarget: { hostId, sessionId },
            source: { hostId, publisherSessionId: sessionId, originTurn },
          },
        );
        // 还原退役发布路径遗留的 queued 状态，模拟无执行者的历史任务。
        task.status = "queued";
        platform.store.saveTask(task);
        platform.store.recordHostPublication(
          hostId,
          publishRequestId,
          "legacy-fingerprint",
          task.id,
        );
        platform.store.deliver(task.id);
        return task.id;
      });
      assert.equal(platform.store.list().length, 1);
      assert.deepEqual(platform.store.task(taskId)?.approvalTargets, []);
      const legacy = new DatabaseSync(dbPath);
      try {
        legacy
          .prepare(
            "UPDATE task_turns SET data=json_set(data,'$.wakeupTarget.originTurn',?,'$.wakeupTarget.publisherSessionId',?) WHERE task_id=?",
          )
          .run(originTurn, sessionId, taskId);
      } finally {
        legacy.close();
      }

      const owner = { ownerId: randomUUID(), claimId: randomUUID() };
      const { run } = platform.service.claim(taskId, owner);
      platform.service.report(run.id, owner, 1, {
        type: "session",
        sessionId: "executor",
      });
      platform.service.permission(run.id, owner, "read", {
        sessionId: "executor",
        toolCall: { toolCallId: "fixture", title: "Read fixture" },
        options: [{ optionId: "once", name: "Allow", kind: "allow_once" }],
      });
      const approval = platform.store.detail(taskId)?.approvals[0];
      assert.ok(approval);
      const bootstrap = await fetch(base + "/api/bootstrap", { signal });
      const { csrf } = await bootstrap.json();
      const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
      assert.ok(cookie);
      const decision = await fetch(
        base + "/api/approvals/" + approval.id + "/decision",
        {
          method: "POST",
          signal,
          headers: {
            cookie,
            origin: base,
            "content-type": "application/json",
            "x-csrf-token": csrf,
          },
          body: JSON.stringify({
            optionId: "once",
            runId: run.id,
            sessionId: "executor",
          }),
        },
      );
      assert.equal(decision.status, 200);
      platform.service.report(run.id, owner, 2, {
        type: "notification",
        notification: {
          sessionId: "executor",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "完整结果" },
          },
        },
      });
      platform.service.report(run.id, owner, 3, {
        type: "finished",
        status: "succeeded",
        stopReason: "end_turn",
        error: null,
      });
      const event = {
        eventId: `task.completed:${run.id}`,
        taskId,
        runId: run.id,
        sessionId: input.sessionId,
      };
      const completed = hostCompletionSchema.parse(
        await first.read("task.completed"),
      );
      assert.deepEqual(
        { ...completed, completedAt: undefined },
        {
          ...event,
          completedAt: undefined,
          taskTurn: 1,
          result: {
            status: "succeeded",
            output: "完整结",
            error: null,
            truncated: true,
          },
        },
      );
      await first.close();
      const legacyEvent = new DatabaseSync(dbPath);
      try {
        legacyEvent
          .prepare(
            "UPDATE task_wakeup_events SET data=json_set(data,'$.target.originTurn',?,'$.target.publisherSessionId',?) WHERE id=?",
          )
          .run(originTurn, sessionId, event.eventId);
      } finally {
        legacyEvent.close();
      }
      const second = await connect();
      assert.deepEqual(await second.read("task.completed"), completed);
      assert.equal(
        (
          await post("ack", {
            eventId: event.eventId,
            sessionId: input.sessionId.slice("session-".length),
            outcome: "accepted",
          })
        ).status,
        404,
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        const ack = await post("ack", {
          eventId: event.eventId,
          sessionId: input.sessionId,
          outcome: "accepted",
        });
        assert.equal(ack.status, 200);
        assert.deepEqual(await ack.json(), { ok: true });
      }
      assert.equal(platform.store.task(taskId)?.status, "succeeded");
      assert.equal(
        platform.store.detail(taskId)?.approvals[0]?.status,
        "decided",
      );
    } finally {
      await Promise.allSettled([...readers].map((reader) => reader.cancel()));
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

test(
  "standard MCP binds the configured session and isolates concurrent wakeup hosts",
  { timeout: 10_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "mingting-mcp-result-"));
    const token = randomBytes(32).toString("hex");
    const hostId = randomUUID();
    const otherHost = {
      hostId: randomUUID(),
      token: randomBytes(32).toString("hex"),
    };
    const platform = createPlatform({
      dbPath: join(dir, "tasks.sqlite"),
      workspace: dir,
      mode: "fake",
      wakeupHosts: [{ hostId, token }, otherHost],
    });
    const server = createServer(platform.app);
    const stop = new AbortController();
    const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(8_000)]);
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const base = `http://127.0.0.1:${address.port}`;
      const hostHeaders = { authorization: `Bearer ${token}` };
      const otherHeaders = { authorization: `Bearer ${otherHost.token}` };
      const source = `session-${randomUUID()}`;
      const target = randomUUID();
      const context = {
        sessionId: source,
        originTurn: "turn-3",
        targetSessionId: target,
        publishRequestId: "mcp-call",
      };
      const args = {
        title: "Write test file",
        description: "Write one line",
        publisherName: "宿主",
        targetHarness: "Codex",
        approvalTargets: [],
      };
      const publish = async (
        headers: Record<string, string>,
        description = args.description,
        meta: object = context,
      ) => {
        const response = await fetch(base + "/mcp", {
          method: "POST",
          signal,
          headers: {
            ...headers,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "mcp-mingting-tool",
              arguments: { ...args, description },
              _meta: { "mingting.local/publisher-context": meta },
            },
          }),
        });
        assert.equal(response.status, 200);
        const { result } = await response.json();
        return result;
      };
      assert.equal((await publish({})).isError, true);
      assert.equal((await publish(hostHeaders)).isError, true);
      assert.equal(platform.store.list().length, 0);
      const stream = await fetch(base + "/wakeup-host/events", {
        headers: hostHeaders,
        signal,
      });
      assert.equal(stream.status, 200);
      assert.ok(stream.body);
      const hostReader = stream.body
        .pipeThrough(new TextDecoderStream())
        .getReader();
      assert.match((await hostReader.read()).value ?? "", /event: ready/);
      assert.equal((await publish(otherHeaders)).isError, true);
      const otherStream = await fetch(base + "/wakeup-host/events", {
        headers: otherHeaders,
        signal,
      });
      assert.equal(otherStream.status, 200);
      assert.ok(otherStream.body);
      const otherReader = otherStream.body
        .pipeThrough(new TextDecoderStream())
        .getReader();
      assert.match(
        await readSseFrame(otherReader),
        new RegExp(otherHost.hostId),
      );
      const duplicate = await fetch(base + "/wakeup-host/events", {
        headers: hostHeaders,
        signal,
      });
      assert.equal(duplicate.status, 409);
      await duplicate.body?.cancel();
      assert.equal(
        (
          await publish(hostHeaders, args.description, {
            ...context,
            originTurn: 0,
          })
        ).isError,
        true,
      );
      const { structuredContent: receipt } = await publish(hostHeaders);
      assert.ok(receipt.resultSubscription.subscriptionToken);
      assert.equal(receipt.taskUrl, base + "/?task=" + receipt.taskId);
      assert.deepEqual(receipt.wakeupTarget, {
        hostId,
        sessionId: target,
      });
      assert.equal(receipt.approvalSubscription, undefined);
      assert.deepEqual((await publish(hostHeaders)).structuredContent, receipt);
      assert.equal((await publish(hostHeaders, "different")).isError, true);
      assert.equal(platform.store.list().length, 1);

      const owner = { ownerId: randomUUID(), claimId: randomUUID() };
      platform.service.registerHarness({
        ownerId: owner.ownerId,
        harnessName: "Codex",
      });
      const { run } = platform.service.claim(receipt.taskId, owner);
      platform.service.report(run.id, owner, 1, {
        type: "session",
        sessionId: "executor",
      });
      const preview = "实".repeat(5000);
      const output = preview + "完整结果的尾部";
      platform.service.report(run.id, owner, 2, {
        type: "notification",
        notification: {
          sessionId: "executor",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: output },
          },
        },
      });
      platform.service.report(run.id, owner, 3, {
        type: "finished",
        status: "succeeded",
        stopReason: "end_turn",
        error: null,
      });
      const readCompletion = async (reader = hostReader) => {
        const frame = await readSseFrame(reader);
        const payload = /^data: (.+)$/m.exec(frame)?.[1];
        assert.ok(payload);
        return {
          frame,
          completion: hostCompletionSchema.parse(JSON.parse(payload)),
        };
      };
      const { completion } = await readCompletion();
      assert.equal(completion.sessionId, target);
      assert.deepEqual(completion.result, {
        status: "succeeded",
        output: preview,
        error: null,
        truncated: true,
      });
      const eventId = `task.completed:${run.id}`;
      const rejectedAck = await fetch(base + "/wakeup-host/ack", {
        method: "POST",
        signal,
        headers: { ...otherHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          eventId,
          sessionId: target,
          outcome: "accepted",
        }),
      });
      assert.equal(rejectedAck.status, 404);
      await rejectedAck.body?.cancel();
      const ack = await fetch(base + "/wakeup-host/ack", {
        method: "POST",
        signal,
        headers: { ...hostHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          eventId,
          sessionId: target,
          outcome: "accepted",
        }),
      });
      assert.equal(ack.status, 200);
      const bootstrap = await fetch(base + "/api/bootstrap", { signal });
      const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
      assert.ok(cookie);
      const browser = await fetch(
        base + "/api/events?taskId=" + receipt.taskId,
        {
          signal,
          headers: { cookie },
        },
      );
      assert.ok(browser.body);
      const browserReader = browser.body
        .pipeThrough(new TextDecoderStream())
        .getReader();
      const snapshotFrame = await readSseFrame(browserReader);
      await browserReader.cancel();
      const payload = /^data: (.+)$/m.exec(snapshotFrame)?.[1];
      assert.ok(payload);
      const snapshot = browserSnapshotSchema.parse(JSON.parse(payload));
      assert.deepEqual(snapshot.detail?.wakeup, {
        target: { sessionId: target, originTurn: "turn-3" },
        events: [{ id: eventId, type: "task.completed", status: "delivered" }],
      });
      assert.equal(
        snapshot.detail?.runs.find((item) => item.id === run.id)?.output,
        output,
      );

      const subscribe = (subscriptionToken: string, view = "&view=result") =>
        fetch(base + "/subscriber/events?taskId=" + receipt.taskId + view, {
          signal,
          headers: { authorization: `Bearer ${subscriptionToken}` },
        });
      const resultToken = receipt.resultSubscription.subscriptionToken;
      assert.equal((await subscribe(token)).status, 403);
      assert.equal((await subscribe(resultToken, "")).status, 403);
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await subscribe(resultToken);
        assert.equal(result.status, 200);
        assert.ok(result.body);
        const reader = result.body
          .pipeThrough(new TextDecoderStream())
          .getReader();
        let frames = "";
        while (!frames.includes(output)) {
          const next = await reader.read();
          assert.ok(!next.done);
          frames += next.value;
        }
        assert.match(frames, /event: task.status/);
        assert.match(frames, new RegExp(`id: task.completed:${run.id}`));
        assert.match(frames, /"status":"succeeded"/);
        await reader.cancel();
      }

      // 两个宿主可使用相同的会话和请求 ID，任务与投递仍按宿主隔离。
      const { structuredContent: escapedReceipt } = await publish(otherHeaders);
      assert.notEqual(escapedReceipt.taskId, receipt.taskId);
      assert.deepEqual(escapedReceipt.wakeupTarget, {
        hostId: otherHost.hostId,
        sessionId: target,
      });
      const escapedRun = platform.service.claim(
        escapedReceipt.taskId,
        owner,
      ).run;
      platform.service.report(escapedRun.id, owner, 1, {
        type: "session",
        sessionId: "executor",
      });
      const escapedOutput = "\u001b".repeat(5000);
      platform.service.report(escapedRun.id, owner, 2, {
        type: "notification",
        notification: {
          sessionId: "executor",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: escapedOutput },
          },
        },
      });
      platform.service.report(escapedRun.id, owner, 3, {
        type: "finished",
        status: "failed",
        stopReason: null,
        error: "\u001b".repeat(2000),
      });
      const escaped = await readCompletion(otherReader);
      assert.equal(escaped.completion.taskId, escapedReceipt.taskId);
      assert.equal(escaped.completion.runId, escapedRun.id);
      assert.ok(escaped.frame.length + 2 <= 16_384);
      assert.equal(escaped.completion.result?.truncated, true);
      assert.ok(escaped.completion.result?.output.length);
      assert.ok(escaped.completion.result?.error?.length);
      assert.equal(platform.store.run(escapedRun.id)?.output, escapedOutput);
      const unavailable = await fetch(base + "/wakeup-host/ack", {
        method: "POST",
        signal,
        headers: { ...otherHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          eventId: escaped.completion.eventId,
          sessionId: target,
          outcome: "rejected",
          reason: "session-unavailable",
        }),
      });
      assert.equal(unavailable.status, 200);
      assert.equal(
        platform.store.hostWakeup(escaped.completion.eventId, otherHost.hostId)
          ?.error,
        "session-unavailable",
      );
      await otherReader.cancel();
      await hostReader.cancel();
    } finally {
      stop.abort();
      await platform.service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      platform.store.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
