import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createPlatform } from "../src/server/http.js";
import { CodexAdapter } from "../src/server/codex-adapter.js";
import { TaskConnector } from "../src/connector/connector.js";

export async function fixture(authMethod?: "api-key") {
  const dir = await mkdtemp(resolve(tmpdir(), "task-mvp-"));
  const build = async (autoConnect = true) => {
    const platform = createPlatform({
      dbPath: resolve(dir, "tasks.sqlite"),
      workspace: dir,
      mode: "fake",
    });
    const adapter = new CodexAdapter({
      mode: "fake",
      authMethod,
      command: process.execPath,
      args: [
        "--import",
        import.meta.resolve("tsx"),
        resolve("tests/fake-acp.ts"),
      ],
      workspace: dir,
      env: { PATH: process.env.PATH! },
    });
    const server = createServer(platform.app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const connector = new TaskConnector(base, adapter);
    if (autoConnect) connector.start();
    const response = await fetch(base + "/api/bootstrap");
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    const { csrf } = (await response.json()) as { csrf: string };
    const api = async (path: string, body?: unknown) => {
      const response = await fetch(base + "/api" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          cookie,
          origin: base,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as any };
    };
    return {
      ...platform,
      server,
      base,
      api,
      cookie,
      csrf,
      connector,
      adapter,
      stop: async () => {
        await platform.service.close();
        await connector.close();
        await new Promise<void>((r, j) =>
          server.close((e) => (e ? j(e) : r())),
        );
        platform.store.close();
      },
    };
  };
  return {
    dir,
    build,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
export async function until<T>(
  read: () => Promise<T>,
  predicate: (x: T) => boolean,
): Promise<T> {
  const end = Date.now() + 20000;
  let value: T;
  do {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((r) => setTimeout(r, 30));
  } while (Date.now() < end);
  throw new Error("Timed out waiting: " + JSON.stringify(value));
}

test("real HTTP MCP publish → SQLite → ACP child permission → browser API decision → result; serial queue", async () => {
  const f = await fixture();
  const p = await f.build();
  const client = new Client({ name: "integration-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(p.base + "/mcp")),
    );
    assert.deepEqual(
      (await client.listTools()).tools.map((t) => t.name),
      [
        "publish_task",
        "list_harnesses",
        "wait_for_approval",
        "submit_approval_decision",
        "get_wakeup_status",
        "get_task_wakeups",
        "acknowledge_task_wakeup",
      ],
    );
    assert.equal(
      (await client.callTool({ name: "approve_task", arguments: {} })).isError,
      true,
    );
    const published = await client.callTool({
      name: "publish_task",
      arguments: {
        title: "审批闭环",
        description: "test command",
        publisherName: "小王",
      },
    });
    const id = (published.structuredContent as { taskId: string }).taskId;
    const second = (
      await p.api("/tasks", {
        title: "排队",
        description: "second",
        publisherName: "MCP",
      })
    ).body.taskId;
    const detail = await until(
      async () => (await p.api("/tasks/" + id)).body,
      (x) => x.approvals.length === 1,
    );
    assert.equal(detail.task.publisherName, "小王");
    assert.equal((await p.api("/tasks/" + second)).body.task.status, "queued");
    assert.ok(p.connector.received.some((event) => event.taskId === id));
    assert.equal(detail.runs[0].ownerId, p.connector.ownerId);
    const approval = detail.approvals[0];
    const decision = {
      runId: approval.runId,
      sessionId: approval.sessionId,
      optionId: "allow-once",
    };
    assert.equal(
      (await p.api("/approvals/" + approval.id + "/decision", decision)).status,
      200,
    );
    assert.equal(
      (await p.api("/approvals/" + approval.id + "/decision", decision)).status,
      409,
    );
    const finished = await until(
      async () => (await p.api("/tasks/" + id)).body,
      (x) => x.task.status === "succeeded",
    );
    assert.match(finished.runs[0].output, /selected:allow-once/);
    assert.match(finished.runs[0].output, /auth=none/);
    await until(
      async () => (await p.api("/tasks/" + second)).body,
      (x) => x.approvals.length === 1,
    );
    assert.equal((await p.api("/tasks/" + second + "/cancel", {})).status, 200);
    assert.equal(p.store.detail(id)!.runs.length, 1);
  } finally {
    await client.close();
    await p.stop();
    await f.cleanup();
  }
});

test("reject uses original ACP reject option; invalid and wrong-session choices fail", async () => {
  const f = await fixture();
  const p = await f.build();
  try {
    const id = (
      await p.api("/tasks", {
        title: "拒绝",
        description: "test",
        publisherName: "user",
      })
    ).body.taskId;
    const detail = await until(
      async () => (await p.api("/tasks/" + id)).body,
      (x) => x.approvals.length > 0,
    );
    const a = detail.approvals[0];
    for (const patch of [
      { optionId: "invented" },
      { sessionId: "wrong" },
      { runId: "wrong" },
    ]) {
      assert.equal(
        (
          await p.api("/approvals/" + a.id + "/decision", {
            runId: a.runId,
            sessionId: a.sessionId,
            optionId: "reject-once",
            ...patch,
          })
        ).status,
        409,
      );
    }
    assert.equal(
      (
        await p.api("/approvals/" + a.id + "/decision", {
          runId: a.runId,
          sessionId: a.sessionId,
          optionId: "reject-once",
        })
      ).status,
      200,
    );
    const finished = await until(
      async () => (await p.api("/tasks/" + id)).body,
      (x) => x.task.status === "succeeded",
    );
    assert.match(finished.runs[0].output, /selected:reject-once/);
  } finally {
    await p.stop();
    await f.cleanup();
  }
});

test("cancel invalidates pending callback; explicit retry creates a different run and approval", async () => {
  const f = await fixture();
  const p = await f.build();
  try {
    const id = (
      await p.api("/tasks", {
        title: "取消",
        description: "test",
        publisherName: "user",
      })
    ).body.taskId;
    const d = await until(
      async () => (await p.api("/tasks/" + id)).body,
      (x) => x.approvals.length > 0,
    );
    const a = d.approvals[0];
    await p.api("/tasks/" + id + "/cancel", {});
    assert.equal(
      (
        await p.api("/approvals/" + a.id + "/decision", {
          runId: a.runId,
          sessionId: a.sessionId,
          optionId: "allow-once",
        })
      ).status,
      409,
    );
    assert.equal(
      (await p.api("/tasks/" + id)).body.approvals[0].status,
      "expired",
    );
    await until(
      async () => (await p.api("/tasks/" + id + "/retry", {})).status,
      (x) => x === 200,
    );
    const retried = await until(
      async () => (await p.api("/tasks/" + id)).body,
      (x) => x.approvals.some((a: any) => a.status === "pending"),
    );
    assert.equal(retried.runs.length, 2);
    assert.notEqual(retried.runs[0].id, a.runId);
  } finally {
    await p.stop();
    await f.cleanup();
  }
});

test("restart persists tasks, interrupts old run and expires approvals; no callback resurrection", async () => {
  const f = await fixture();
  let p = await f.build();
  try {
    const id = (
      await p.api("/tasks", {
        title: "重启",
        description: "test",
        publisherName: "user",
      })
    ).body.taskId;
    const d = await until(
      async () => (await p.api("/tasks/" + id)).body,
      (x) => x.approvals.length > 0,
    );
    const a = d.approvals[0];
    await p.stop();
    p = await f.build();
    const restored = (await p.api("/tasks/" + id)).body;
    assert.equal(restored.task.status, "interrupted");
    assert.equal(restored.approvals[0].status, "expired");
    assert.equal(
      (
        await p.api("/approvals/" + a.id + "/decision", {
          runId: a.runId,
          sessionId: a.sessionId,
          optionId: "allow-once",
        })
      ).status,
      409,
    );
    assert.equal((await p.api("/tasks/" + id + "/retry", {})).status, 200);
  } finally {
    await p.stop();
    await f.cleanup();
  }
});

test("local security: Host, Origin, CSRF, unknown fields and MCP cannot approve", async () => {
  const f = await fixture();
  const p = await f.build();
  try {
    assert.equal(
      await new Promise<number>((r) => {
        const req = httpRequest(
          p.base + "/api/bootstrap",
          { headers: { host: "evil.test" } },
          (res) => {
            res.resume();
            r(res.statusCode!);
          },
        );
        req.end();
      }),
      403,
    );
    assert.equal(
      (
        await fetch(p.base + "/api/tasks", {
          headers: { origin: "https://evil.test" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(p.base + "/api/tasks", {
          method: "POST",
          headers: { origin: p.base, "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await p.api("/tasks", {
          title: "",
          description: "x",
          publisherName: "x",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await p.api("/tasks", {
          title: "x",
          description: "x",
          publisherName: "x",
          cwd: "/etc",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(p.base + "/mcp", {
          method: "POST",
          headers: { origin: "https://evil.test" },
        })
      ).status,
      403,
    );
  } finally {
    await p.stop();
    await f.cleanup();
  }
});

test("unexpected ACP process exit fails current run and unblocks next queued task", async () => {
  const f = await fixture();
  const p = await f.build();
  try {
    const id = (
      await p.api("/tasks", {
        title: "进程退出",
        description: "[process-exit]",
        publisherName: "test",
      })
    ).body.taskId;
    const next = (
      await p.api("/tasks", {
        title: "后续任务",
        description: "test",
        publisherName: "test",
      })
    ).body.taskId;
    const failed = await until(
      async () => (await p.api("/tasks/" + id)).body,
      (x) => x.task.status === "failed",
    );
    assert.equal(failed.approvals.length, 0);
    await until(
      async () => (await p.api("/tasks/" + next)).body,
      (x) => x.task.status === "awaiting_approval",
    );
  } finally {
    await p.stop();
    await f.cleanup();
  }
});

test("ACP permission for a different session is cancelled, never approved or displayed", async () => {
  const f = await fixture();
  const p = await f.build();
  try {
    const id = (
      await p.api("/tasks", {
        title: "错误会话",
        description: "[bad-session]",
        publisherName: "test",
      })
    ).body.taskId;
    const d = await until(
      async () => (await p.api("/tasks/" + id)).body,
      (x) => x.task.status === "succeeded",
    );
    assert.equal(d.approvals.length, 0);
    assert.match(d.runs[0].output, /cancelled/);
  } finally {
    await p.stop();
    await f.cleanup();
  }
});

test("server restart recovers persisted crash state and queued task; no auto-resume of old session", async () => {
  const f = await fixture();
  let p = await f.build();
  try {
    const id = (
      await p.api("/tasks", {
        title: "崩溃现场",
        description: "test",
        publisherName: "test",
      })
    ).body.taskId;
    const d = await until(
      async () => (await p.api("/tasks/" + id)).body,
      (x) => x.task.status === "awaiting_approval",
    );
    await p.stop();
    // Reconstruct the exact durable records an ungraceful crash leaves. No live callback survives.
    const { Store } = await import("../src/server/store.js");
    const store = new Store(resolve(f.dir, "tasks.sqlite"));
    const task = d.task,
      run = d.runs[0],
      a = d.approvals[0];
    task.status = "awaiting_approval";
    run.status = "awaiting_approval";
    run.endedAt = null;
    a.status = "pending";
    store.saveTask(task);
    store.saveRun(run);
    store.saveApproval(a);
    const queued = store.publish({
      title: "崩溃前排队",
      description: "test",
      publisherName: "test",
    });
    store.close();
    p = await f.build();
    const recovered = (await p.api("/tasks/" + id)).body;
    assert.equal(recovered.task.status, "interrupted");
    assert.equal(recovered.approvals[0].status, "expired");
    await until(
      async () => (await p.api("/tasks/" + queued.id)).body,
      (x) => x.task.status === "awaiting_approval",
    );
    assert.equal((await p.api("/tasks/" + id)).body.runs.length, 1);
  } finally {
    await p.stop();
    await f.cleanup();
  }
});

test("approval deadline cancels the run, expires approval and rejects late decision", async (t) => {
  const f = await fixture();
  const p = await f.build();
  try {
    const id = (
      await p.api("/tasks", {
        title: "审批超时",
        description: "test",
        publisherName: "test",
      })
    ).body.taskId;
    const d = await until(
      async () => (await p.api("/tasks/" + id)).body,
      (x) => x.task.status === "awaiting_approval",
    );
    const a = d.approvals[0];
    const { LIMITS } = await import("../src/shared/protocol.js");
    const lease = p.store.lease(a.runId)!;
    p.store.saveLease(
      a.runId,
      lease.ownerId,
      lease.claimId,
      Date.now() + LIMITS.approvalMs + LIMITS.leaseMs,
      lease.seq,
    );
    p.service.sweep(Date.now() + LIMITS.approvalMs + 1);
    const expired = (await p.api("/tasks/" + id)).body;
    assert.equal(expired.task.status, "cancelled");
    assert.equal(expired.approvals[0].status, "expired");
    assert.equal(
      (
        await p.api("/approvals/" + a.id + "/decision", {
          runId: a.runId,
          sessionId: a.sessionId,
          optionId: "allow-once",
        })
      ).status,
      409,
    );
  } finally {
    t.mock.timers.reset();
    await p.stop();
    await f.cleanup();
  }
});

test("explicit auth method is discovered and sent through ACP without using real credentials", async () => {
  const f = await fixture("api-key");
  const p = await f.build();
  try {
    const id = (
      await p.api("/tasks", {
        title: "认证协商",
        description: "fake only",
        publisherName: "test",
      })
    ).body.taskId;
    const d = await until(
      async () => (await p.api("/tasks/" + id)).body,
      (x) => x.task.status === "awaiting_approval",
    );
    const a = d.approvals[0];
    assert.equal(d.runs[0].discovery.authMethods[0].id, "api-key");
    await p.api("/approvals/" + a.id + "/decision", {
      runId: a.runId,
      sessionId: a.sessionId,
      optionId: "reject-once",
    });
    const finished = await until(
      async () => (await p.api("/tasks/" + id)).body,
      (x) => x.task.status === "succeeded",
    );
    assert.match(finished.runs[0].output, /auth=selected/);
  } finally {
    await p.stop();
    await f.cleanup();
  }
});

test("cancel followed immediately by shutdown preserves the cancelled run across restart", async () => {
  const f = await fixture();
  let p = await f.build();
  try {
    const id = (
      await p.api("/tasks", {
        title: "取消后关停",
        description: "test",
        publisherName: "test",
      })
    ).body.taskId;
    await until(
      async () => (await p.api("/tasks/" + id)).body,
      (x) => x.task.status === "awaiting_approval",
    );
    await p.api("/tasks/" + id + "/cancel", {});
    await p.stop();
    p = await f.build();
    const d = (await p.api("/tasks/" + id)).body;
    assert.equal(d.task.status, "cancelled");
    assert.equal(d.runs[0].status, "cancelled");
    assert.equal(d.approvals[0].status, "expired");
  } finally {
    await p.stop();
    await f.cleanup();
  }
});

test("SSE subscription before HTTP MCP publication receives a durable task.available event; receipt is not execution", async () => {
  const f = await fixture();
  const p = await f.build(false);
  const controller = new AbortController();
  const { subscribe } = await import("../src/connector/transport.js");
  const events = subscribe(p.base, 0, controller.signal);
  const received = events.next();
  const client = new Client({ name: "subscription-first", version: "1" });
  try {
    await until(
      async () => p.service.events.listenerCount("available"),
      (n) => n === 1,
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(p.base + "/mcp")),
    );
    const published = await client.callTool({
      name: "publish_task",
      arguments: {
        title: "先订阅再发布",
        description: "real HTTP event",
        publisherName: "MCP",
      },
    });
    const id = (published.structuredContent as any).taskId;
    const item = await received;
    assert.equal(item.value!.type, "task.available");
    assert.equal(item.value!.taskId, id);
    assert.equal(p.store.deliveries(0)[0].id, item.value!.id);
    const d = (await p.api("/tasks/" + id)).body;
    assert.equal(d.task.status, "queued");
    assert.equal(d.runs.length, 0);
  } finally {
    controller.abort();
    await events.return(undefined).catch(() => {});
    await client.close();
    await p.stop();
    await f.cleanup();
  }
});

test("offline publication survives server restart; late HTTP subscriber replays and executes through ACP", async () => {
  const f = await fixture();
  let p = await f.build(false);
  try {
    const id = (
      await p.api("/tasks", {
        title: "离线任务",
        description: "retained",
        publisherName: "test",
      })
    ).body.taskId;
    assert.equal((await p.api("/tasks/" + id)).body.task.status, "queued");
    await p.stop();
    p = await f.build(false);
    p.connector.start();
    const d = await until(
      async () => (await p.api("/tasks/" + id)).body,
      (x) => x.task.status === "awaiting_approval",
    );
    assert.ok(p.connector.received.some((e) => e.taskId === id));
    assert.equal(d.runs[0].ownerId, p.connector.ownerId);
    const a = d.approvals[0];
    await p.api("/approvals/" + a.id + "/decision", {
      runId: a.runId,
      sessionId: a.sessionId,
      optionId: "reject-once",
    });
    const done = await until(
      async () => (await p.api("/tasks/" + id)).body,
      (x) => x.task.status === "succeeded",
    );
    assert.match(done.runs[0].output, /selected:reject-once/);
    assert.equal(done.events[0].notification.sessionId, a.sessionId);
  } finally {
    await p.stop();
    await f.cleanup();
  }
});

test("Last-Event-ID reconnect replays publications during disconnection in order; cursor zero intentionally redelivers", async () => {
  const f = await fixture();
  const p = await f.build(false);
  const { subscribe } = await import("../src/connector/transport.js");
  const controllers: AbortController[] = [];
  const readers: AsyncGenerator<any>[] = [];
  const open = (after: number) => {
    const c = new AbortController();
    controllers.push(c);
    const s = subscribe(p.base, after, c.signal);
    readers.push(s);
    return s;
  };
  try {
    const first = open(0);
    const next = first.next();
    const a = (
      await p.api("/tasks", {
        title: "第一条",
        description: "x",
        publisherName: "x",
      })
    ).body.taskId;
    const one = (await next).value;
    assert.equal(one.taskId, a);
    controllers[0].abort();
    await first.return(undefined).catch(() => {});
    const b = (
      await p.api("/tasks", {
        title: "离线第二条",
        description: "x",
        publisherName: "x",
      })
    ).body.taskId;
    const c = (
      await p.api("/tasks", {
        title: "离线第三条",
        description: "x",
        publisherName: "x",
      })
    ).body.taskId;
    const second = open(one.id);
    const two = (await second.next()).value,
      three = (await second.next()).value;
    assert.equal(two.taskId, b);
    assert.equal(three.taskId, c);
    assert.ok(three.id > two.id && two.id > one.id);
    const replay = open(0);
    assert.deepEqual((await replay.next()).value, one);
  } finally {
    controllers.forEach((c) => c.abort());
    for (const r of readers) await r.return(undefined).catch(() => {});
    await p.stop();
    await f.cleanup();
  }
});

test("concurrent and repeated claims are fenced; sequenced reports are idempotent and do not imply success on receipt", async () => {
  const f = await fixture();
  const p = await f.build(false);
  const { randomUUID } = await import("node:crypto");
  const { post } = await import("../src/connector/transport.js");
  try {
    const id = (
      await p.api("/tasks", {
        title: "领取幂等",
        description: "x",
        publisherName: "test",
      })
    ).body.taskId;
    const one = { taskId: id, ownerId: randomUUID(), claimId: randomUUID() },
      two = { taskId: id, ownerId: randomUUID(), claimId: randomUUID() };
    const results = await Promise.allSettled([
      post<any>(p.base, "/connector/claim", one),
      post<any>(p.base, "/connector/claim", two),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const winner = results[0].status === "fulfilled" ? one : two;
    const other = winner === one ? two : one;
    const claim = await post<any>(p.base, "/connector/claim", winner);
    const again = await post<any>(p.base, "/connector/claim", winner);
    assert.equal(claim.run.id, again.run.id);
    assert.equal(p.store.detail(id)!.runs.length, 1);
    const owner = { ownerId: winner.ownerId, claimId: winner.claimId };
    await assert.rejects(
      post(p.base, `/connector/runs/${claim.run.id}/heartbeat`, {
        ownerId: other.ownerId,
        claimId: other.claimId,
      }),
    );
    const report = {
      ...owner,
      seq: 1,
      update: { type: "session", sessionId: "manual-test-session" },
    };
    await post(p.base, `/connector/runs/${claim.run.id}/report`, report);
    assert.equal(
      (
        await post<any>(
          p.base,
          `/connector/runs/${claim.run.id}/report`,
          report,
        )
      ).duplicate,
      true,
    );
    await assert.rejects(
      post(p.base, `/connector/runs/${claim.run.id}/report`, {
        ...report,
        seq: 3,
      }),
    );
    assert.equal(p.store.task(id)!.status, "running");
    const finish = {
      ...owner,
      seq: 2,
      update: {
        type: "finished",
        status: "failed",
        stopReason: null,
        error: "test stop",
      },
    };
    await post(p.base, `/connector/runs/${claim.run.id}/report`, finish);
    assert.equal(
      (
        await post<any>(
          p.base,
          `/connector/runs/${claim.run.id}/report`,
          finish,
        )
      ).duplicate,
      true,
    );
  } finally {
    await p.stop();
    await f.cleanup();
  }
});

test("two subscription clients receive duplicate availability but only one run executes", async () => {
  const f = await fixture();
  const p = await f.build(false);
  const second = new TaskConnector(p.base, p.adapter);
  p.connector.start();
  second.start();
  try {
    const id = (
      await p.api("/tasks", {
        title: "重复事件",
        description: "x",
        publisherName: "test",
      })
    ).body.taskId;
    const d = await until(
      async () => (await p.api("/tasks/" + id)).body,
      (x) => x.task.status === "awaiting_approval",
    );
    await until(
      async () =>
        p.connector.received.some((e) => e.taskId === id) &&
        second.received.some((e) => e.taskId === id),
      Boolean,
    );
    assert.equal(d.runs.length, 1);
    const a = d.approvals[0];
    await p.api("/approvals/" + a.id + "/decision", {
      runId: a.runId,
      sessionId: a.sessionId,
      optionId: "allow-once",
    });
    await until(
      async () => (await p.api("/tasks/" + id)).body,
      (x) => x.task.status === "succeeded",
    );
    assert.equal(p.store.detail(id)!.runs.length, 1);
  } finally {
    await second.close();
    await p.stop();
    await f.cleanup();
  }
});

test("approval wait keeps ownership alive; cancel acknowledges termination and releases queued work", async () => {
  const f = await fixture();
  const p = await f.build();
  try {
    const id = (
      await p.api("/tasks", {
        title: "等待审批",
        description: "x",
        publisherName: "test",
      })
    ).body.taskId;
    const next = (
      await p.api("/tasks", {
        title: "后续队列",
        description: "x",
        publisherName: "test",
      })
    ).body.taskId;
    const d = await until(
      async () => (await p.api("/tasks/" + id)).body,
      (x) => x.task.status === "awaiting_approval",
    );
    const before = p.store.lease(d.runs[0].id)!.deadline;
    await until(
      async () => p.store.lease(d.runs[0].id)!.deadline,
      (n) => n > before + 500,
    );
    assert.equal(p.store.task(id)!.status, "awaiting_approval");
    assert.equal(p.store.task(next)!.status, "queued");
    assert.equal(p.store.approvals(d.runs[0].id)[0].status, "pending");
    p.connector.reconnect();
    await p.api("/tasks/" + id + "/cancel", {});
    const later = await until(
      async () => (await p.api("/tasks/" + next)).body,
      (x) => x.task.status === "awaiting_approval",
    );
    assert.equal(p.store.detail(id)!.runs[0].status, "cancelled");
    assert.ok(p.store.detail(id)!.runs[0].endedAt);
    assert.notEqual(later.runs[0].id, d.runs[0].id);
  } finally {
    await p.stop();
    await f.cleanup();
  }
});

test("actual connector process death expires ownership and approvals; a new subscriber continues the next task", async () => {
  const f = await fixture();
  const p = await f.build(false);
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const child = spawn(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), resolve("src/connector/main.ts")],
    {
      env: {
        PATH: process.env.PATH,
        FAKE_ACP: "1",
        TASK_WORKSPACE: f.dir,
        TASK_PLATFORM_URL: p.base,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.resume();
  child.stderr.resume();
  try {
    const id = (
      await p.api("/tasks", {
        title: "连接器进程退出",
        description: "fake only",
        publisherName: "test",
      })
    ).body.taskId;
    const d = await until(
      async () => (await p.api("/tasks/" + id)).body,
      (x) => x.task.status === "awaiting_approval",
    );
    child.kill("SIGKILL");
    await once(child, "exit");
    const lease = p.store.lease(d.runs[0].id)!;
    p.service.sweep(lease.deadline + 1);
    const lost = (await p.api("/tasks/" + id)).body;
    assert.equal(lost.task.status, "interrupted");
    assert.equal(lost.approvals[0].status, "expired");
    const next = (
      await p.api("/tasks", {
        title: "重连后任务",
        description: "x",
        publisherName: "test",
      })
    ).body.taskId;
    p.connector.start();
    await until(
      async () => (await p.api("/tasks/" + next)).body,
      (x) => x.task.status === "awaiting_approval",
    );
    assert.equal(p.store.detail(id)!.runs.length, 1);
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    await p.stop();
    await f.cleanup();
  }
});

test("SSE rejects browser origins and invalid replay cursors; ACP payloads forwarded over HTTP use official schema validation", async () => {
  const f = await fixture();
  const p = await f.build(false);
  const { randomUUID } = await import("node:crypto");
  const { post } = await import("../src/connector/transport.js");
  try {
    assert.equal(
      (
        await fetch(p.base + "/connector/events", {
          headers: { origin: p.base },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(p.base + "/connector/events", {
          headers: { "last-event-id": "999999" },
        })
      ).status,
      400,
    );
    const id = (
      await p.api("/tasks", {
        title: "结构校验",
        description: "x",
        publisherName: "test",
      })
    ).body.taskId;
    const owner = { ownerId: randomUUID(), claimId: randomUUID() };
    const claim = await post<any>(p.base, "/connector/claim", {
      taskId: id,
      ...owner,
    });
    await assert.rejects(
      post(p.base, `/connector/runs/${claim.run.id}/report`, {
        ...owner,
        seq: 1,
        update: {
          type: "notification",
          notification: {
            sessionId: "x",
            update: { sessionUpdate: "invented" },
          },
        },
      }),
    );
    assert.equal(p.store.lease(claim.run.id)!.seq, 0);
  } finally {
    await p.stop();
    await f.cleanup();
  }
});

test("connector cannot execute using a workspace or fake/real mode different from the platform configuration", async () => {
  const f = await fixture();
  const p = await f.build(false);
  const wrong = new TaskConnector(
    p.base,
    new CodexAdapter({
      mode: "fake",
      command: process.execPath,
      args: [
        "--import",
        import.meta.resolve("tsx"),
        resolve("tests/fake-acp.ts"),
      ],
      workspace: "/tmp",
      env: { PATH: process.env.PATH! },
    }),
  );
  try {
    const id = (
      await p.api("/tasks", {
        title: "固定工作区",
        description: "must not start",
        publisherName: "test",
      })
    ).body.taskId;
    wrong.start();
    const d = await until(
      async () => (await p.api("/tasks/" + id)).body,
      (x) => x.task.status === "failed",
    );
    assert.match(d.runs[0].error, /未启动 ACP/);
    assert.equal(d.runs[0].sessionId, null);
    assert.equal(d.runs[0].discovery, null);
  } finally {
    await wrong.close();
    await p.stop();
    await f.cleanup();
  }
});

test("cancelling a stubborn ACP child forces process cleanup and does not permanently block queued work", async () => {
  const f = await fixture();
  const p = await f.build();
  try {
    const id = (
      await p.api("/tasks", {
        title: "挂起的测试 ACP",
        description: "[stubborn]",
        publisherName: "test",
      })
    ).body.taskId;
    const next = (
      await p.api("/tasks", {
        title: "强制停止后的任务",
        description: "fake only",
        publisherName: "test",
      })
    ).body.taskId;
    await until(
      async () => (await p.api("/tasks/" + id)).body,
      (x) => x.runs[0]?.output.includes("stubborn prompt started"),
    );
    await p.api("/tasks/" + id + "/cancel", {});
    await until(
      async () => (await p.api("/tasks/" + next)).body,
      (x) => x.task.status === "awaiting_approval",
    );
    const stopped = (await p.api("/tasks/" + id)).body;
    assert.equal(stopped.task.status, "cancelled");
    assert.ok(stopped.runs[0].endedAt);
    assert.equal(stopped.runs.length, 1);
  } finally {
    await p.stop();
    await f.cleanup();
  }
});
