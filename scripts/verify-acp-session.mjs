import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "node:http";
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
// 使用真实 Codex/ACP 和本地模型夹具，验证原会话写入权交接；真实账户凭据保持原状。
async function startLocalModel() {
  const server = createServer(async (req, res) => {
    for await (const chunk of req) {
      void chunk;
    }
    if (req.method !== "POST" || !req.url?.endsWith("/responses")) {
      res.writeHead(404).end();
      return;
    }
    const item = {
      type: "message",
      id: "fixture-message",
      role: "assistant",
      content: [{ type: "output_text", text: "ACP FIXTURE OK" }],
    };
    const response = {
      id: "fixture-response",
      status: "completed",
      output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (event) =>
      res.write(
        "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n",
      );
    send({
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    });
    send({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, content: [] },
    });
    send({
      type: "response.output_text.delta",
      output_index: 0,
      item_id: item.id,
      delta: "ACP FIXTURE OK",
    });
    send({ type: "response.output_item.done", output_index: 0, item });
    send({ type: "response.completed", response });
    res.end();
  });
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Local model address unavailable");
  return {
    base: "http://127.0.0.1:" + address.port + "/v1",
    close: () => new Promise((done) => server.close(done)),
  };
}
const dir = await mkdtemp("/private/tmp/mingting-acp-");
const codexHome = join(dir, "codex-home");
await mkdir(codexHome, { recursive: true });
const model = await startLocalModel();
await writeFile(
  join(codexHome, "config.toml"),
  [
    'model="gpt-6-sol"',
    'model_provider="fixture"',
    'model_reasoning_effort="low"',
    "[model_providers.fixture]",
    'name="Local ownership test fixture"',
    `base_url="${model.base}"`,
    'env_key="MINGTING_OWNERSHIP_TEST_KEY"',
    'wire_api="responses"',
    "requires_openai_auth=false",
    "supports_websockets=false",
    "request_max_retries=0",
    "stream_max_retries=0",
  ].join("\n") + "\n",
);
const record = {
  kind: "real-codex-acp-with-local-model-fixture",
  capturedAt: new Date().toISOString(),
  home: codexHome,
  credentialsCopied: false,
  realModel: false,
  steps: [],
};
const children = [];
function connect(label) {
  const child = spawn(
    process.execPath,
    ["node_modules/@agentclientprotocol/codex-acp/dist/index.js"],
    {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        CODEX_HOME: codexHome,
        CODEX_PATH:
          process.env.CODEX_PATH ??
          process.env.CODEX_APP_RUNTIME_CLI_PATH ??
          "codex",
        MINGTING_OWNERSHIP_TEST_KEY: "local-fixture-only",
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    },
  );
  child.stderr.resume();
  child.stdin.on("error", () => {});
  children.push(child);
  const conn = client({ name: "mingting-ownership-" + label })
    .onNotification(methods.client.session.update, () => {})
    .onRequest(methods.client.session.requestPermission, () => ({
      outcome: { outcome: "cancelled" },
    }))
    .connect(
      ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
    );
  return {
    child,
    request: (method, params) =>
      Promise.race([
        conn.agent.request(method, params),
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error("native ACP test timed out")),
            45000,
          );
          timer.unref();
        }),
      ]),
  };
}
try {
  const a = connect("A");
  for (const c of [a])
    await c.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "mingting-ownership-check", version: "1" },
    });
  const s = await a.request(methods.agent.session.new, {
    cwd: dir,
    mcpServers: [],
  });
  record.sessionId = s.sessionId;
  const first = await a.request(methods.agent.session.prompt, {
    sessionId: s.sessionId,
    prompt: [
      {
        type: "text",
        text: "Return the local protocol test fixture response.",
      },
    ],
  });
  record.steps.push({
    operation: "A completes an ACP prompt",
    stopReason: first.stopReason,
    passed: first.stopReason === "end_turn",
  });
  const load = { sessionId: s.sessionId, cwd: dir, mcpServers: [] };
  const b = connect("B");
  await b.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: "mingting-ownership-B", version: "1" },
  });
  try {
    await b.request(methods.agent.session.load, load);
    record.steps.push({
      operation: "B loads while A holds idle session",
      passed: false,
      error: "unexpectedly accepted",
    });
  } catch (e) {
    record.steps.push({
      operation: "B loads while A holds idle session",
      passed: /in use by another Codex client/.test(e.message),
      error: e.message,
    });
  }
  await a.request(methods.agent.session.close, { sessionId: s.sessionId });
  record.steps.push({ operation: "A closes idle session", passed: true });
  const exited = new Promise((done) => a.child.once("close", done));
  process.kill(-a.child.pid, "SIGTERM");
  await exited;
  record.steps.push({ operation: "A owning ACP process exits", passed: true });
  const c = connect("C");
  await c.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: "mingting-ownership-C", version: "1" },
  });
  await c.request(methods.agent.session.load, load);
  record.steps.push({
    operation: "C loads same ID after ownership release",
    passed: true,
  });
  const second = await c.request(methods.agent.session.prompt, {
    sessionId: s.sessionId,
    prompt: [
      {
        type: "text",
        text: "Continue the same session using the local fixture response.",
      },
    ],
  });
  record.steps.push({
    operation: "C completes resumed ACP prompt",
    stopReason: second.stopReason,
    passed: second.stopReason === "end_turn",
  });
  await c.request(methods.agent.session.close, { sessionId: s.sessionId });
  record.passed = record.steps.every((x) => x.passed);
} catch (e) {
  record.passed = false;
  record.error = e instanceof Error ? e.message : String(e);
} finally {
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
  await model.close();
  await mkdir("reports/chat-wakeups/development", { recursive: true });
  await writeFile(
    "reports/chat-wakeups/development/acp-native-ownership.json",
    JSON.stringify(record, null, 2) + "\n",
  );
  console.log(JSON.stringify(record, null, 2));
  process.exit(record.passed ? 0 : 2);
}
