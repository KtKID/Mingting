import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CodexAdapter } from "../src/server/codex-adapter.js";
import {
  mapZcodePermission,
  nativeDeferred,
} from "../src/server/zcode-native.js";
import { fakeZcodeNative } from "./zcode-fixture.js";
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "zcode-approval-"));
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
  return {
    dir,
    adapter,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
const hooks = { session: () => {}, discovery: () => {}, update: () => {} };
for (const optionId of ["native-allow", "native-deny"]) {
  test(`N1 native permission → real ACP wait → ${optionId} response gates operation`, async () => {
    const f = await fixture();
    const received = nativeDeferred<void>();
    const decision = nativeDeferred<RequestPermissionResponse>();
    let output = "";
    try {
      const running = f.adapter.execute(
        "permission-gate",
        AbortSignal.timeout(5000),
        {
          ...hooks,
          update: (notification) => {
            if (
              notification.update.sessionUpdate === "agent_message_chunk" &&
              notification.update.content.type === "text"
            )
              output += notification.update.content.text;
          },
          permission: async (_id, request) => {
            assert.equal(
              request.toolCall.rawInput &&
                JSON.stringify(request.toolCall.rawInput),
              '{"file_path":"HELLO.txt"}',
            );
            assert.equal(
              request.options.find(
                (option) => option.optionId === "native-deny",
              )?.kind,
              "reject_once",
            );
            received.resolve();
            return decision.promise;
          },
        },
      );
      await received.promise;
      await assert.rejects(access(join(f.dir, "executed.txt")));
      decision.resolve({ outcome: { outcome: "selected", optionId } });
      assert.equal(await running, "end_turn");
      assert.match(
        output,
        optionId === "native-allow"
          ? /"decision":"allow"/
          : /"decision":"deny"/,
      );
      if (optionId === "native-allow")
        assert.equal(
          await readFile(join(f.dir, "executed.txt"), "utf8"),
          "approved",
        );
      else await assert.rejects(access(join(f.dir, "executed.txt")));
    } finally {
      await f.cleanup();
    }
  });
}

test("N2 native reannouncements share one ACP approval; both native wire IDs receive the same answer", async () => {
  const f = await fixture();
  let count = 0;
  try {
    const result = await f.adapter.execute(
      "permission-reannounce",
      AbortSignal.timeout(5000),
      {
        ...hooks,
        permission: async () => {
          count++;
          await new Promise((done) => setTimeout(done, 80));
          return { outcome: { outcome: "selected", optionId: "native-deny" } };
        },
      },
    );
    assert.equal(result, "end_turn");
    assert.equal(count, 1);
    await assert.rejects(access(join(f.dir, "executed.txt")));
  } finally {
    await f.cleanup();
  }
});

test("N3 wrong-session request and cancelled or unknown ACP choice keep operation blocked", async () => {
  const f = await fixture();
  try {
    let count = 0;
    await f.adapter.execute(
      "permission-other-session",
      AbortSignal.timeout(5000),
      {
        ...hooks,
        permission: async () => {
          count++;
          return { outcome: { outcome: "selected", optionId: "native-allow" } };
        },
      },
    );
    assert.equal(count, 0);
    for (const outcome of [
      { outcome: "cancelled" as const },
      { outcome: "selected" as const, optionId: "invented" },
    ]) {
      await f.adapter.execute("permission-invalid", AbortSignal.timeout(5000), {
        ...hooks,
        permission: async () => ({ outcome }),
      });
      await assert.rejects(access(join(f.dir, "executed.txt")));
    }
  } finally {
    await f.cleanup();
  }
});

test("N4 cancellation during a native permission wait terminates the original child", async () => {
  const f = await fixture();
  const controller = new AbortController();
  try {
    await assert.rejects(
      f.adapter.execute("permission-cancel", controller.signal, {
        ...hooks,
        permission: async () => {
          controller.abort(new Error("cancel approval test"));
          return { outcome: { outcome: "cancelled" } };
        },
      }),
      /cancel approval test/,
    );
    await assert.rejects(access(join(f.dir, "executed.txt")));
  } finally {
    await f.cleanup();
  }
});

test("N5 native option mapping preserves exact responses and refuses conflicting semantics", () => {
  const source = {
    requestId: "p",
    sessionId: "native",
    toolCallId: "t",
    toolName: "Read",
    input: { file_path: "HELLO.txt" },
    options: [
      {
        optionId: "project",
        name: "This project",
        kind: "allow_always",
        response: {
          decision: "allow",
          permissionUpdates: [
            { type: "addRules", rules: [{ toolName: "Read" }] },
          ],
        },
      },
      {
        optionId: "no",
        name: "No",
        kind: "deny",
        response: { decision: "deny" },
      },
    ],
  };
  const mapped = mapZcodePermission(source, "native", "acp");
  assert.equal(mapped.request.sessionId, "acp");
  assert.deepEqual(mapped.choices[0]?.response, source.options[0]?.response);
  assert.throws(
    () =>
      mapZcodePermission(
        {
          ...source,
          options: [
            {
              optionId: "fake",
              name: "Allow",
              kind: "allow_once",
              response: { decision: "deny" },
            },
          ],
        },
        "native",
        "acp",
      ),
    /语义不一致/,
  );
  assert.throws(
    () => mapZcodePermission(source, "another", "acp"),
    /会话不匹配/,
  );
});
