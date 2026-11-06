// A real child process speaking ACP using the official SDK; never executes commands or calls a model.
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";
const sessionId = randomUUID();
const grok = process.env.FAKE_GROK === "1";
let model = "A";
let effort = "medium";
let finishOnCancel: (() => void) | undefined;
const options = (): SessionConfigOption[] => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: model,
    options: ["A", "B"].map((value) => ({ value, name: `Model ${value}` })),
  },
  {
    id: "reasoning_effort",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: effort,
    options: (model === "A" ? ["low", "medium"] : ["low", "high"]).map(
      (value) => ({ value, name: value }),
    ),
  },
];
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
    authMethods: [{ id: grok ? "cached_token" : "api-key", name: "Fake auth" }],
  }))
  .onRequest(methods.agent.authenticate, (ctx) => {
    if (
      ctx.params.methodId !== (grok ? "cached_token" : "api-key") ||
      (grok && ctx.params._meta?.headless !== true)
    )
      throw new Error("Unexpected auth method");
    authenticated = true;
    return {};
  })
  .onRequest(methods.agent.session.new, () =>
    grok ? { sessionId } : { sessionId, modes, configOptions: options() },
  )
  .onRequest(methods.agent.session.setMode, () => ({}))
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
    if (
      params.configId === "model" &&
      (params.value === "A" || params.value === "B")
    ) {
      model = process.env.FAKE_SETTINGS_MISMATCH === "1" ? "A" : params.value;
      effort = model === "A" ? "medium" : "low";
    } else if (
      params.configId === "reasoning_effort" &&
      options().some(
        (option) =>
          option.id === params.configId &&
          option.type === "select" &&
          option.options.some(
            (choice) => "value" in choice && choice.value === params.value,
          ),
      )
    ) {
      effort = String(params.value);
    } else {
      throw new Error("unsupported selection");
    }
    return { configOptions: options() };
  })
  .onNotification(methods.agent.session.cancel, () => finishOnCancel?.())
  .onRequest(methods.agent.session.prompt, async (ctx) => {
    const prompt = ctx.params.prompt
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("");
    if (prompt.includes("[cancel-usage]")) {
      const cancelled = new Promise<void>((resolve) => {
        finishOnCancel = resolve;
      });
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "waiting for cancellation" },
        },
      });
      await cancelled;
      return {
        stopReason: "cancelled",
        usage: {
          inputTokens: 4,
          cachedReadTokens: 0,
          cachedWriteTokens: 0,
          outputTokens: 1,
          thoughtTokens: 0,
          totalTokens: 5,
        },
      };
    }
    if (
      prompt.includes("[settings-check]") ||
      prompt.includes("[usage-check]")
    ) {
      if (process.env.FAKE_PROMPT_LOG)
        appendFileSync(process.env.FAKE_PROMPT_LOG, "prompt\n");
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `executed:${model}/${effort}` },
        },
      });
      if (!prompt.includes("[usage-check]")) return { stopReason: "end_turn" };
      for (const used of [28, 10])
        await ctx.client.notify(methods.client.session.update, {
          sessionId,
          update: { sessionUpdate: "usage_update", used, size: 76000 },
        });
      await ctx.client.notify(methods.client.session.update, {
        sessionId: "wrong-session",
        update: { sessionUpdate: "usage_update", used: 99, size: 76000 },
      });
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "usage_update", used: 99, size: 0 },
      });
      const usage = {
        inputTokens: 13,
        cachedReadTokens: 8,
        cachedWriteTokens: 0,
        outputTokens: 7,
        thoughtTokens: 2,
        totalTokens: prompt.includes("[mismatch]") ? 29 : 28,
      };
      return {
        stopReason: "end_turn",
        ...(prompt.includes("[alias-only]") ? {} : { usage }),
        _meta: { quota: { token_count: usage } },
      };
    }
    if (prompt.includes("[process-exit]")) process.exit(1);
    if (prompt.includes("[stubborn]")) {
      process.stdin.removeAllListeners("end");
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "[FAKE ACP] stubborn prompt started; no model or command",
          },
        },
      });
      return await new Promise<never>(() => {});
    }
    const permissionSession = prompt.includes("[bad-session]")
      ? "another-session"
      : sessionId;
    const streaming = prompt.includes("[stream]");
    if (streaming) {
      for (const update of [
        {
          sessionUpdate: "agent_thought_chunk" as const,
          content: { type: "text" as const, text: "先读取问候文本。" },
        },
        {
          sessionUpdate: "agent_message_chunk" as const,
          content: { type: "text" as const, text: "问候正在生成…" },
        },
        {
          sessionUpdate: "tool_call" as const,
          toolCallId: "fake-tool-1",
          title: "读取 HELLO.txt",
          kind: "read" as const,
          status: "pending" as const,
          rawInput: { path: "HELLO.txt" },
        },
      ])
        await ctx.client.notify(methods.client.session.update, {
          sessionId,
          update,
        });
    }
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
    if (streaming) {
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "fake-tool-1",
          status: "in_progress",
        },
      });
      await new Promise((r) => setTimeout(r, 300));
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "fake-tool-1",
          status: "completed",
          rawOutput: "你好",
        },
      });
    }
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
