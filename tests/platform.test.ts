import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createPlatform } from "../src/server/http.js";
import { CodexAdapter } from "../src/server/codex-adapter.js";
import { TaskConnector } from "../src/connector/connector.js";
import {
  LIMITS,
  publishTaskSchema,
  runSchema,
} from "../src/shared/protocol.js";
import { Store } from "../src/server/store.js";

test("Codex contract accepts settings and validates optional run usage while preserving old rows", () => {
  const task = { title: "Task", description: "Read", publisherName: "Test" };
  const settings = { modelId: "A", reasoningEffort: "medium" };
  assert.deepEqual(
    publishTaskSchema.parse({
      ...task,
      targetHarness: "Codex",
      requestedSettings: settings,
    }).requestedSettings,
    settings,
  );
  assert.equal(
    publishTaskSchema.safeParse({
      ...task,
      targetHarness: "Grok",
      requestedSettings: settings,
    }).success,
    false,
  );
  assert.equal(
    publishTaskSchema.safeParse({
      ...task,
      targetHarness: "Codex",
      requestedSettings: {},
    }).success,
    false,
  );
  const old = {
    id: "run",
    taskId: "task",
    status: "succeeded",
    sessionId: "session",
    createdAt: "start",
    endedAt: "end",
    output: "",
    error: null,
    stopReason: "end_turn",
    discovery: null,
  };
  assert.equal(runSchema.parse(old).usage, undefined);
  const usage = {
    scope: "primary_prompt",
    basis: "token_breakdown_v1",
    uncachedInputTokens: 13,
    cachedReadTokens: 8,
    cachedWriteTokens: 0,
    outputTokens: 7,
    reasoningTokens: 2,
    totalTokens: 28,
    coverage: "complete",
    inconsistent: false,
    modelId: "A",
    source: {
      wireFormat: "codex_acp_prompt_v1",
      adapterVersion: "2.5.0",
      protocolVersion: 1,
      method: "session/prompt",
      fieldPath: "result.usage",
      sessionId: "session",
    },
  };
  assert.deepEqual(runSchema.parse({ ...old, usage }).usage, usage);
  assert.equal(
    runSchema.safeParse({ ...old, usage: { ...usage, totalTokens: -1 } })
      .success,
    false,
  );
});

test("Codex audit storage upgrades a legacy SQLite and rolls back observation and sequence together", async (t) => {
  const dir = await mkdtemp(resolve(tmpdir(), "legacy-audit-"));
  const file = resolve(dir, "tasks.sqlite");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const legacy = new DatabaseSync(file);
  legacy.exec(
    "CREATE TABLE tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE runs (id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), data TEXT NOT NULL);",
  );
  const now = new Date().toISOString();
  legacy.prepare("INSERT INTO tasks VALUES (?, ?)").run(
    "old-task",
    JSON.stringify({
      id: "old-task",
      title: "Old",
      description: "Old",
      publisherName: "Test",
      currentRunId: "old-run",
      status: "running",
      createdAt: now,
      updatedAt: now,
    }),
  );
  legacy.prepare("INSERT INTO runs VALUES (?, ?, ?)").run(
    "old-run",
    "old-task",
    JSON.stringify({
      id: "old-run",
      taskId: "old-task",
      status: "running",
      sessionId: "session",
      createdAt: now,
      endedAt: null,
      output: "",
      error: null,
      stopReason: null,
      discovery: null,
    }),
  );
  legacy.close();
  const store = new Store(file);
  try {
    const schema = new DatabaseSync(file, { readOnly: true });
    try {
      assert.ok(
        schema
          .prepare("SELECT name FROM sqlite_schema WHERE name='run_audit'")
          .get(),
        "existing database gains run_audit on open",
      );
    } finally {
      schema.close();
    }
    assert.equal(store.detail("old-task")?.runs[0]?.sessionId, "session");
    const entry = {
      runId: "old-run",
      seq: 1,
      sessionId: "session",
      createdAt: now,
      kind: "context",
      observation: {
        usedTokens: 28,
        effectiveWindowTokens: 76000,
        source: "acp_usage_update",
      },
    } as const;
    store.saveLease(entry.runId, "owner", "claim", 100, 0);
    let changes = 0;
    store.onChange = () => {
      changes++;
    };
    assert.throws(
      () =>
        store.transaction(() => {
          store.appendRunAudit(entry);
          store.saveLease(entry.runId, "owner", "claim", 100, 1);
          throw new Error("injected failure");
        }),
      /injected failure/,
    );
    assert.deepEqual(store.runAudit(entry.runId, 0, 10), []);
    assert.equal(store.lease(entry.runId)?.seq, 0);
    assert.equal(changes, 0);
    store.transaction(() => store.appendRunAudit(entry));
    assert.deepEqual(store.runAudit(entry.runId, 0, 10), [entry]);
    assert.deepEqual(store.runAudit(entry.runId, 1, 10), []);
    assert.deepEqual(store.latestContext(entry.runId), entry.observation);
    assert.equal(changes, 1);
  } finally {
    store.close();
  }
});

