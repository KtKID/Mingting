import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createPlatform } from "../src/server/http.js";
import { detailSchema } from "../src/shared/protocol.js";

test("A2 process projection persists thoughts and merges tool patches; duplicate and stale reports are fenced", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mingting-stream-"));
  const p = createPlatform({
    dbPath: join(dir, "tasks.sqlite"),
    workspace: dir,
  });
  try {
    const { taskId } = p.service.publish({
      title: "问候",
      description: "hi",
      publisherName: "test",
    });
    const owner = { ownerId: randomUUID(), claimId: randomUUID() };
    const { run } = p.service.claim(taskId, owner);
    let seq = 1;
    p.service.report(run.id, owner, seq++, { type: "session", sessionId: "s" });
    const report = (
      update: Parameters<typeof p.service.report>[3] & { type: "notification" },
    ) => p.service.report(run.id, owner, seq++, update);
    report({
      type: "notification",
      notification: {
        sessionId: "s",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "先读问候" },
        },
      },
    });
    report({
      type: "notification",
      notification: {
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "t",
          title: "读取 HELLO.txt",
          kind: "read",
          status: "pending",
          rawInput: { path: "HELLO.txt" },
        },
      },
    });
    report({
      type: "notification",
      notification: {
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "t",
          status: "in_progress",
        },
      },
    });
    report({
      type: "notification",
      notification: {
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "t",
          status: "completed",
          rawOutput: "你好",
        },
      },
    });
    const message = {
      type: "notification" as const,
      notification: {
        sessionId: "s",
        update: {
          sessionUpdate: "agent_message_chunk" as const,
          content: { type: "text" as const, text: "你好" },
        },
      },
    };
    const messageSeq = seq;
    report(message);
    assert.equal(
      p.service.report(run.id, owner, messageSeq, message).duplicate,
      true,
    );
    const actual = detailSchema.parse(p.store.detail(taskId));
    assert.equal(actual.runs[0]?.output, "你好");
    assert.equal(Reflect.get(actual.runs[0]!, "reasoning"), "先读问候");
    assert.deepEqual(Reflect.get(actual.runs[0]!, "tools"), [
      {
        id: "t",
        title: "读取 HELLO.txt",
        kind: "read",
        status: "completed",
        input: '{\n  "path": "HELLO.txt"\n}',
        output: "你好",
      },
    ]);
    p.service.cancel(taskId);
    report(message);
    assert.equal(p.store.run(run.id)?.output, "你好");
    assert.throws(() =>
      report({
        ...message,
        notification: { ...message.notification, sessionId: "old" },
      }),
    );
  } finally {
    await p.service.close();
    p.store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("A3 browser SSE requires a local cookie and delivers pre-finish snapshots and reconnect state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mingting-sse-"));
  const p = createPlatform({
    dbPath: join(dir, "tasks.sqlite"),
    workspace: dir,
  });
  const server = createServer(p.app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const controllers: AbortController[] = [];
  try {
    assert.equal((await fetch(base + "/api/events")).status, 403);
    const bootstrap = await fetch(base + "/api/bootstrap");
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
    assert.equal(
      (
        await fetch(base + "/api/events", {
          headers: { cookie, origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    const { taskId } = p.service.publish({
      title: "问候",
      description: "hi",
      publisherName: "test",
    });
    const owner = { ownerId: randomUUID(), claimId: randomUUID() };
    const { run } = p.service.claim(taskId, owner);
    p.service.report(run.id, owner, 1, { type: "session", sessionId: "s" });
    const open = async () => {
      const controller = new AbortController();
      controllers.push(controller);
      const response = await fetch(`${base}/api/events?taskId=${taskId}`, {
        headers: { cookie },
        signal: controller.signal,
      });
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("content-type")?.includes("text/event-stream"),
        true,
      );
      assert.ok(response.body);
      return response.body.getReader();
    };
    const reader = await open();
    const decoder = new TextDecoder();
    const initial = decoder.decode((await reader.read()).value);
    assert.match(initial, /"output":""/);
    p.service.report(run.id, owner, 2, {
      type: "notification",
      notification: {
        sessionId: "s",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "半段问候" },
        },
      },
    });
    const update = decoder.decode((await reader.read()).value);
    assert.match(update, /半段问候/);
    assert.match(update, /"endedAt":null/);
    controllers[0]!.abort();
    const resumed = await open();
    const snapshot = decoder.decode((await resumed.read()).value);
    assert.match(snapshot, /"output":"半段问候"/);
    assert.equal(p.store.run(run.id)?.output, "半段问候");
    // A snapshot larger than the socket high-water mark must drain and keep delivering.
    const nextFrame = async () => {
      let frame = "";
      while (!frame.includes("\n\n")) {
        const chunk = await resumed.read();
        assert.equal(chunk.done, false);
        frame += decoder.decode(chunk.value, { stream: true });
      }
      return frame;
    };
    p.service.report(run.id, owner, 3, {
      type: "notification",
      notification: {
        sessionId: "s",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "长".repeat(60000) },
        },
      },
    });
    const large = await nextFrame();
    assert.ok(Buffer.byteLength(large) > 128 * 1024);
    assert.match(large, /"endedAt":null/);
    p.service.report(run.id, owner, 4, {
      type: "notification",
      notification: {
        sessionId: "s",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "末尾" },
        },
      },
    });
    assert.match(await nextFrame(), /末尾/);
    assert.equal(
      (
        await fetch(`${base}/api/events?taskId=invalid`, {
          headers: { cookie },
        })
      ).status,
      400,
    );
  } finally {
    controllers.forEach((c) => c.abort());
    await p.service.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    p.store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
