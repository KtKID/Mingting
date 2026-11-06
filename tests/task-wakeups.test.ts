import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  browserSnapshotSchema,
  publishResultSchema,
} from "../src/shared/protocol.js";
import { createPlatform } from "../src/server/http.js";
import type { WakeupDelivery } from "../src/server/task-wakeup.js";
import type { WakeupEvent } from "../src/shared/task-wakeup.js";
import {
  validateWakeupReplay,
  renderWakeupReplay,
} from "../src/shared/wakeup-replay.js";
import {
  CodexWakeupDelivery,
  configuredCodexWakeups,
  wakeupMessage,
} from "../src/server/codex-wakeup.js";

async function fixture(fail = false) {
  const dir = await mkdtemp(join(tmpdir(), "mingting-wakeup-"));
  const target = { threadId: randomUUID(), originTurnId: randomUUID() };
  const sent: WakeupEvent[] = [];
  const delivery: WakeupDelivery = {
    status: () => ({ available: true, transport: "test-fixture", error: null }),
    accepts: (value) => value.threadId === target.threadId,
    send: async (event) => {
      sent.push(structuredClone(event));
      if (fail) throw new Error("fixture host unavailable");
      return {
        accepted: true,
        messageId: randomUUID(),
        source: "test-fixture",
      };
    },
  };
  let platform = createPlatform({
    dbPath: join(dir, "tasks.sqlite"),
    workspace: dir,
    mode: "fake",
    wakeupDelivery: delivery,
  });
  const published = platform.service.publish({
    title: "检查 README",
    description: "只读",
    publisherName: "Codex",
    wakeup: target,
  });
  const subscription = published.approvalSubscription;
  if (!subscription) throw new Error("missing approval subscription");
  const owner = { ownerId: randomUUID(), claimId: randomUUID() };
  const { run } = platform.service.claim(published.taskId, owner);
  platform.service.report(run.id, owner, 1, {
    type: "session",
    sessionId: "wakeup-session",
  });
  const { approvalId } = platform.service.permission(run.id, owner, "read-1", {
    sessionId: "wakeup-session",
    toolCall: {
      toolCallId: "read",
      title: "Read README",
      kind: "read",
      rawInput: { file_path: "README.md" },
    },
    options: [
      { optionId: "read-this-file", name: "Allow once", kind: "allow_once" },
      { optionId: "deny-this-file", name: "Deny", kind: "reject_once" },
    ],
  });
  return {
    get p() {
      return platform;
    },
    dir,
    target,
    sent,
    published,
    subscription,
    owner,
    run,
    approvalId,
    restart: async () => {
      await platform.service.close();
      platform.store.close();
      platform = createPlatform({
        dbPath: join(dir, "tasks.sqlite"),
        workspace: dir,
        mode: "fake",
        wakeupDelivery: delivery,
      });
      await platform.service.wakeups?.idle();
    },
    close: async () => {
      await platform.service.close();
      platform.store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("W1 unavailable host rejects a wakeup publication before creating a task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mingting-wakeup-"));
  const p = createPlatform({
    dbPath: join(dir, "tasks.sqlite"),
    workspace: dir,
    mode: "fake",
  });
  try {
    const input = {
      title: "检查 README",
      description: "只读",
      publisherName: "Codex",
      wakeup: { threadId: randomUUID(), originTurnId: randomUUID() },
    };
    assert.throws(() => p.service.publish(input), /聊天唤醒宿主/);
    assert.deepEqual(p.store.list(), []);
  } finally {
    await p.service.close();
    p.store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("W2 committed approval and completion deliver once each and confirm independent resumed turns", async () => {
  const f = await fixture();
  try {
    await f.p.service.wakeups?.idle();
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0]?.type, "approval.requested");
    assert.equal(
      f.p.store.task(f.published.taskId)?.status,
      "awaiting_approval",
    );
    assert.equal(
      f.p.store.taskWakeups(f.published.taskId)[0]?.status,
      "delivered",
    );
    assert.doesNotMatch(
      JSON.stringify(f.p.store.detail(f.published.taskId)),
      /originTurnId|subscriptionToken/,
    );
    const approvalEvent = f.p.store.taskWakeups(f.published.taskId)[0];
    if (!approvalEvent) throw new Error("missing approval event");
    const approvalTurn = randomUUID();
    assert.throws(
      () =>
        f.p.service.acknowledgeWakeup(f.subscription, {
          eventId: approvalEvent.id,
          threadId: f.target.threadId,
          turnId: f.target.originTurnId,
        }),
      /独立新回合/,
    );
    assert.throws(
      () =>
        f.p.service.acknowledgeWakeup(
          { ...f.subscription, subscriptionToken: "0".repeat(64) },
          {
            eventId: approvalEvent.id,
            threadId: f.target.threadId,
            turnId: approvalTurn,
          },
        ),
      /凭据无效/,
    );
    assert.deepEqual(
      f.p.service.acknowledgeWakeup(f.subscription, {
        eventId: approvalEvent.id,
        threadId: f.target.threadId,
        turnId: approvalTurn,
      }),
      { ok: true },
    );
    f.p.service.decide(f.approvalId, {
      runId: f.run.id,
      sessionId: "wakeup-session",
      optionId: "read-this-file",
    });
    const finished = {
      type: "finished",
      status: "succeeded",
      stopReason: "end_turn",
      error: null,
    } as const;
    f.p.service.report(f.run.id, f.owner, 2, finished);
    assert.deepEqual(f.p.service.report(f.run.id, f.owner, 2, finished), {
      duplicate: true,
    });
    const completedRun = f.p.store.run(f.run.id);
    if (!completedRun) throw new Error("missing run");
    f.p.store.saveRun(completedRun);
    await f.p.service.wakeups?.idle();
    assert.deepEqual(
      f.sent.map((event) => event.type),
      ["approval.requested", "task.completed"],
    );
    const completion = f.p.store.taskWakeups(f.published.taskId)[1];
    if (!completion) throw new Error("missing completion event");
    assert.throws(
      () =>
        f.p.service.acknowledgeWakeup(f.subscription, {
          eventId: completion.id,
          threadId: f.target.threadId,
          turnId: approvalTurn,
        }),
      /分别恢复独立回合/,
    );
    const completionTurn = randomUUID();
    f.p.service.acknowledgeWakeup(f.subscription, {
      eventId: completion.id,
      threadId: f.target.threadId,
      turnId: completionTurn,
    });
    assert.ok(
      f.p.store
        .taskWakeups(f.published.taskId)
        .every((event) => event.status === "acknowledged"),
    );
    assert.doesNotMatch(
      wakeupMessage(completion),
      new RegExp(f.subscription.subscriptionToken),
    );
  } finally {
    await f.close();
  }
});

test("W3 rollback emits no host message; failed deliveries retain one attempt across unrelated changes", async () => {
  const f = await fixture(true);
  try {
    await f.p.service.wakeups?.idle();
    const original = f.p.store.approval(f.approvalId);
    if (!original) throw new Error("missing approval");
    assert.throws(
      () =>
        f.p.store.transaction(() => {
          f.p.store.saveApproval({
            ...original,
            id: randomUUID(),
            requestId: "rolled-back",
          });
          assert.equal(f.sent.length, 1);
          throw new Error("rollback");
        }),
      /rollback/,
    );
    const detail = f.p.store.detail(f.published.taskId);
    assert.ok(detail);
    f.p.store.saveTask(detail.task);
    await f.p.service.wakeups?.idle();
    assert.equal(f.sent.length, 1);
    assert.equal(f.p.store.taskWakeups(f.published.taskId).length, 1);
    assert.equal(
      f.p.store.taskWakeups(f.published.taskId)[0]?.status,
      "failed",
    );
    assert.equal(f.p.store.taskWakeups(f.published.taskId)[0]?.attempts, 1);
    assert.match(
      f.p.store.taskWakeups(f.published.taskId)[0]?.error ?? "",
      /fixture host/,
    );
  } finally {
    await f.close();
  }
});

test("W4 restart drains durable completion events and retains unknown delivery outcomes for review", async () => {
  const f = await fixture();
  try {
    await f.p.service.wakeups?.idle();
    const event = f.p.store.taskWakeups(f.published.taskId)[0];
    if (!event) throw new Error("missing event");
    f.p.store.saveWakeup({ ...event, status: "sending" });
    await f.restart();
    assert.equal(f.sent.length, 2);
    assert.equal(f.sent[1]?.type, "task.completed");
    assert.equal(f.p.store.task(f.published.taskId)?.status, "interrupted");
    const old = f.p.store.taskWakeups(f.published.taskId)[0];
    assert.equal(old?.status, "failed");
    assert.match(old?.error ?? "", /结果待确认/);
    assert.equal(
      f.p.store.taskWakeups(f.published.taskId)[1]?.status,
      "delivered",
    );
  } finally {
    await f.close();
  }
});

test("W5 binding is limited to the host-confirmed chat and failed transactions retain no target", async () => {
  const f = await fixture();
  try {
    const before = f.p.store.list().length;
    assert.throws(
      () =>
        f.p.service.publish({
          title: "wrong chat",
          description: "test",
          publisherName: "test",
          wakeup: { ...f.target, threadId: randomUUID() },
        }),
      /授权范围/,
    );
    assert.throws(
      () =>
        f.p.service.publish({
          title: "missing subscriber",
          description: "test",
          publisherName: "test",
          approvalTargets: [],
          wakeup: f.target,
        }),
      /发起方审批订阅/,
    );
    assert.equal(f.p.store.list().length, before);
  } finally {
    await f.close();
  }
});

test("W6 replay requires platform event messages and two new turns after their predecessors end", async () => {
  const f = await fixture();
  try {
    await f.p.service.wakeups?.idle();
    const approvalTurn = randomUUID(),
      completionTurn = randomUUID();
    const approval = f.p.store.taskWakeups(f.published.taskId)[0];
    if (!approval) throw new Error("missing approval");
    f.p.service.acknowledgeWakeup(f.subscription, {
      eventId: approval.id,
      threadId: f.target.threadId,
      turnId: approvalTurn,
    });
    f.p.service.decide(f.approvalId, {
      runId: f.run.id,
      sessionId: "wakeup-session",
      optionId: "read-this-file",
    });
    f.p.service.report(f.run.id, f.owner, 2, {
      type: "finished",
      status: "succeeded",
      stopReason: "end_turn",
      error: null,
    });
    await f.p.service.wakeups?.idle();
    const completion = f.p.store.taskWakeups(f.published.taskId)[1];
    if (!completion) throw new Error("missing completion");
    f.p.service.acknowledgeWakeup(f.subscription, {
      eventId: completion.id,
      threadId: f.target.threadId,
      turnId: completionTurn,
    });
    const body = (event: WakeupEvent) => ({
      type: "userMessage",
      content: [{ type: "text", text: wakeupMessage(event) }],
    });
    const final = { type: "agentMessage", phase: "final", text: "本回合结束" };
    // Synthetic host trace tests the validator. Fixture mode itself cannot pass real acceptance.
    const timestamp = Math.floor(Date.now() / 1000);
    const report = {
      mode: "real",
      taskId: f.published.taskId,
      target: f.target,
      events: f.p.store.taskWakeups(f.published.taskId).map((event) => ({
        ...event,
        receipt: {
          source: "codex-acp/session/prompt",
          result: {
            accepted: true,
            sessionId: f.target.threadId,
            agentInfo: {
              name: "@agentclientprotocol/codex-acp",
              version: "2.5.0",
            },
          },
        },
      })),
      threadTrace: {
        thread: { id: f.target.threadId },
        turns: [
          {
            id: completionTurn,
            status: "inProgress",
            startedAt: timestamp,
            completedAt: null,
            items: [body(completion)],
          },
          {
            id: approvalTurn,
            status: "completed",
            startedAt: timestamp - 1,
            completedAt: timestamp,
            items: [body(approval), final],
          },
          {
            id: f.target.originTurnId,
            status: "completed",
            startedAt: timestamp - 2,
            completedAt: timestamp - 1,
            items: [final],
          },
        ],
      },
    };
    assert.equal(validateWakeupReplay(report).passed, true);
    assert.match(renderWakeupReplay(report), /明庭聊天唤醒回放/);
    assert.equal(
      validateWakeupReplay({ ...report, mode: "fixture" }).passed,
      false,
    );
    assert.equal(
      validateWakeupReplay({
        ...report,
        events: f.p.store.taskWakeups(f.published.taskId),
      }).passed,
      false,
    );
    const fixtureReceipt = structuredClone(report);
    const firstReceipt = fixtureReceipt.events[0];
    assert.ok(firstReceipt);
    firstReceipt.receipt.result.agentInfo.name = "wakeup-host-fixture";
    assert.equal(validateWakeupReplay(fixtureReceipt).passed, false);
    const wrongSession = structuredClone(report);
    const wrongReceipt = wrongSession.events[0];
    assert.ok(wrongReceipt);
    wrongReceipt.receipt.result.sessionId = randomUUID();
    assert.equal(validateWakeupReplay(wrongSession).passed, false);
    const missingEnd = structuredClone(report);
    const missingTurn = missingEnd.threadTrace.turns[1];
    assert.ok(missingTurn);
    missingTurn.items = [body(approval)];
    assert.equal(validateWakeupReplay(missingEnd).passed, false);
    const duplicate = structuredClone(report);
    const duplicateEvent = duplicate.events[1];
    assert.ok(duplicateEvent);
    duplicateEvent.resumedTurnId = approvalTurn;
    assert.equal(validateWakeupReplay(duplicate).passed, false);
    const noMessage = structuredClone(report);
    const noMessageTurn = noMessage.threadTrace.turns[0];
    assert.ok(noMessageTurn);
    noMessageTurn.items = [];
    assert.equal(validateWakeupReplay(noMessage).passed, false);
    const waiting = structuredClone(report);
    const waitingTurn = waiting.threadTrace.turns[1];
    assert.ok(waitingTurn);
    const waitingReport = {
      ...waiting,
      threadTrace: {
        ...waiting.threadTrace,
        turns: waiting.threadTrace.turns.map((turn) =>
          turn.id === approvalTurn
            ? {
                ...turn,
                items: [
                  ...turn.items,
                  {
                    type: "commandExecution",
                    command: "node mingting-client.mjs wait receipt.json",
                  },
                ],
              }
            : turn,
        ),
      },
    };
    assert.equal(validateWakeupReplay(waitingReport).passed, false);
  } finally {
    await f.close();
  }
});

test("W7 official host probe exposes connection failure and keeps delivery disabled", async () => {
  const host = new CodexWakeupDelivery({
    command: process.execPath,
    args: [join(tmpdir(), "missing-mingting-host-module.mjs")],
    workspace: process.cwd(),
    env: {},
  });
  const threadId = randomUUID();
  const status = await host.probe(threadId);
  assert.equal(status.available, false);
  assert.ok(status.error);
  assert.equal(host.accepts({ threadId, originTurnId: randomUUID() }), false);
  const incomplete = await configuredCodexWakeups({
    MINGTING_CODEX_WAKEUPS: "1",
  });
  assert.equal(incomplete?.status().available, false);
  assert.equal(await configuredCodexWakeups({}), undefined);
});

test("W8 host adapter uses ACP load/prompt and keeps a single authorized chat target", async () => {
  const host = new CodexWakeupDelivery({
    command: process.execPath,
    args: ["--import", "tsx", resolve("tests/fake-wakeup-host.ts")],
    workspace: process.cwd(),
    env: { ...process.env },
  });
  const f = await fixture();
  try {
    const status = await host.probe(f.target.threadId);
    assert.equal(status.available, true);
    const event = f.p.store.taskWakeups(f.published.taskId)[0];
    assert.ok(event);
    const sent = await host.send(event);
    assert.deepEqual(sent, {
      source: "codex-acp/session/prompt",
      result: {
        accepted: true,
        sessionId: f.target.threadId,
        agentInfo: { name: "wakeup-host-fixture", version: "1" },
      },
    });
    await assert.rejects(
      host.send({
        ...event,
        target: { ...event.target, threadId: randomUUID() },
      }),
      /授权范围/,
    );
    await assert.rejects(
      host.send({ ...event, id: "fixture-host-failure" }),
      /fixture host disconnected/,
    );
    assert.equal(host.status().available, false);
  } finally {
    await host.close();
    await f.close();
  }
});

test("W10 ACP active writer rejects recovery and preserves the original session", async () => {
  const host = new CodexWakeupDelivery({
    command: process.execPath,
    args: ["--import", "tsx", resolve("tests/fake-wakeup-host.ts")],
    workspace: process.cwd(),
    env: { ...process.env, FIXTURE_WRITER_BUSY: "1" },
  });
  try {
    const threadId = randomUUID();
    const status = await host.probe(threadId);
    assert.equal(status.available, false);
    assert.equal(status.transport, "codex-acp");
    assert.match(status.error ?? "", /active writer/);
    assert.equal(host.accepts({ threadId, originTurnId: randomUUID() }), false);
  } finally {
    await host.close();
  }
});

test("W9 HTTP MCP publishes a bound task and the authenticated browser sees wakeup updates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mingting-wakeup-http-"));
  const target = { threadId: randomUUID(), originTurnId: randomUUID() };
  const p = createPlatform({
    dbPath: join(dir, "tasks.sqlite"),
    workspace: dir,
    mode: "fake",
    wakeupDelivery: {
      status: () => ({
        available: true,
        transport: "test-fixture",
        error: null,
      }),
      accepts: (value) => value.threadId === target.threadId,
      send: async () => ({ source: "test-fixture", accepted: true }),
    },
  });
  const server = createServer(p.app);
  const client = new Client({ name: "wakeup-mcp-test", version: "1" });
  try {
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", done);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    await client.connect(
      new StreamableHTTPClientTransport(new URL(base + "/mcp")),
    );
    const publish = await client.callTool({
      name: "mcp-mingting-tool",
      arguments: {
        title: "test",
        description: "Read README",
        publisherName: "Codex",
        wakeup: target,
      },
    });
    assert.notEqual(publish.isError, true);
    const receipt = publishResultSchema.parse(publish.structuredContent);
    assert.deepEqual(receipt.wakeup, target);
    const subscription = receipt.approvalSubscription;
    assert.ok(subscription);
    const snapshotUrl = base + "/api/events?taskId=" + receipt.taskId;
    assert.equal((await fetch(snapshotUrl)).status, 403);
    const bootstrap = await fetch(base + "/api/bootstrap");
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    const browser = await fetch(snapshotUrl, {
      headers: { cookie },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(browser.status, 200);
    assert.ok(browser.body);
    const reader = browser.body
      .pipeThrough(new TextDecoderStream())
      .getReader();
    let buffer = "";
    const readSnapshot = async () => {
      while (!buffer.includes("\n\n")) {
        const part = await reader.read();
        assert.ok(!part.done, "expected browser snapshot");
        buffer += part.value;
      }
      const end = buffer.indexOf("\n\n");
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      assert.ok(frame.startsWith("event: snapshot\ndata: "));
      assert.doesNotMatch(
        frame,
        /subscriptionToken|token_hash|test-fixture|resumedTurnId/,
      );
      return browserSnapshotSchema.parse(
        JSON.parse(frame.slice("event: snapshot\ndata: ".length)),
      );
    };
    assert.deepEqual((await readSnapshot()).detail?.wakeup, {
      target: { sessionId: target.threadId, originTurn: target.originTurnId },
      events: [],
    });
    const bad = await client.callTool({
      name: "get_task_wakeups",
      arguments: { ...subscription, subscriptionToken: "0".repeat(64) },
    });
    assert.equal(bad.isError, true);
    const owner = { ownerId: randomUUID(), claimId: randomUUID() };
    const { run } = p.service.claim(receipt.taskId, owner);
    p.service.report(run.id, owner, 1, {
      type: "session",
      sessionId: "http-session",
    });
    p.service.permission(run.id, owner, "http-read", {
      sessionId: "http-session",
      toolCall: { toolCallId: "read", title: "Read README" },
      options: [{ optionId: "once", name: "Allow", kind: "allow_once" }],
    });
    await p.service.wakeups?.idle();
    const event = p.store.taskWakeups(receipt.taskId)[0];
    assert.ok(event);
    const delivered = await readSnapshot();
    assert.deepEqual(delivered.detail?.wakeup?.events, [
      { id: event.id, type: "approval.requested", status: "delivered" },
    ]);
    const list = await client.callTool({
      name: "get_task_wakeups",
      arguments: subscription,
    });
    assert.notEqual(list.isError, true);
    const ack = await client.callTool({
      name: "acknowledge_task_wakeup",
      arguments: {
        ...subscription,
        eventId: event.id,
        threadId: target.threadId,
        turnId: randomUUID(),
      },
    });
    assert.notEqual(ack.isError, true);
    assert.equal(
      p.store.taskWakeups(receipt.taskId)[0]?.status,
      "acknowledged",
    );
    const acknowledged = await readSnapshot();
    assert.equal(
      acknowledged.detail?.wakeup?.events[0]?.status,
      "acknowledged",
    );
    const publicDetail = await fetch(base + "/api/tasks/" + receipt.taskId, {
      headers: { cookie },
    });
    assert.equal(publicDetail.status, 200);
    assert.doesNotMatch(
      await publicDetail.text(),
      /originTurnId|subscriptionToken/,
    );
    await reader.cancel();
  } finally {
    await client.close();
    await p.service.close();
    await new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
    p.store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
