import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createPlatform } from "../src/server/http.js";
import { dshPublishSchema } from "../src/shared/dsh-wakeup.js";
import { browserSnapshotSchema } from "../src/shared/protocol.js";

test("the DSH contract keeps accepting existing bare UUID session IDs", () => {
  const sessionId = randomUUID();
  const input = dshPublishSchema.parse({
    title: "Existing chat",
    description: "Reply yes",
    publisherName: "DSH",
    sessionId,
    originTurn: 1,
    publishRequestId: "existing-call",
  });
  assert.equal(input.sessionId, sessionId);
});

test(
  "authenticated DSH publishes once, keeps webpage approvals, and replays the exact completion until the correct session acknowledges it",
  { timeout: 10_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "mingting-dsh-"));
    const token = randomBytes(32).toString("hex");
    const hostId = randomUUID();
    const platform = createPlatform({
      dbPath: join(dir, "tasks.sqlite"),
      workspace: dir,
      mode: "fake",
      dshWakeupHost: { hostId, token },
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
      assert.equal((await post("publish", input)).status, 503);
      assert.equal(platform.store.list().length, 0);
      const first = await connect();
      assert.deepEqual(await first.read("ready"), { hostId });
      assert.equal((await post("publish", { ...input, hostId })).status, 400);
      assert.equal(
        (await post("publish", { ...input, sessionId: "" })).status,
        400,
      );
      assert.equal(platform.store.list().length, 0);
      const published = await post("publish", input);
      assert.equal(published.status, 201);
      const { taskId } = await published.json();
      const retry = await post("publish", input);
      assert.equal(retry.status, 200);
      assert.deepEqual(await retry.json(), { taskId });
      assert.equal(
        (await post("publish", { ...input, description: "changed" })).status,
        409,
      );
      assert.equal(platform.store.list().length, 1);
      assert.deepEqual(platform.store.task(taskId)?.approvalTargets, []);

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
        originTurn: input.originTurn,
      };
      const completed = await first.read("task.completed");
      assert.deepEqual(
        { ...completed, completedAt: undefined },
        { ...event, completedAt: undefined },
      );
      await first.close();
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
  "standard MCP issues a recoverable result receipt and binds the configured session",
  { timeout: 10_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "mingting-mcp-result-"));
    const token = randomBytes(32).toString("hex");
    const hostId = randomUUID();
    const platform = createPlatform({
      dbPath: join(dir, "tasks.sqlite"),
      workspace: dir,
      mode: "fake",
      dshWakeupHost: { hostId, token },
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
      const source = `session-${randomUUID()}`;
      const target = randomUUID();
      const context = {
        sessionId: source,
        originTurn: 3,
        targetSessionId: target,
        publishRequestId: "mcp-call",
      };
      const args = {
        title: "Write test file",
        description: "Write one line",
        publisherName: "KMH",
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
        headers: { ...hostHeaders, "x-mingting-wakeup-result": "1" },
        signal,
      });
      assert.equal(stream.status, 200);
      assert.ok(stream.body);
      const hostReader = stream.body
        .pipeThrough(new TextDecoderStream())
        .getReader();
      assert.match((await hostReader.read()).value ?? "", /event: ready/);
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
        originTurn: 3,
        publisherSessionId: source,
      });
      assert.equal(receipt.approvalSubscription, undefined);
      assert.deepEqual((await publish(hostHeaders)).structuredContent, receipt);
      assert.equal((await publish(hostHeaders, "different")).isError, true);
      assert.equal(platform.store.list().length, 1);

      const owner = { ownerId: randomUUID(), claimId: randomUUID() };
      const { run } = platform.service.claim(receipt.taskId, owner);
      platform.service.report(run.id, owner, 1, {
        type: "session",
        sessionId: "executor",
      });
      platform.service.report(run.id, owner, 2, {
        type: "notification",
        notification: {
          sessionId: "executor",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "实际结果" },
          },
        },
      });
      platform.service.report(run.id, owner, 3, {
        type: "finished",
        status: "succeeded",
        stopReason: "end_turn",
        error: null,
      });
      const hostFrame = (await hostReader.read()).value ?? "";
      assert.match(hostFrame, new RegExp(target));
      assert.match(hostFrame, /实际结果/);
      const eventId = `task.completed:${run.id}`;
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
      const snapshotFrame = (await browserReader.read()).value ?? "";
      await browserReader.cancel();
      const payload = /^data: (.+)$/m.exec(snapshotFrame)?.[1];
      assert.ok(payload);
      const snapshot = browserSnapshotSchema.parse(JSON.parse(payload));
      assert.deepEqual(snapshot.detail?.wakeup, {
        target: { sessionId: target, originTurn: 3 },
        events: [{ id: eventId, type: "task.completed", status: "delivered" }],
      });

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
        while (!frames.includes("实际结果")) {
          const next = await reader.read();
          assert.ok(!next.done);
          frames += next.value;
        }
        assert.match(frames, /event: task.status/);
        assert.match(frames, new RegExp(`id: task.completed:${run.id}`));
        assert.match(frames, /"status":"succeeded"/);
        await reader.cancel();
      }
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
