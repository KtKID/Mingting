// Replays recorded model/tool messages; all permission decisions still cross real ACP.
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import { loadRecording } from "./approval-replay-data.js";

const data = await loadRecording();
const sessionId = randomUUID(),
  toolCallId = randomUUID();
let used = false;
const connection = agent({ name: "zcode-recording-replay" })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: { name: "ZCode 真实数据回放（模型与工具录制）", version: "1" },
    agentCapabilities: {},
    authMethods: [],
  }))
  .onRequest(methods.agent.session.new, () => ({ sessionId }))
  .onNotification(methods.agent.session.cancel, () => {})
  .onRequest(methods.agent.session.prompt, async (ctx) => {
    if (used || ctx.params.sessionId !== sessionId)
      throw new Error("回放仅支持一次会话");
    used = true;
    const emit = async (updates: typeof data.before) => {
      for (const original of updates) {
        ctx.signal.throwIfAborted();
        const update = structuredClone(original);
        if (
          update.sessionUpdate === "tool_call" ||
          update.sessionUpdate === "tool_call_update"
        )
          update.toolCallId = toolCallId;
        await ctx.client.notify(methods.client.session.update, {
          sessionId,
          update,
        });
      }
    };
    await emit(data.before);
    const request = structuredClone(data.request);
    request.sessionId = sessionId;
    request.toolCall.toolCallId = toolCallId;
    const response = await ctx.client.request(
      methods.client.session.requestPermission,
      request,
      { cancellationSignal: ctx.signal },
    );
    if (response.outcome.outcome !== "selected")
      return { stopReason: "cancelled" };
    const selected = request.options.find(
      (option) =>
        response.outcome.outcome === "selected" &&
        option.optionId === response.outcome.optionId,
    );
    const allow =
      selected?.kind === "allow_once" || selected?.kind === "allow_always";
    await emit(allow ? data.allowed : data.denied);
    return { stopReason: "end_turn" };
  })
  .connect(
    ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    ),
  );
process.stdin.once("end", () => connection.close());
