import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createPlatform } from "../src/server/transport/http.js";
import { subscribe, post } from "../src/connector/transport.js";
import {
  claimResultSchema,
  heartbeatResultSchema,
  LIMITS,
  publishResultSchema,
} from "../src/shared/protocol.js";

async function fixture(configPath?: string) {
  const dir = await mkdtemp(join(tmpdir(), "mingting-routing-"));
  const p = createPlatform({
    dbPath: join(dir, "tasks.sqlite"),
    workspace: dir,
    mode: "fake",
    configPath,
  });
  const server = createServer(p.app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing address");
  const base = `http://127.0.0.1:${address.port}`;
  const controllers: AbortController[] = [];
  const connect = async (
    harnessName: string,
    ownerId = randomUUID(),
    generation?: string,
  ) => {
    const stop = new AbortController();
    controllers.push(stop);
    const response = await fetch(base + "/connector/events", {
      headers: {
        "x-harness-name": harnessName,
        "x-owner-id": ownerId,
        ...(generation ? { "x-connector-generation": generation } : {}),
      },
      signal: stop.signal,
    });
    return { response, stop, ownerId };
  };
  return {
    ...p,
    base,
    connect,
    controllers,
    close: async () => {
      controllers.forEach((c) => c.abort());
      await p.service.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      p.store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("KMH frame policy allows one loopback origin while retaining request guards", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mingting-frame-policy-"));
  const configPath = join(dir, "config.yaml");
  try {
    for (const frameAncestor of [undefined, "http://127.0.0.1:60000"]) {
      await writeFile(
        configPath,
        JSON.stringify({
          tasks: { wakeupResultTextLimit: 5000 },
          ...(frameAncestor && { web: { frameAncestor } }),
        }),
      );
      const p = await fixture(configPath);
      try {
        const page = await fetch(p.base, { method: "HEAD" });
        const policy = page.headers.get("content-security-policy");
        assert.equal(
          policy?.split("; ").at(-1),
          `frame-ancestors ${frameAncestor ?? "'none'"}`,
        );
        for (const headers of [
          new Headers({ origin: "http://127.0.0.1:60000" }),
          new Headers({ "sec-fetch-site": "cross-site" }),
        ]) {
          const response = await fetch(p.base + "/api/bootstrap", { headers });
          assert.equal(response.status, 403);
          await response.body?.cancel();
        }
      } finally {
        await p.close();
      }
    }

    await writeFile(
      configPath,
      JSON.stringify({
        tasks: { wakeupResultTextLimit: 5000 },
        web: { frameAncestor: "https://example.com" },
      }),
    );
    assert.throws(
      () => createPlatform({ dbPath: ":memory:", workspace: dir, configPath }),
      /web.frameAncestor/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex capability snapshots are scoped to the current SSE connection generation", async () => {
  const p = await fixture();
  try {
    const ownerId = randomUUID();
    const generation = randomUUID();
    const first = await p.connect("Codex", ownerId, generation);
    const snapshot = {
      models: [
        {
          id: "A",
          name: "Model A",
          efforts: [{ id: "medium", name: "Medium" }],
        },
        { id: "B", name: "Model B", efforts: [{ id: "high", name: "High" }] },
      ],
      defaultModelId: "A",
      source: "acp_session_config",
    };
    const update = (gen: string, capabilities: unknown, origin?: string) =>
      fetch(p.base + "/connector/capabilities", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify({ ownerId, generation: gen, capabilities }),
      });
    assert.equal((await update(generation, snapshot)).status, 200);
    assert.deepEqual(p.service.harnesses()[0]?.capabilities, snapshot);
    assert.equal((await update(generation, snapshot, p.base)).status, 403);
    assert.equal(
      (
        await update(generation, {
          ...snapshot,
          models: Array(LIMITS.list + 1).fill(snapshot.models[0]),
        })
      ).status,
      400,
    );
    const next = randomUUID();
    const second = await p.connect("Codex", ownerId, next);
    assert.equal(p.service.harnesses()[0]?.capabilities, undefined);
    assert.equal((await update(generation, snapshot)).status, 409);
    assert.equal((await update(next, snapshot)).status, 200);
    first.stop.abort();
    assert.deepEqual(p.service.harnesses()[0]?.capabilities, snapshot);
    second.stop.abort();
  } finally {
    await p.close();
  }
});

test("T1 identity is bound to live SSE connections, duplicate connections and conflicts", async () => {
  const p = await fixture();
  try {
    const one = await p.connect("Codex");
    assert.equal(one.response.status, 200);
    const two = await p.connect("Codex", one.ownerId);
    assert.equal(two.response.status, 200);
    assert.equal(p.service.harnesses().length, 1);
    const wrong = await p.connect("Grok", one.ownerId);
    assert.equal(wrong.response.status, 409);
    one.stop.abort();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(p.service.harnesses().length, 1);
    two.stop.abort();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(p.service.harnesses().length, 0);
  } finally {
    await p.close();
  }
});

test("T2/T3 target stays queued while offline, wrong owners fail, late target gets history and records identity", async () => {
  const p = await fixture();
  try {
    const codex = await p.connect("Codex");
    const { taskId } = p.service.publish({
      title: "你好",
      description: "一句问候",
      publisherName: "test",
      targetHarness: "ZCode",
    });
    const claimId = randomUUID();
    const wrong = await fetch(p.base + "/connector/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId, ownerId: codex.ownerId, claimId }),
    });
    assert.equal(wrong.status, 403);
    const anon = await fetch(p.base + "/connector/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId,
        ownerId: randomUUID(),
        claimId: randomUUID(),
      }),
    });
    assert.equal(anon.status, 403);
    assert.equal(p.store.task(taskId)?.status, "queued");
    const stop = new AbortController();
    p.controllers.push(stop);
    const ownerId = randomUUID();
    const stream = subscribe(p.base, 0, stop.signal, {
      ownerId,
      harnessName: "zcode",
    });
    const event = await stream.next();
    assert.equal(event.value?.taskId, taskId);
    const claim = claimResultSchema.parse(
      await post(p.base, "/connector/claim", { taskId, ownerId, claimId }),
    );
    assert.equal(claim.run.harnessName, "zcode");
    await post(p.base, `/connector/runs/${claim.run.id}/report`, {
      ownerId,
      claimId,
      seq: 1,
      update: {
        type: "finished",
        status: "succeeded",
        stopReason: "end_turn",
        error: null,
      },
    });
    assert.equal(p.store.task(taskId)?.status, "succeeded");
    stop.abort();
    await stream.return(undefined);
  } finally {
    await p.close();
  }
});

