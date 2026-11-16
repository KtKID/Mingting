import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { createPlatform } from "../src/server/transport/http.js";
import { CodexAdapter } from "../src/server/harness/codex/codex-adapter.js";
import { TaskConnector } from "../src/connector/connector.js";
import { approvalPrompt, approvalOption } from "../src/shared/approval.js";
import {
  LIMITS,
  approvalSnapshotSchema,
  publishResultSchema,
  detailSchema,
} from "../src/shared/protocol.js";

const request = (sessionId: string): RequestPermissionRequest => ({
  sessionId,
  toolCall: {
    toolCallId: randomUUID(),
    title: "删除临时文件",
    rawInput: { command: "rm ./tmp/example.txt" },
  },
  _meta: {
    "mingting.dev/approval": {
      title: "清理临时文件",
      description: "删除工作区中的 tmp/example.txt。",
    },
  },
  options: [
    { optionId: "yes", name: "允许本次操作", kind: "allow_once" },
    { optionId: "no", name: "拒绝本次操作", kind: "reject_once" },
  ],
});
async function fixture(approvalWaitMs?: number | "legacy") {
  const dir = await mkdtemp(resolve(tmpdir(), "mingting-approvals-"));
  const configPath =
    approvalWaitMs === undefined ? undefined : resolve(dir, "config.yaml");
  if (configPath)
    await writeFile(
      configPath,
      `tasks:\n  wakeupResultTextLimit: 5000\n${typeof approvalWaitMs === "number" ? `  approvalWaitMs: ${approvalWaitMs}\n` : ""}`,
    );
  const p = createPlatform({
    dbPath: resolve(dir, "tasks.sqlite"),
    workspace: dir,
    mode: "fake",
    configPath,
  });
  const server = createServer(p.app);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing address");
  const base = `http://127.0.0.1:${address.port}`;
  const prepare = () => {
    const published = p.service.publish({
      title: "文件整理",
      description: "测试",
      publisherName: "Codex",
      targetHarness: "Codex",
    });
    const subscription = published.approvalSubscription;
    if (!subscription) throw new Error("missing subscription");
    const owner = { ownerId: randomUUID(), claimId: randomUUID() };
    p.service.registerHarness({ ownerId: owner.ownerId, harnessName: "Codex" });
    const { run } = p.service.claim(published.taskId, owner);
    p.service.report(run.id, owner, 1, {
      type: "session",
      sessionId: "session",
    });
    const { approvalId } = p.service.permission(
      run.id,
      owner,
      "permission-1",
      request("session"),
    );
    const choice = (optionId: string) => ({
      runId: run.id,
      sessionId: "session",
      optionId,
    });
    const review = (optionId: string) => ({
      ...subscription,
      approvalId,
      ...choice(optionId),
    });
    const approval = () => {
      const a = p.store.approval(approvalId);
      if (!a) throw new Error("missing approval");
      return a;
    };
    return {
      ...published,
      subscription,
      owner,
      run,
      approvalId,
      choice,
      review,
      approval,
    };
  };
  return {
    ...p,
    dir,
    base,
    prepare,
    close: async () => {
      await p.service.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      p.store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
function deadline(value: string | null) {
  if (!value) throw new Error("missing deadline");
  return Date.parse(value);
}

test("P1 publisher receives private task-scoped subscription; targets support user-only and reject unfinished providers", async () => {
  const p = await fixture();
  try {
    const a = p.prepare();
    assert.deepEqual(p.store.task(a.taskId)?.approvalTargets, ["subscriber"]);
    assert.doesNotMatch(
      JSON.stringify(p.store.detail(a.taskId)),
      new RegExp(a.subscription.subscriptionToken),
    );
    assert.doesNotMatch(JSON.stringify(p.store.list()), /subscriptionToken/);
    assert.throws(
      () =>
        p.service.approvalSnapshot({
          ...a.subscription,
          subscriptionToken: "0".repeat(64),
        }),
      /凭据无效/,
    );
    const userOnly = p.service.publish({
      title: "用户审批",
      description: "test",
      publisherName: "web",
      approvalTargets: [],
    });
    assert.equal(userOnly.approvalSubscription, undefined);
    assert.deepEqual(p.store.task(userOnly.taskId)?.approvalTargets, []);
    const before = p.store.list().length;
    assert.throws(
      () =>
        p.service.publish({
          title: "后续",
          description: "test",
          publisherName: "Codex",
          approvalTargets: ["subscriber", "third_party"],
        }),
      /开发中/,
    );
    assert.equal(p.store.list().length, before);
  } finally {
    await p.close();
  }
});

for (const optionId of ["yes", "no"]) {
  test(`P2 subscriber ${optionId} waits exactly 10s; duplicate preserves deadline and one ACP result`, async () => {
    const p = await fixture();
    try {
      const a = p.prepare();
      const before = Date.now();
      p.service.decideSubscriber(a.review(optionId));
      const stored = a.approval();
      const at = deadline(stored.fallbackAt);
      assert.ok(at >= before + 10000 && at <= Date.now() + 10000);
      assert.equal(stored.status, "pending");
      assert.equal(stored.userDecision, null);
      p.service.decideSubscriber(a.review(optionId));
      assert.equal(a.approval().fallbackAt, stored.fallbackAt);
      assert.equal(a.approval().reviewerDecisions.length, 1);
      assert.throws(
        () =>
          p.service.decideSubscriber(
            a.review(optionId === "yes" ? "no" : "yes"),
          ),
        /已提交/,
      );
      assert.equal(
        p.service.permissionResult(a.run.id, a.owner, a.approvalId).status,
        "pending",
      );
      // Keep the real ownership fence alive across the synthetic sweep boundary.
      p.store.saveLease(
        a.run.id,
        a.owner.ownerId,
        a.owner.claimId,
        at + 1000,
        1,
      );
      p.service.sweep(at - 1);
      assert.equal(a.approval().status, "pending");
      p.service.sweep(at);
      assert.equal(a.approval().resolvedBy, "subscriber");
      assert.equal(a.approval().userDecision, null);
      assert.equal(p.store.task(a.taskId)?.status, "running");
      assert.deepEqual(
        p.service.permissionResult(a.run.id, a.owner, a.approvalId),
        {
          status: "resolved",
          response: { outcome: { outcome: "selected", optionId } },
        },
      );
      p.service.sweep(at + 1);
      assert.equal(a.approval().optionId, optionId);
      assert.throws(
        () => p.service.decide(a.approvalId, a.choice("yes")),
        /失效/,
      );
    } finally {
      await p.close();
    }
  });
}

for (const subscriber of ["yes", "no"]) {
  for (const user of ["yes", "no"]) {
    test(`P3 user ${user} immediately wins over subscriber ${subscriber}`, async () => {
      const p = await fixture();
      try {
        const a = p.prepare();
        p.service.decideSubscriber(a.review(subscriber));
        p.service.decide(a.approvalId, a.choice(user));
        const actual = a.approval();
        assert.equal(actual.status, "decided");
        assert.equal(actual.optionId, user);
        assert.equal(actual.userDecision?.optionId, user);
        assert.equal(actual.reviewerDecisions[0]?.optionId, subscriber);
        assert.equal(actual.resolvedBy, "user");
        assert.throws(
          () => p.service.decideSubscriber(a.review(subscriber)),
          /失效/,
        );
      } finally {
        await p.close();
      }
    });
  }
}

test("P4 user-first decision is final; other task credentials and invalid option/session fail", async () => {
  const p = await fixture();
  try {
    const a = p.prepare();
    const other = p.service.publish({
      title: "其他任务",
      description: "test",
      publisherName: "Codex",
    }).approvalSubscription;
    if (!other) throw new Error("missing subscription");
    assert.throws(
      () => p.service.decideSubscriber({ ...a.review("yes"), ...other }),
      /订阅任务/,
    );
    assert.throws(
      () =>
        p.service.decideSubscriber({ ...a.review("yes"), optionId: "unknown" }),
      /选项无效/,
    );
    assert.throws(
      () =>
        p.service.decideSubscriber({ ...a.review("yes"), sessionId: "wrong" }),
      /失效/,
    );
    p.service.decide(a.approvalId, a.choice("no"));
    assert.equal(a.approval().resolvedBy, "user");
    assert.equal(a.approval().optionId, "no");
    assert.ok(a.approval().resolvedAt, "persist final decision time");
    assert.deepEqual(
      p.service.permissionResult(a.run.id, a.owner, a.approvalId),
      {
        status: "resolved",
        response: { outcome: { outcome: "selected", optionId: "no" } },
      },
    );
    assert.deepEqual(a.approval().reviewerDecisions, []);
    assert.equal(a.approval().fallbackAt, null);
    assert.throws(() => p.service.decideSubscriber(a.review("yes")), /失效/);
  } finally {
    await p.close();
  }
});

test("P5 deadline is enforced on user submission before a timer sweep runs", async () => {
  const p = await fixture();
  try {
    const a = p.prepare();
    p.service.decideSubscriber(a.review("no"));
    const stored = a.approval();
    stored.fallbackAt = new Date(Date.now() - 1).toISOString();
    p.store.saveApproval(stored);
    assert.throws(
      () => p.service.decide(a.approvalId, a.choice("yes")),
      /失效/,
    );
    assert.equal(a.approval().optionId, "no");
    assert.equal(a.approval().resolvedBy, "subscriber");
  } finally {
    await p.close();
  }
});

test("AR5 subscriber timestamp and deadline share one clock reading", async (context) => {
  const p = await fixture();
  try {
    const a = p.prepare();
    const clock = Date.now() + 500;
    context.mock.method(Date, "now", () => clock);
    p.service.decideSubscriber(a.review("yes"));
    const approval = a.approval();
    assert.equal(
      Date.parse(approval.reviewerDecisions[0]?.decidedAt ?? ""),
      clock,
    );
    assert.equal(
      Date.parse(approval.fallbackAt ?? ""),
      clock + LIMITS.approvalGraceMs,
    );
  } finally {
    context.mock.restoreAll();
    await p.close();
  }
});

test("P6 independent requests retain separate clocks; approval timeout leaves a full user grace window", async () => {
  const p = await fixture();
  try {
    const a = p.prepare();
    const { approvalId: second } = p.service.permission(
      a.run.id,
      a.owner,
      "permission-2",
      request("session"),
    );
    const aged = a.approval();
    // Leave time for SQLite I/O before the vote; the sweep still crosses expiry.
    aged.createdAt = new Date(
      Date.now() - LIMITS.approvalMs + 1000,
    ).toISOString();
    p.store.saveApproval(aged);
    p.service.decideSubscriber(a.review("yes"));
    const at = deadline(a.approval().fallbackAt);
    p.store.saveLease(a.run.id, a.owner.ownerId, a.owner.claimId, at + 1000, 1);
    p.service.sweep(at - 1);
    assert.equal(a.approval().status, "pending");
    assert.equal(p.store.approval(second)?.fallbackAt, null);
    p.service.sweep(at);
    assert.equal(a.approval().status, "decided");
    assert.equal(p.store.task(a.taskId)?.status, "awaiting_approval");
    p.service.decide(second, a.choice("no"));
    assert.equal(p.store.task(a.taskId)?.status, "running");
  } finally {
    await p.close();
  }
});

for (const failure of ["cancel", "lease", "restart"] as const) {
  test(`P7 ${failure} expires countdown while preserving decision history`, async () => {
    const p = await fixture();
    try {
      const a = p.prepare();
      p.service.decideSubscriber(a.review("yes"));
      if (failure === "cancel") p.service.cancel(a.taskId);
      if (failure === "lease") p.service.sweep(Date.now() + LIMITS.leaseMs + 1);
      if (failure === "restart") p.store.recover();
      assert.equal(a.approval().status, "expired");
      assert.equal(a.approval().resolvedBy, null);
      assert.equal(a.approval().reviewerDecisions[0]?.optionId, "yes");
      p.service.sweep(deadline(a.approval().fallbackAt));
      assert.equal(a.approval().optionId, null);
      assert.throws(() => p.service.decideSubscriber(a.review("yes")), /失效/);
    } finally {
      await p.close();
    }
  });
}

test("P8 HTTP approval subscription snapshots notify, reconnect and isolate credentials from browser and executor", async () => {
  const p = await fixture();
  const controller = new AbortController();
  try {
    const a = p.prepare();
    const response = await fetch(
      `${p.base}/subscriber/events?taskId=${a.taskId}`,
      {
        headers: {
          authorization: `Bearer ${a.subscription.subscriptionToken}`,
        },
        signal: controller.signal,
      },
    );
    assert.equal(response.status, 200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing body");
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /approval.snapshot/);
    assert.match(first, /清理临时文件/);
    assert.doesNotMatch(first, /subscriptionToken/);
    const post = (body: unknown, headers = {}) =>
      fetch(p.base + "/subscriber/decision", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    assert.equal((await post(a.review("yes"), { origin: p.base })).status, 403);
    assert.equal(
      (await post({ ...a.review("yes"), subscriptionToken: "0".repeat(64) }))
        .status,
      403,
    );
    assert.equal((await post(a.review("yes"))).status, 200);
    const changed = new TextDecoder().decode((await reader.read()).value);
    assert.match(changed, /fallbackAt/);
    assert.match(changed, /"target":"subscriber"/);
    controller.abort();
    const replay = await p.service.waitForApproval(a.subscription, 0);
    assert.equal(replay.approvals[0]?.reviewerDecisions[0]?.optionId, "yes");
    const boot = await fetch(p.base + "/api/bootstrap");
    const cookie = boot.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("missing cookie");
    const browserStop = new AbortController();
    const browser = await fetch(p.base + "/api/events", {
      headers: { cookie },
      signal: browserStop.signal,
    });
    const browserReader = browser.body?.getReader();
    if (!browserReader) throw new Error("missing body");
    const snapshot = new TextDecoder().decode(
      (await browserReader.read()).value,
    );
    assert.match(snapshot, /"pendingApprovals":\[\{/);
    assert.doesNotMatch(snapshot, /subscriptionToken/);
    browserStop.abort();
  } finally {
    controller.abort();
    await p.close();
  }
});

test("P9 publisher MCP waits before ACP permission, reviews it and yields to user choice", async () => {
  const p = await fixture();
  const client = new Client({ name: "publisher-Codex", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(p.base + "/mcp")),
    );
    const published = await client.callTool({
      name: "mcp-mingting-tool",
      arguments: {
        title: "MCP 审批",
        description: "test",
        publisherName: "Codex",
        targetHarness: "Codex",
        approvalTargets: ["subscriber"],
      },
    });
    const { taskId, approvalSubscription } = publishResultSchema.parse(
      published.structuredContent,
    );
    if (!approvalSubscription) throw new Error("missing subscription");
    const waiting = client.callTool({
      name: "wait_for_approval",
      arguments: approvalSubscription,
    });
    const owner = { ownerId: randomUUID(), claimId: randomUUID() };
    p.service.registerHarness({ ownerId: owner.ownerId, harnessName: "Codex" });
    const { run } = p.service.claim(taskId, owner);
    p.service.report(run.id, owner, 1, {
      type: "session",
      sessionId: "mcp-session",
    });
    const { approvalId } = p.service.permission(
      run.id,
      owner,
      1,
      request("mcp-session"),
    );
    const received = await waiting;
    const snapshot = approvalSnapshotSchema.parse(received.structuredContent);
    assert.equal(snapshot.approvals[0]?.id, approvalId);
    assert.deepEqual(snapshot.approvals[0]?.prompt, {
      title: "清理临时文件",
      description: "删除工作区中的 tmp/example.txt。",
    });
    assert.equal(
      approvalPrompt(snapshot.approvals[0]?.request ?? request("s"))
        .description,
      "删除工作区中的 tmp/example.txt。",
    );
    const choice = { runId: run.id, sessionId: "mcp-session", optionId: "yes" };
    const result = await client.callTool({
      name: "submit_approval_decision",
      arguments: { ...approvalSubscription, approvalId, ...choice },
    });
    assert.notEqual(result.isError, true);
    assert.equal(
      p.service.permissionResult(run.id, owner, approvalId).status,
      "pending",
    );
    p.service.decide(approvalId, { ...choice, optionId: "no" });
    assert.deepEqual(p.service.permissionResult(run.id, owner, approvalId), {
      status: "resolved",
      response: { outcome: { outcome: "selected", optionId: "no" } },
    });
  } finally {
    await client.close();
    await p.close();
  }
});

for (const [configuredWait, expectedWait] of [
  ["legacy", 25_000],
  [80, 80],
] as const) {
  test(`审批等待配置 ${configuredWait} 同时决定 MCP 的默认值和最大值`, async () => {
    // 检查发现 MCP 把等待上限和默认值写死为 25 秒。旧 YAML 应继续用 25 秒，显式配置应同时改变发现和执行。
    const p = await fixture(configuredWait);
    const client = new Client({ name: "approval-wait-config", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(p.base + "/mcp")),
      );
      const tool = (await client.listTools()).tools.find(
        (entry) => entry.name === "wait_for_approval",
      );
      assert.ok(tool);
      const bounds = z
        .object({ maximum: z.number(), default: z.number() })
        .parse(tool.inputSchema.properties?.waitMs);
      assert.deepEqual(bounds, {
        maximum: expectedWait,
        default: expectedWait,
      });
      assert.ok(
        tool.description
          ?.replace(/\s+/g, "")
          .includes(`${expectedWait / 1000}秒`),
      );

      const published = await client.callTool({
        name: "mcp-mingting-tool",
        arguments: {
          title: "等待审批",
          description: "测试配置边界",
          publisherName: "test",
          targetHarness: "Codex",
        },
      });
      const receipt = publishResultSchema.parse(published.structuredContent);
      const subscription = receipt.approvalSubscription;
      assert.ok(subscription);
      const owner = { ownerId: randomUUID(), claimId: randomUUID() };
      p.service.registerHarness({
        ownerId: owner.ownerId,
        harnessName: "Codex",
      });
      const { run } = p.service.claim(receipt.taskId, owner);
      p.service.report(run.id, owner, 1, {
        type: "session",
        sessionId: "wait-config-session",
      });
      p.service.permission(run.id, owner, 1, request("wait-config-session"));
      for (const waitMs of [
        undefined,
        expectedWait - 1,
        expectedWait,
        expectedWait + 1,
      ]) {
        const result = await client.callTool({
          name: "wait_for_approval",
          arguments: {
            ...subscription,
            ...(waitMs === undefined ? {} : { waitMs }),
          },
        });
        if (waitMs === expectedWait + 1) assert.equal(result.isError, true);
        else
          assert.equal(
            approvalSnapshotSchema.parse(result.structuredContent).approvals
              .length,
            1,
          );
      }
      assert.deepEqual(
        p.store
          .communications(receipt.taskId)
          .entries.filter((entry) => entry.type === "approval.wait")
          .map((entry) => entry.content),
        [
          { waitMs: expectedWait },
          { waitMs: expectedWait - 1 },
          { waitMs: expectedWait },
        ],
      );
      if (configuredWait === "legacy") return;

      // 使用排队中的任务实测省略 waitMs 时会按配置超时返回快照。
      // 指向离线执行者让任务保持排队且不会产生审批。
      const queued = await client.callTool({
        name: "mcp-mingting-tool",
        arguments: {
          title: "无审批的排队任务",
          description: "等待窗口测试",
          publisherName: "test",
          targetHarness: "Offline",
        },
      });
      const queuedSubscription = publishResultSchema.parse(
        queued.structuredContent,
      ).approvalSubscription;
      assert.ok(queuedSubscription);
      const started = performance.now();
      const result = await client.callTool(
        { name: "wait_for_approval", arguments: queuedSubscription },
        undefined,
        { timeout: 2000 },
      );
      assert.equal(
        approvalSnapshotSchema.parse(result.structuredContent).taskStatus,
        "queued",
      );
      assert.ok(performance.now() - started >= expectedWait - 5);
    } finally {
      await client.close();
      await p.close();
    }
  });
}

test("P10 real ACP child waits on subscriber opinion and resumes with browser user's override", async () => {
  const p = await fixture();
  const adapter = new CodexAdapter({
    command: process.execPath,
    args: [
      "--import",
      import.meta.resolve("tsx"),
      resolve("tests/fake-acp.ts"),
    ],
    env: { PATH: process.env.PATH },
    workspace: p.dir,
    mode: "fake",
  });
  const connector = new TaskConnector(p.base, adapter);
  connector.start();
  try {
    const published = p.service.publish({
      title: "ACP 完整链路",
      description: "test",
      publisherName: "Codex",
      targetHarness: "Codex",
    });
    const subscription = published.approvalSubscription;
    if (!subscription) throw new Error("missing subscription");
    const snapshot = await p.service.waitForApproval(subscription, 5000);
    const approval = snapshot.approvals[0];
    if (!approval) throw new Error("missing approval");
    const choice = {
      runId: approval.runId,
      sessionId: approval.sessionId,
      optionId: "allow-once",
    };
    p.service.decideSubscriber({
      ...subscription,
      approvalId: approval.id,
      ...choice,
    });
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(p.store.task(published.taskId)?.status, "awaiting_approval");
    const boot = await fetch(p.base + "/api/bootstrap");
    const cookie = boot.headers.get("set-cookie")?.split(";")[0];
    const bootstrap = (await boot.json()) as unknown;
    const { bootstrapSchema } = await import("../src/shared/protocol.js");
    const { csrf } = bootstrapSchema.parse(bootstrap);
    if (!cookie) throw new Error("missing cookie");
    const decided = await fetch(
      `${p.base}/api/approvals/${approval.id}/decision`,
      {
        method: "POST",
        headers: {
          cookie,
          origin: p.base,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...choice, optionId: "reject-once" }),
      },
    );
    assert.equal(decided.status, 200);
    const end = Date.now() + 5000;
    while (
      p.store.task(published.taskId)?.status !== "succeeded" &&
      Date.now() < end
    )
      await new Promise((done) => setTimeout(done, 30));
    const detail = detailSchema.parse(p.store.detail(published.taskId));
    assert.equal(detail.task.status, "succeeded");
    assert.match(detail.runs[0]?.output ?? "", /selected:reject-once/);
    assert.equal(detail.approvals[0]?.resolvedBy, "user");
  } finally {
    await connector.close();
    await p.close();
  }
});

test("P11 ACP title/description metadata, raw context and one-time permission choices preserve scope", () => {
  const original = request("s");
  assert.equal(approvalPrompt(original).title, "清理临时文件");
  const plain = { ...original, _meta: undefined };
  assert.match(approvalPrompt(plain).description, /rm \.\/tmp\/example.txt/);
  const scoped: RequestPermissionRequest = {
    ...original,
    options: [
      { optionId: "always", name: "本会话全部文件", kind: "allow_always" },
      ...original.options,
    ],
  };
  assert.equal(approvalOption(scoped, "allow")?.optionId, "yes");
  assert.equal(approvalOption(scoped, "reject")?.optionId, "no");
  assert.deepEqual(
    approvalPrompt(
      { ...plain, toolCall: { toolCallId: "partial" } },
      {
        id: "partial",
        title: "读取原始请求标题",
        kind: "read",
        status: "pending",
        input: "./tmp/example.txt",
        output: "",
      },
    ),
    { title: "读取原始请求标题", description: "./tmp/example.txt" },
  );
});

test("P12 bounded approval waits release listeners and capacity on abort, timeout and shutdown", async () => {
  const p = await fixture();
  const controllers: AbortController[] = [];
  try {
    const subscription = p.service.publish({
      title: "等待审批",
      description: "test",
      publisherName: "Codex",
    }).approvalSubscription;
    if (!subscription) throw new Error("missing subscription");
    const baseline = p.service.events.listenerCount("changed");
    const waiting = Array.from({ length: LIMITS.subscribers }, () => {
      const controller = new AbortController();
      controllers.push(controller);
      return p.service
        .waitForApproval(subscription, 5000, controller.signal)
        .catch((error: unknown) => error);
    });
    await assert.rejects(
      p.service.waitForApproval(subscription, 0),
      /数量超限/,
    );
    controllers.forEach((controller) => controller.abort());
    await Promise.all(waiting);
    assert.equal(p.service.events.listenerCount("changed"), baseline);
    assert.deepEqual(
      (await p.service.waitForApproval(subscription, 0)).approvals,
      [],
    );
    assert.equal(p.service.events.listenerCount("changed"), baseline);
    const stopped = p.service.waitForApproval(subscription, 5000);
    const rejection = assert.rejects(stopped, /等待已结束/);
    await p.service.close();
    await rejection;
    assert.equal(p.service.events.listenerCount("changed"), baseline);
  } finally {
    controllers.forEach((controller) => controller.abort());
    await p.close();
  }
});

test("B4 MCP 审批等待交回普通请求名额，满载时短请求仍可响应", async () => {
  // 检查发现 MCP 长轮询与普通请求共用名额。只留一个普通名额时，等待审批应交回该名额。
  const p = await fixture();
  const client = new Client({ name: "approval-wait-budget", version: "1" });
  const stop = new AbortController();
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(p.base + "/mcp")),
    );
    const published = await client.callTool({
      name: "mcp-mingting-tool",
      arguments: {
        title: "等待审批",
        description: "测试长轮询配额",
        publisherName: "test",
      },
    });
    const subscription = publishResultSchema.parse(
      published.structuredContent,
    ).approvalSubscription;
    assert.ok(subscription);

    p.app.get("/test-held-requests", (_req, res) => res.flushHeaders());
    const held = await Promise.all(
      Array.from({ length: LIMITS.httpConcurrent - 1 }, () =>
        fetch(p.base + "/test-held-requests", { signal: stop.signal }),
      ),
    );
    for (const response of held) assert.equal(response.status, 200);
    const waitForApproval = p.service.waitForApproval.bind(p.service);
    const entered = new Promise<void>((resolve) => {
      p.service.waitForApproval = (...args) => {
        const pending = waitForApproval(...args);
        resolve();
        return pending;
      };
    });
    const waiting = client.callTool(
      {
        name: "wait_for_approval",
        arguments: { ...subscription, waitMs: 2000 },
      },
      undefined,
      { signal: stop.signal },
    );
    void waiting.catch(() => {});
    await Promise.race([
      entered,
      waiting.then(() => assert.fail("审批等待提前返回")),
    ]);
    const short = await fetch(p.base + "/api/bootstrap", {
      signal: stop.signal,
    });
    assert.equal(short.status, 200);
  } finally {
    stop.abort();
    await client.close();
    await p.close();
  }
});
