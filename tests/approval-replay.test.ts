import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { loadRecording, optionFor } from "../scripts/approval-replay-data.js";
import { CodexAdapter } from "../src/server/codex-adapter.js";
import { TaskConnector } from "../src/connector/connector.js";
import { createPlatform } from "../src/server/http.js";

test("AR1 the default fixture is self-contained and private replay sources are verified when supplied", async () => {
  const data = await loadRecording();
  if (process.env.APPROVAL_RECORDING_PATH === undefined)
    assert.deepEqual(data.sources, []);
  for (const source of data.sources) {
    const text = await readFile(source.path, "utf8");
    assert.equal(
      createHash("sha256").update(text).digest("hex"),
      source.sha256,
    );
  }
  assert.equal(
    data.request.options.find((o) => o.kind === "reject_once")?.optionId,
    "deny",
  );
  assert.match(data.allowedOutput, /ZCODE_APPROVAL_CHANNEL_OK/);
  assert.equal(data.deniedOutput, "审批拒绝已停止");
});
function adapter() {
  return new CodexAdapter({
    command: process.execPath,
    args: [
      "--import",
      import.meta.resolve("tsx"),
      resolve("scripts/approval-replay-acp.ts"),
    ],
    workspace: process.cwd(),
    env: {
      PATH: process.env.PATH,
      APPROVAL_RECORDING_PATH: process.env.APPROVAL_RECORDING_PATH,
    },
    sessionMode: null,
  });
}
for (const choice of ["allow", "deny"] as const)
  test(`AR2 recorded ACP ${choice} waits for permission and returns the matching original branch`, async () => {
    const data = await loadRecording();
    let output = "",
      tool = "",
      received = false;
    const result = await adapter().execute(
      "recording",
      AbortSignal.timeout(5000),
      {
        session: () => {},
        discovery: () => {},
        permission: async (_id, request) => {
          assert.deepEqual(
            request.toolCall.rawInput,
            data.request.toolCall.rawInput,
          );
          assert.deepEqual(request.options, data.request.options);
          assert.equal(output, "");
          received = true;
          return {
            outcome: { outcome: "selected", optionId: optionFor(choice) },
          };
        },
        update: ({ update }) => {
          if (
            update.sessionUpdate === "agent_message_chunk" &&
            update.content.type === "text"
          )
            output += update.content.text;
          if (update.sessionUpdate === "tool_call_update")
            tool = update.status ?? tool;
        },
      },
    );
    assert.equal(received, true);
    assert.equal(result, "end_turn");
    assert.equal(
      output,
      choice === "allow" ? data.allowedOutput : data.deniedOutput,
    );
    assert.equal(tool, choice === "allow" ? "completed" : "failed");
  });
test("AR3 selected-task connector leaves unrelated queued tasks untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mingting-recorded-"));
  const p = createPlatform({
    dbPath: join(dir, "tasks.sqlite"),
    workspace: process.cwd(),
    mode: "codex",
  });
  const server = createServer(p.app);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing test address");
  const other = p.service.publish({
    title: "unrelated",
    description: "untouched",
    publisherName: "test",
  });
  const selected = p.service.publish({
    title: "recorded",
    description: "approval",
    publisherName: "Codex",
    targetHarness: "ZCode-Replay",
  });
  const connector = new TaskConnector(
    `http://127.0.0.1:${address.port}`,
    adapter(),
    undefined,
    "ZCode-Replay",
    (id) => id === selected.taskId,
  );
  try {
    connector.start();
    const deadline = Date.now() + 5000;
    while (
      p.store.task(selected.taskId)?.status !== "awaiting_approval" &&
      Date.now() < deadline
    )
      await delay(30);
    assert.equal(p.store.task(selected.taskId)?.status, "awaiting_approval");
    assert.equal(p.store.task(other.taskId)?.status, "queued");
    assert.equal(p.store.detail(other.taskId)?.runs.length, 0);
  } finally {
    await connector.close();
    await p.service.close();
    server.closeIdleConnections();
    await new Promise<void>((done) => server.close(() => done()));
    p.store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
