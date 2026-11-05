// ACP transport fixture; models, desktop chats and commands stay outside this process.
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";
let loaded: string | undefined;
const input = new ReadableStream<Uint8Array>({
  start(controller) {
    process.stdin.on("data", (chunk: Buffer) => controller.enqueue(chunk));
    process.stdin.on("end", () => controller.close());
    process.stdin.on("error", (error: Error) => controller.error(error));
  },
});
const output = new WritableStream<Uint8Array>({
  write(chunk) {
    return new Promise<void>((done, reject) => {
      process.stdout.write(chunk, (error) => (error ? reject(error) : done()));
    });
  },
});
const connection = agent({ name: "wakeup-host-fixture" })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: { name: "wakeup-host-fixture", version: "1" },
    agentCapabilities: { loadSession: true },
  }))
  .onRequest(methods.agent.session.new, () => {
    throw new Error("fixture forbids session/new for wakeups");
  })
  .onRequest(methods.agent.session.load, (ctx) => {
    if (process.env.FIXTURE_WRITER_BUSY === "1")
      throw RequestError.invalidRequest(
        { reason: "thread_active_writer" },
        "thread already has an active writer",
      );
    loaded = ctx.params.sessionId;
    return {};
  })
  .onRequest(methods.agent.session.prompt, async (ctx) => {
    if (ctx.params.sessionId !== loaded)
      throw new Error("fixture session mismatch");
    const text = ctx.params.prompt
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (text.includes("fixture-host-failure"))
      throw RequestError.invalidRequest({}, "fixture host disconnected");
    await ctx.client.notify(methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "fixture accepted" },
      },
    });
    return { stopReason: "end_turn" };
  })
  .connect(ndJsonStream(output, input));
await connection.closed;
