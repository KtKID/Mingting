import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { CodexAdapter } from "../src/server/codex-adapter.js";
test("A9 Grok cached-token ACP supports launch plan without advertised modes; Codex keeps required workspace mode", async () => {
  const base = {
    command: process.execPath,
    args: [
      "--import",
      import.meta.resolve("tsx"),
      resolve("tests/fake-acp.ts"),
    ],
    workspace: process.cwd(),
    env: { PATH: process.env.PATH, FAKE_GROK: "1" },
  };
  const hooks = {
    session: () => {},
    discovery: () => {},
    update: () => {},
    permission: async () => ({ outcome: { outcome: "cancelled" as const } }),
  };
  assert.equal(
    await new CodexAdapter({
      ...base,
      harnessName: "Grok",
      sessionMode: null,
      authMethod: "cached_token",
    }).execute("hi", AbortSignal.timeout(5000), hooks),
    "end_turn",
  );
  await assert.rejects(
    new CodexAdapter(base).execute("hi", AbortSignal.timeout(5000), hooks),
    /workspace-write/,
  );
});