test("T4 HTTP MCP publishes target and lists online identities; filtered replay advances over other targets", async () => {
  const p = await fixture();
  const client = new Client({ name: "OtherHarness", version: "1" });
  try {
    const codex = await p.connect("Codex");
    await client.connect(
      new StreamableHTTPClientTransport(new URL(p.base + "/mcp")),
    );
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === "list_harnesses"));
    const listed = await client.callTool({
      name: "list_harnesses",
      arguments: {},
    });
    assert.match(JSON.stringify(listed.structuredContent), /Codex/);
    assert.match(
      JSON.stringify(listed.structuredContent),
      new RegExp(codex.ownerId),
    );
    for (let i = 0; i < 201; i++) {
      // Replay pagination must advance across filtered notifications.
      const task = p.store.publish({
        title: "other",
        description: "hi",
        publisherName: "test",
        targetHarness: "ZCode",
      });
      task.status = "succeeded";
      p.store.saveTask(task);
      p.store.deliver(task.id);
    }
    const published = await client.callTool({
      name: "mcp-mingting-tool",
      arguments: {
        title: "Codex hello",
        description: "hi",
        publisherName: "OtherHarness",
        targetHarness: "Codex",
      },
    });
    const { taskId } = publishResultSchema.parse(published.structuredContent);
    const stop = new AbortController();
    p.controllers.push(stop);
    const stream = subscribe(p.base, 0, stop.signal, {
      ownerId: randomUUID(),
      harnessName: "Codex",
    });
    const event = await stream.next();
    assert.equal(event.value?.taskId, taskId);
    stop.abort();
    await stream.return(undefined);
  } finally {
    await client.close();
    await p.close();
  }
});

test("B4 三类实时订阅达到各自上限时，运行仍能续租和回报终态", async () => {
  // 2026-11-07 全仓检查中，执行器、发起方和网页各开 8 条 SSE，24 条连接均成功。
  // 合法心跳随后得到 429，任务在 8 秒租约过期后变为 interrupted。
  const p = await fixture();
  const client = new Client({
    name: "review-subscription-budget",
    version: "1",
  });
  const streams = new AbortController();
  p.controllers.push(streams);
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(p.base + "/mcp")),
    );
    const published = await client.callTool({
      name: "mcp-mingting-tool",
      arguments: {
        title: "检查订阅配额",
        description: "检查长连接达到上限时的运行控制请求",
        publisherName: "test",
        targetHarness: "Codex",
      },
    });
    assert.notEqual(published.isError, true);
    const receipt = publishResultSchema.parse(published.structuredContent);
    const bootstrap = await fetch(p.base + "/api/bootstrap");
    assert.equal(bootstrap.status, 200);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    await bootstrap.json();

    const executor = await p.connect("Codex");
    assert.equal(executor.response.status, 200);
    const owner = { ownerId: executor.ownerId, claimId: randomUUID() };
    const { run } = claimResultSchema.parse(
      await post(p.base, "/connector/claim", {
        ...owner,
        taskId: receipt.taskId,
      }),
    );
    const signal = AbortSignal.any([streams.signal, AbortSignal.timeout(6000)]);
    const subscriptions = await Promise.all([
      ...Array.from({ length: LIMITS.subscribers - 1 }, () =>
        fetch(p.base + "/connector/events", { signal }),
      ),
      ...Array.from({ length: LIMITS.subscribers }, () =>
        fetch(
          p.base + `/subscriber/events?taskId=${receipt.taskId}&view=result`,
          {
            headers: {
              authorization: `Bearer ${receipt.resultSubscription.subscriptionToken}`,
            },
            signal,
          },
        ),
      ),
      ...Array.from({ length: LIMITS.browserSubscribers }, () =>
        fetch(p.base + "/api/events", { headers: { cookie }, signal }),
      ),
    ]);
    for (const stream of subscriptions) {
      assert.equal(stream.status, 200, `订阅未建立 ${stream.url}`);
      assert.match(
        stream.headers.get("content-type") ?? "",
        /^text\/event-stream/,
      );
    }
    const heartbeat = heartbeatResultSchema.parse(
      await post(p.base, `/connector/runs/${run.id}/heartbeat`, owner),
    );
    assert.equal(heartbeat.status, "running");
    await post(p.base, `/connector/runs/${run.id}/report`, {
      ...owner,
      seq: 1,
      update: {
        type: "finished",
        status: "succeeded",
        stopReason: "end_turn",
        error: null,
      },
    });
    assert.equal(p.store.task(receipt.taskId)?.status, "succeeded");
  } finally {
    streams.abort();
    await client.close();
    await p.close();
  }
});