export async function fixture(
  authMethod?: "api-key",
  fakeEnv: NodeJS.ProcessEnv = {},
) {
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
      env: { PATH: process.env.PATH!, ...fakeEnv },
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

test("Codex settings are published by Web and MCP without a capability snapshot", async () => {
  const f = await fixture();
  const p = await f.build(false);
  const client = new Client({ name: "settings-test", version: "1" });
  try {
    const input = {
      title: "settings",
      description: "publish",
      publisherName: "Test",
      targetHarness: "Codex",
      requestedSettings: { reasoningEffort: "high" },
    };
    const web = await p.api("/tasks", input);
    assert.equal(web.status, 201);
    assert.deepEqual(
      p.store.task(web.body.taskId)?.requestedSettings,
      input.requestedSettings,
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(p.base + "/mcp")),
    );
    const mcp = await client.callTool({
      name: "publish_task",
      arguments: input,
    });
    const stored = p.store.list().filter((task) => task.title === input.title);
    assert.equal(mcp.isError, undefined);
    assert.equal(stored.length, 2);
    assert.ok(
      stored.every(
        (task) => task.requestedSettings?.reasoningEffort === "high",
      ),
    );
  } finally {
    await client.close();
    await p.stop();
    await f.cleanup();
  }
});

test("Codex run audit reads historical patches and rejects foreign task and run cursors", async () => {
  const f = await fixture();
  const p = await f.build(false);
  try {
    const ownerId = randomUUID();
    p.service.registerHarness({ ownerId, harnessName: "Codex" });
    const { taskId } = p.service.publish({
      title: "Audit",
      description: "test",
      publisherName: "Test",
      targetHarness: "Codex",
    });
    const other = p.service.publish({
      title: "Other",
      description: "test",
      publisherName: "Test",
    });
    const runTool = (sessionId: string) => {
      const owner = { ownerId, claimId: randomUUID() };
      const { run } = p.service.claim(taskId, owner);
      p.service.report(run.id, owner, 1, { type: "session", sessionId });
      const request = {
        sessionId,
        toolCall: { toolCallId: "c1", title: "Read" },
        options: [
          { optionId: "no", name: "Reject", kind: "reject_once" as const },
        ],
      };
      const { approvalId } = p.service.permission(run.id, owner, "id", request);
      p.service.decide(approvalId, {
        runId: run.id,
        sessionId,
        optionId: "no",
      });
      p.service.report(run.id, owner, 2, {
        type: "notification",
        notification: {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "c1",
            title: sessionId,
            status: "pending",
          },
        },
      });
      p.service.report(run.id, owner, 3, {
        type: "notification",
        notification: {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "c1",
            status: "failed",
          },
        },
      });
      return { run, owner, approvalId };
    };
    const a = runTool("session-a");
    p.store.transaction(() => {
      for (let n = 0; n <= LIMITS.events; n++)
        p.store.appendEvent(a.run.id, {
          sessionId: "session-a",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "tail" },
          },
        });
    });
    p.service.report(a.run.id, a.owner, 4, {
      type: "finished",
      status: "failed",
      stopReason: null,
      error: "retry",
    });
    p.service.retry(taskId);
    const b = runTool("session-b");
    const auditPath = (id: string, run: string) =>
      `/tasks/${id}/runs/${run}/audit`;
    const first = await p.api(auditPath(taskId, a.run.id) + "?limit=1");
    assert.equal(first.status, 200);
    assert.equal(first.body.entries[0].patch.title, "session-a");
    assert.equal(first.body.approvals[0].id, a.approvalId);
    const more = `?cursor=${encodeURIComponent(first.body.nextCursor)}`;
    const second = await p.api(auditPath(taskId, a.run.id) + more);
    assert.equal(second.body.entries[0].patch.status, "failed");
    assert.equal((await p.api(auditPath(taskId, b.run.id) + more)).status, 400);
    assert.equal((await p.api(auditPath(other.taskId, a.run.id))).status, 404);
    assert.throws(
      () =>
        p.service.decide(a.approvalId, {
          runId: b.run.id,
          sessionId: "session-b",
          optionId: "no",
        }),
      /失效/,
    );
  } finally {
    await p.stop();
    await f.cleanup();
  }
});

