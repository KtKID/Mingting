// A real child process speaking ACP using the official SDK; never executes commands or calls a model.
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
const sessionId = randomUUID();
let authenticated = false;
const modes = {
  currentModeId: "workspace-write",
  availableModes: [{ id: "workspace-write", name: "Workspace access" }],
};
const connection = agent({ name: "fake-codex-acp" })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: { name: "FAKE ACP", version: "test" },
    agentCapabilities: {},
    authMethods: [{ id: "api-key", name: "Fake API key method" }],
  }))
  .onRequest(methods.agent.authenticate, (ctx) => {
    if (ctx.params.methodId !== "api-key")
      throw new Error("Unexpected auth method");
    authenticated = true;
    return {};
  })
  .onRequest(methods.agent.session.new, () => ({ sessionId, modes }))
  .onRequest(methods.agent.session.setMode, () => ({}))
  .onNotification(methods.agent.session.cancel, () => {})
  .onRequest(methods.agent.session.prompt, async (ctx) => {
    const prompt = ctx.params.prompt
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("");
    if (prompt.includes("[process-exit]")) process.exit(1);
    const permissionSession = prompt.includes("[bad-session]")
      ? "another-session"
      : sessionId;
    const result = await ctx.client.request(
      methods.client.session.requestPermission,
      {
        sessionId: permissionSession,
        toolCall: {
          toolCallId: "fake-tool-1",
          title: "演示：执行测试操作（不会实际执行）",
          kind: "execute",
          status: "pending",
          rawInput: { command: "echo demo — simulated only" },
        },
        options: [
          { optionId: "allow-once", name: "允许一次", kind: "allow_once" },
          { optionId: "reject-once", name: "拒绝一次", kind: "reject_once" },
        ],
      },
    );
    const text =
      result.outcome.outcome === "selected"
        ? `selected:${result.outcome.optionId}`
        : "cancelled";
    await ctx.client.notify(methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text:
            "[FAKE ACP] auth=" +
            (authenticated ? "selected" : "none") +
            " " +
            text +
            "。演示回合结束；没有调用模型或执行命令。",
        },
      },
    });
    return { stopReason: "end_turn" };
  })
  .connect(
    ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    ),
  );
process.stdin.once("end", () => {
  connection.close();
  process.exit(0);
});
