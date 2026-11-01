import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CodexAdapter } from "../src/server/codex-adapter.js";
import { fakeZcodeNative } from "./zcode-fixture.js";
test("A10 ZCode bridge streams UTF-8 before exit and handles batch, malformed data, exit failure and cancellation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-bridge-"));
  const bin = join(dir, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "zcode"), fakeZcodeNative, { mode: 0o700 });
  const adapter = new CodexAdapter({
    command: process.execPath,
    args: [
      "--import",
      import.meta.resolve("tsx"),
      resolve("scripts/zcode-acp.ts"),
    ],
    workspace: dir,
    sessionMode: "plan",
    env: { PATH: bin + ":" + process.env.PATH, HOME: dir },
  });
  const hooks = {
    session: () => {},
    discovery: () => {},
    update: () => {},
    permission: async () => ({ outcome: { outcome: "cancelled" as const } }),
  };
  try {
    let firstUpdate = 0;
    let partial = "",
      finished = false;
    assert.equal(
      await adapter.execute("hi", AbortSignal.timeout(5000), {
        ...hooks,
        update: (n) => {
          if (
            n.update.sessionUpdate === "agent_message_chunk" &&
            n.update.content.type === "text"
          ) {
            assert.equal(finished, false);
            firstUpdate ||= Date.now();
            partial += n.update.content.text;
          }
        },
      }),
      "end_turn",
    );
    finished = true;
    assert.equal(partial, "你好");
    assert.ok(
      Date.now() - firstUpdate >= 100,
      "partial output must precede child completion",
    );
    for (const text of ["invalid", "exit"])
      await assert.rejects(
        adapter.execute(text, AbortSignal.timeout(5000), hooks),
      );
    const abort = new AbortController();
    await assert.rejects(
      adapter.execute("cancel", abort.signal, {
        ...hooks,
        update: () => abort.abort(new Error("test cancel")),
      }),
      /test cancel/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
