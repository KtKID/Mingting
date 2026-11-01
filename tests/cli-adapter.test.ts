import { test } from "node:test";
import assert from "node:assert/strict";
import { CliAdapter } from "../src/server/cli-adapter.js";
import type { RunHooks } from "../src/server/codex-adapter.js";

const hooks: RunHooks = {
  session: () => {},
  discovery: () => {},
  update: () => {},
  permission: async () => ({ outcome: { outcome: "cancelled" } }),
};
function adapter(code: string, harnessName: "Grok" | "ZCode" = "Grok") {
  return new CliAdapter({
    harnessName,
    workspace: process.cwd(),
    env: { PATH: process.env.PATH },
    command: process.execPath,
    args: ["-e", code, "--"],
  });
}
test("T5 native CLI accepts verified final JSON and preserves text/session", async () => {
  let session = "",
    text = "";
  const a = adapter(
    'console.log(JSON.stringify({text:process.argv[1],stopReason:"end_turn",sessionId:"native-123"}))',
  );
  assert.equal(
    await a.execute("你好；$(invalid)", new AbortController().signal, {
      ...hooks,
      session: (s) => (session = s),
      update: (u) => {
        if (
          u.update.sessionUpdate === "agent_message_chunk" &&
          u.update.content.type === "text"
        )
          text += u.update.content.text;
      },
    }),
    "end_turn",
  );
  assert.equal(session, "native-123");
  assert.equal(text, "你好；$(invalid)");
});
test("T5 native CLI rejects malformed, incomplete and unsuccessful outputs", async () => {
  for (const code of [
    'console.log("invalid")',
    'console.log(JSON.stringify({text:"hi",sessionId:"1",stopReason:"max_turns"}))',
    "process.exit(7)",
  ]) {
    await assert.rejects(
      adapter(code).execute("hi", new AbortController().signal, hooks),
    );
  }
});
test("Z2 ZCode native idle result preserves the real CLI response shape", async () => {
  let session = "",
    text = "";
  const result = {
    sessionId: "sess-fixture",
    response: "你好，我是 ZCode。",
    eventCount: 12,
    projection: { status: "idle", turnCount: 1 },
  };
  const code = `console.log(${JSON.stringify(JSON.stringify(result))})`;
  assert.equal(
    await adapter(code, "ZCode").execute("你好", new AbortController().signal, {
      ...hooks,
      session: (s) => (session = s),
      update: (n) => {
        if (
          n.update.sessionUpdate === "agent_message_chunk" &&
          n.update.content.type === "text"
        )
          text += n.update.content.text;
      },
    }),
    "end_turn",
  );
  assert.equal(session, result.sessionId);
  assert.equal(text, result.response);
  await assert.rejects(
    adapter(
      'console.log(JSON.stringify({sessionId:"s",response:"partial",projection:{status:"running"}}))',
      "ZCode",
    ).execute("hi", new AbortController().signal, hooks),
  );
});
test("T5 abort kills the original native CLI instead of returning success", async () => {
  const c = new AbortController();
  const run = adapter("setInterval(()=>{},1000)").execute(
    "hi",
    c.signal,
    hooks,
  );
  setTimeout(() => c.abort(new Error("test cancelled")), 50);
  await assert.rejects(run, /test cancelled/);
});
test("T5 abort escalates cleanup when a native CLI ignores SIGTERM", async () => {
  const c = new AbortController();
  const run = adapter(
    'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)',
  ).execute("hi", c.signal, hooks);
  setTimeout(() => c.abort(new Error("stubborn cancelled")), 150);
  await assert.rejects(run, /stubborn cancelled/);
});