test("Codex settings receipt precedes prompt and rejected settings prevent execution", async () => {
  const f = await fixture();
  const p = await f.build();
  try {
    const snapshot = await until(
      async () => p.service.harnesses()[0]?.capabilities,
      (value) => Boolean(value),
    );
    assert.deepEqual(
      snapshot?.models.map(({ id, efforts }) => [
        id,
        efforts.map((effort) => effort.id),
      ]),
      [
        ["A", ["low", "medium"]],
        ["B", ["low", "high"]],
      ],
    );
    const order: Array<{ receipt?: string; output: string }> = [];
    p.service.events.on("changed", () => {
      const run = p.store
        .list()
        .map((task) => p.store.detail(task.id)?.runs[0])
        .find((item) => item?.settingsReceipt?.status === "applied");
      if (run)
        order.push({
          receipt: run.settingsReceipt?.status,
          output: run.output,
        });
    });
    const execute = async (
      title: string,
      requestedSettings?: { modelId: string; reasoningEffort: string },
    ) => {
      const { taskId } = p.service.publish({
        title,
        description: "[settings-check]",
        publisherName: "Test",
        targetHarness: "Codex",
        requestedSettings,
      });
      return await until(
        async () => p.store.detail(taskId)?.runs[0],
        (run) => Boolean(run?.endedAt),
      );
    };
    const applied = await execute("choose", {
      modelId: "B",
      reasoningEffort: "high",
    });
    assert.equal(applied?.settingsReceipt?.status, "applied");
    assert.equal(applied?.output, "executed:B/high");
    assert.equal(order[0]?.output, "");
    const rejected = await execute("reject", {
      modelId: "B",
      reasoningEffort: "medium",
    });
    assert.equal(rejected?.settingsReceipt?.status, "rejected");
    assert.equal(rejected?.status, "failed");
    assert.equal(rejected?.output, "");
    const defaults = await execute("default");
    assert.equal(defaults?.settingsReceipt?.status, "default");
    assert.equal(defaults?.output, "executed:A/medium");
  } finally {
    await p.stop();
    await f.cleanup();
  }
});

test("Codex settings receipt retries the original sequence after a lost HTTP acknowledgement", async () => {
  const f = await fixture();
  const p = await f.build(false);
  try {
    let socket: import("node:net").Socket | undefined;
    p.server.prependListener("request", (request) => {
      if (request.url?.endsWith("/report")) socket = request.socket;
    });
    const submit = p.service.report.bind(p.service);
    const attempts: Array<{ seq: number; duplicate: boolean }> = [];
    p.service.report = (...args) => {
      const result = submit(...args);
      if (args[3].type === "settings") {
        attempts.push({ seq: args[2], duplicate: result.duplicate });
        if (attempts.length === 1) socket?.destroy();
      }
      return result;
    };
    p.connector.start();
    const { taskId } = p.service.publish({
      title: "Lost ACK",
      description: "[settings-check]",
      publisherName: "Test",
      targetHarness: "Codex",
      requestedSettings: { modelId: "B", reasoningEffort: "high" },
    });
    const run = await until(
      async () => p.store.detail(taskId)?.runs[0],
      (value) => Boolean(value?.endedAt),
    );
    assert.equal(run?.status, "succeeded");
    assert.equal(run?.output, "executed:B/high");
    assert.equal(run?.settingsReceipt?.status, "applied");
    assert.deepEqual(attempts, [
      { seq: 3, duplicate: false },
      { seq: 3, duplicate: true },
    ]);
  } finally {
    await p.stop();
    await f.cleanup();
  }
});

