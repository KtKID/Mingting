// Project ACP bridge: real native ZCode stream-json, one text turn in read-only plan mode.
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { LIMITS } from "../src/shared/protocol.js";
import { translateZcodeLine } from "../src/server/zcode-stream.js";

const workspace = realpathSync(
  resolve(process.env.TASK_WORKSPACE ?? process.cwd()),
);
const sessionId = randomUUID();
let created = false,
  used = false;
let active: AbortController | undefined;
const modes = {
  currentModeId: "plan",
  availableModes: [{ id: "plan", name: "只读问候与文件读取" }],
};
const connection = agent({ name: "mingting-zcode-stream-acp" })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: {
      name: "ZCode · Mingting stream-json ACP bridge",
      version: "1",
    },
    agentCapabilities: {},
    authMethods: [],
  }))
  .onRequest(methods.agent.session.new, (ctx) => {
    if (
      created ||
      realpathSync(resolve(ctx.params.cwd)) !== workspace ||
      ctx.params.mcpServers.length
    )
      throw new Error("桥接器仅支持固定项目目录的一次会话");
    created = true;
    return { sessionId, modes };
  })
  .onRequest(methods.agent.session.setMode, (ctx) => {
    if (
      !created ||
      ctx.params.sessionId !== sessionId ||
      ctx.params.modeId !== "plan"
    )
      throw new Error("桥接器要求 plan 模式");
    return {};
  })
  .onNotification(methods.agent.session.cancel, (ctx) => {
    if (ctx.params.sessionId === sessionId) active?.abort();
  })
  .onRequest(methods.agent.session.prompt, async (ctx) => {
    if (
      !created ||
      used ||
      ctx.params.sessionId !== sessionId ||
      ctx.params.prompt.some((p) => p.type !== "text")
    )
      throw new Error("桥接器仅支持一次文本问候回合");
    used = true;
    const controller = new AbortController();
    active = controller;
    const signal = AbortSignal.any([
      controller.signal,
      ctx.signal,
      AbortSignal.timeout(LIMITS.cliMs),
    ]);
    const text = ctx.params.prompt
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("\n");
    const child = spawn(
      "zcode",
      [
        "--cwd",
        workspace,
        "--mode",
        "plan",
        "--workflow-mode",
        "disabled",
        "--disallowed-tools",
        "Bash,Edit,Write,Glob,Grep,WebSearch,WebFetch,Task",
        "--output-format",
        "stream-json",
        "-p",
        text,
      ],
      {
        cwd: workspace,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stderr.resume();
    const exit = once(child, "close");
    void exit.catch(() => {});
    let hardKill: NodeJS.Timeout | undefined;
    const cancel = () => {
      child.kill("SIGTERM");
      hardKill = setTimeout(() => child.kill("SIGKILL"), LIMITS.killMs);
    };
    signal.addEventListener("abort", cancel, { once: true });
    let buffer = "",
      answer = "",
      summary: ReturnType<typeof translateZcodeLine>["result"];
    let pending: SessionNotification | undefined;
    let flushTimer: NodeJS.Timeout | undefined;
    const flush = async () => {
      clearTimeout(flushTimer);
      flushTimer = undefined;
      if (pending) {
        const value = pending;
        pending = undefined;
        await ctx.client.notify(methods.client.session.update, value);
      }
    };
    const emit = async (value: SessionNotification) => {
      const u = value.update,
        previous = pending?.update;
      if (
        (u.sessionUpdate === "agent_message_chunk" ||
          u.sessionUpdate === "agent_thought_chunk") &&
        u.content.type === "text"
      ) {
        if (u.sessionUpdate === "agent_message_chunk") answer += u.content.text;
        if (
          previous?.sessionUpdate === u.sessionUpdate &&
          previous.content.type === "text" &&
          previous.content.text.length < LIMITS.toolChars
        ) {
          previous.content.text += u.content.text;
          return;
        }
        await flush();
        pending = value;
        flushTimer = setTimeout(() => {
          void flush().catch(() => controller.abort());
        }, LIMITS.browserFlushMs);
      } else {
        await flush();
        await ctx.client.notify(methods.client.session.update, value);
      }
    };
    const line = async (text: string) => {
      if (summary) throw new Error("ZCode 在结果后继续输出事件");
      const mapped = translateZcodeLine(JSON.parse(text), sessionId);
      if (mapped.update) await emit(mapped.update);
      if (mapped.result) summary = mapped.result;
    };
    try {
      if (signal.aborted) cancel();
      for await (const chunk of child.stdout.setEncoding("utf8")) {
        signal.throwIfAborted();
        buffer += chunk;
        let boundary;
        while ((boundary = buffer.indexOf("\n")) >= 0) {
          if (boundary > LIMITS.acpBytes) throw new Error("ZCode 单条事件过大");
          const value = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 1);
          if (value.trim()) await line(value);
        }
        if (buffer.length > LIMITS.acpBytes)
          throw new Error("ZCode 单条事件过大");
      }
      if (buffer.trim()) await line(buffer);
      const [code] = await exit;
      signal.throwIfAborted();
      if (code !== 0 || !summary)
        throw new Error("ZCode 流式回合未成功完成，请检查项目登录与模型配置");
      if (!answer && summary.response)
        await emit({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: summary.response },
          },
        });
      await flush();
      return { stopReason: "end_turn" };
    } catch (error) {
      if (controller.signal.aborted) return { stopReason: "cancelled" };
      throw error;
    } finally {
      signal.removeEventListener("abort", cancel);
      clearTimeout(flushTimer);
      clearTimeout(hardKill);
      if (child.exitCode === null && child.signalCode === null) {
        cancel();
        await exit.catch(() => {});
        clearTimeout(hardKill);
      }
      active = undefined;
    }
  })
  .connect(
    ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
      { maxMessageBytes: LIMITS.acpBytes },
    ),
  );
process.stdin.once("end", () => {
  active?.abort();
  connection.close();
});
