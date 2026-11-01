import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createPlatform } from "../src/server/http.js";
import { subscribe, post } from "../src/connector/transport.js";
import {
  claimResultSchema,
  publishResultSchema,
} from "../src/shared/protocol.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "mingting-routing-"));
  const p = createPlatform({
    dbPath: join(dir, "tasks.sqlite"),
    workspace: dir,
    mode: "fake",
  });
  const server = createServer(p.app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing address");
  const base = `http://127.0.0.1:${address.port}`;
  const controllers: AbortController[] = [];
  const connect = async (harnessName: string, ownerId = randomUUID()) => {
    const stop = new AbortController();
    controllers.push(stop);
    const response = await fetch(base + "/connector/events", {
      headers: { "x-harness-name": harnessName, "x-owner-id": ownerId },
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
      name: "publish_task",
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