test("Codex settings readback mismatch and receipt write failure never send a prompt", async () => {
  for (const fault of ["mismatch", "write"] as const) {
    const dir = await mkdtemp(resolve(tmpdir(), "codex-prompt-watch-"));
    const promptLog = resolve(dir, "prompt.txt");
    const f = await fixture(undefined, {
      FAKE_SETTINGS_MISMATCH: fault === "mismatch" ? "1" : "0",
      FAKE_PROMPT_LOG: promptLog,
    });
    const p = await f.build();
    try {
      const save = p.store.saveRun.bind(p.store);
      let failedWrite = false;
      if (fault === "write")
        p.store.saveRun = (run) => {
          if (run.settingsReceipt && !failedWrite) {
            failedWrite = true;
            throw new Error("settings receipt write failed");
          }
          return save(run);
        };
      const { taskId } = p.service.publish({
        title: "Fault",
        description: "[settings-check]",
        publisherName: "Test",
        targetHarness: "Codex",
        requestedSettings: { modelId: "B" },
      });
      if (fault === "write") {
        await until(
          async () => failedWrite,
          (value) => value,
        );
        const run = p.store.detail(taskId)?.runs[0];
        assert.ok(run);
        assert.equal(run.settingsReceipt, undefined);
        const lease = p.store.lease(run.id);
        assert.ok(lease);
        assert.equal(lease.seq, 2);
        p.store.saveLease(
          run.id,
          lease.ownerId,
          lease.claimId,
          Date.now() - 1,
          lease.seq,
        );
        p.service.sweep();
      }
      const run = await until(
        async () => p.store.detail(taskId)?.runs[0],
        (value) => Boolean(value?.endedAt),
      );
      assert.equal(
        run?.status,
        fault === "mismatch" ? "failed" : "interrupted",
      );
      if (fault === "mismatch") {
        assert.equal(run?.settingsReceipt?.status, "rejected");
        assert.match(run?.settingsReceipt?.reason ?? "", /回读值/);
      }
      await assert.rejects(readFile(promptLog), { code: "ENOENT" });
    } finally {
      await p.stop();
      await f.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("Codex primary usage is separate from context and quota aliases on the real connector", async () => {
  const f = await fixture();
  const p = await f.build();
  try {
    const execute = async (extra: string) => {
      const { taskId } = p.service.publish({
        title: "Meter",
        description: `[usage-check] ${extra}`,
        publisherName: "Test",
        targetHarness: "Codex",
      });
      return await until(
        async () => p.store.detail(taskId),
        (detail) => Boolean(detail?.runs[0]?.endedAt),
      );
    };
    const detail = await execute("");
    const run = detail?.runs[0];
    assert.equal(run?.status, "succeeded");
    assert.equal(run?.usage?.totalTokens, 28);
    assert.equal(run?.usage?.uncachedInputTokens, 13);
    assert.equal(run?.usage?.cachedReadTokens, 8);
    assert.equal(run?.usage?.cachedWriteTokens, 0);
    assert.equal(run?.usage?.outputTokens, 7);
    assert.equal(run?.usage?.reasoningTokens, 2);
    assert.equal(run?.usage?.coverage, "complete");
    assert.equal(run?.context?.usedTokens, 10);
    assert.equal(run?.context?.effectiveWindowTokens, 76000);
    assert.deepEqual(
      p.store
        .runAudit(run?.id ?? "", 0, LIMITS.list)
        .map(
          (entry) => entry.kind === "context" && entry.observation.usedTokens,
        ),
      [28, 10],
    );
    const mismatch = (await execute("[mismatch]"))?.runs[0]?.usage;
    assert.equal(mismatch?.totalTokens, 29);
    assert.equal(mismatch?.inconsistent, true);
    const alias = (await execute("[alias-only]"))?.runs[0]?.usage;
    assert.equal(alias?.coverage, "missing");
    assert.equal(alias?.totalTokens, null);
    assert.match(alias?.missingReason ?? "", /quota/);
  } finally {
    await p.stop();
    await f.cleanup();
  }
});

test("Codex cancellation preserves Usage returned by the original prompt within grace", async () => {
  const f = await fixture();
  const p = await f.build();
  try {
    const { taskId } = p.service.publish({
      title: "Cancel",
      description: "[cancel-usage]",
      publisherName: "Test",
      targetHarness: "Codex",
    });
    await until(
      async () => p.store.detail(taskId)?.runs[0]?.output,
      (value) => value === "waiting for cancellation",
    );
    assert.equal((await p.api(`/tasks/${taskId}/cancel`, {})).status, 200);
    const run = await until(
      async () => p.store.detail(taskId)?.runs[0],
      (value) => Boolean(value?.endedAt),
    );
    assert.equal(run?.status, "cancelled");
    assert.equal(run?.usage?.totalTokens, 5);
    assert.equal(run?.usage?.source.sessionId, run?.sessionId);
  } finally {
    await p.stop();
    await f.cleanup();
  }
});

test("Codex terminal usage rolls back and task totals deduplicate retries and mark missing reports", async () => {
  const f = await fixture();
  const p = createPlatform({
    dbPath: resolve(f.dir, "tasks.sqlite"),
    workspace: f.dir,
  });
  try {
    const ownerId = randomUUID();
    p.service.registerHarness({ ownerId, harnessName: "Codex" });
    const { taskId } = p.service.publish({
      title: "Retries",
      description: "test",
      publisherName: "Test",
      targetHarness: "Codex",
    });
    const start = (sessionId: string) => {
      const owner = { ownerId, claimId: randomUUID() };
      const { run } = p.service.claim(taskId, owner);
      p.service.report(run.id, owner, 1, { type: "session", sessionId });
      p.service.report(run.id, owner, 2, {
        type: "settings",
        sessionId,
        receipt: {
          status: "default",
          modelId: "A",
          reasoningEffort: "medium",
          confirmedAt: new Date().toISOString(),
          reason: null,
          modelWindow: null,
        },
      });
      return { id: run.id, owner };
    };
    const finished = (sessionId: string, totalTokens: number | null) =>
      ({
        type: "finished",
        status: "failed",
        stopReason: null,
        error: "retry",
        usage: {
          scope: "primary_prompt",
          basis: "token_breakdown_v1",
          coverage: totalTokens === null ? "missing" : "partial",
          modelId: "A",
          inconsistent: false,
          totalTokens,
          uncachedInputTokens: null,
          cachedReadTokens: null,
          cachedWriteTokens: null,
          outputTokens: null,
          reasoningTokens: null,
          source: {
            wireFormat: "codex_acp_prompt_v1",
            adapterVersion: "test",
            protocolVersion: 1,
            method: "session/prompt",
            fieldPath: "result.usage",
            sessionId,
          },
        },
      }) as const;
    const a = start("a");
    assert.throws(
      () => p.service.report(a.id, a.owner, 3, finished("other", 28)),
      /不属于/,
    );
    const save = p.store.saveTask.bind(p.store);
    p.store.saveTask = () => {
      throw new Error("terminal task write failed");
    };
    assert.throws(
      () => p.service.report(a.id, a.owner, 3, finished("a", 28)),
      /terminal task write failed/,
    );
    assert.equal(p.store.run(a.id)?.usage, undefined);
    assert.equal(p.store.lease(a.id)?.seq, 2);
    p.store.saveTask = save;
    p.service.report(a.id, a.owner, 3, finished("a", 28));
    p.service.retry(taskId);
    const b = start("b");
    p.service.report(b.id, b.owner, 3, finished("b", 40));
    assert.equal(
      p.service.report(b.id, b.owner, 3, finished("b", 40)).duplicate,
      true,
    );
    assert.throws(
      () => p.service.report(b.id, b.owner, 4, finished("b", 100)),
      /失效/,
    );
    p.service.retry(taskId);
    const c = start("c");
    p.service.report(c.id, c.owner, 3, finished("c", null));
    const detail = p.store.detail(taskId);
    assert.deepEqual(
      detail?.runs.map((run) => run.usage?.totalTokens),
      [null, 40, 28],
    );
    assert.equal(detail?.usageSummary?.totalTokens, 68);
    assert.equal(detail?.usageSummary?.coverage, "partial");
    assert.deepEqual(
      p.store.detail(taskId)?.usageSummary,
      detail?.usageSummary,
    );
    p.service.retry(taskId);
    const d = start("d");
    p.service.report(d.id, d.owner, 3, finished("d", Number.MAX_SAFE_INTEGER));
    const overflow = p.store.detail(taskId)?.usageSummary;
    assert.equal(overflow?.totalTokens, null);
    assert.deepEqual(overflow?.overflow, ["totalTokens"]);
  } finally {
    await p.service.close();
    p.store.close();
    await f.cleanup();
  }
});

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
    assert.equal(stopped.runs[0].usage?.coverage, "missing");
  } finally {
    await p.stop();
    await f.cleanup();
  }
});
