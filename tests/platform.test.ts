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

export async function fixture(authMethod?: "api-key") {
  const dir = await mkdtemp(resolve(tmpdir(), "task-mvp-"));
  const build = async () => {
    const platform = createPlatform({
      dbPath: resolve(dir, "tasks.sqlite"),
      workspace: dir,
      adapter: new CodexAdapter({
        authMethod,
        command: process.execPath,
        args: [
          "--import",
          import.meta.resolve("tsx"),
          resolve("tests/fake-acp.ts"),
        ],
        workspace: dir,
        env: { PATH: process.env.PATH! },
      }),
    });
    const server = createServer(platform.app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
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
      stop: async () => {
        await platform.service.close();
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
  const end = Date.now() + 12000;
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
      ["publish_task"],
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
    const nativeTimer = globalThis.setTimeout;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const id = (
      await p.api("/tasks", {
        title: "审批超时",
        description: "test",
        publisherName: "test",
      })
    ).body.taskId;
    let d: any;
    const deadline = Date.now() + 12000;
    do {
      d = (await p.api("/tasks/" + id)).body;
      if (d.task.status === "awaiting_approval") break;
      await new Promise((r) => nativeTimer(r, 30));
    } while (Date.now() < deadline);
    assert.equal(d.task.status, "awaiting_approval");
    const a = d.approvals[0];
    const { LIMITS } = await import("../src/shared/protocol.js");
    t.mock.timers.tick(LIMITS.approvalMs + 1);
    t.mock.timers.reset();
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
