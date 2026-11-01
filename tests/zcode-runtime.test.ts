import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { runtime } from "../src/server/runtime.js";

test("Z5 ZCode native child receives project account roots while preserving HOME", async () => {
  const original = { ...process.env };
  await mkdir("var", { recursive: true });
  const dir = await mkdtemp(resolve("var/zcode-env-test-"));
  try {
    const bin = join(dir, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "zcode"),
      '#!/usr/bin/env node\nconsole.log(JSON.stringify({sessionId:"env-check",response:JSON.stringify({data:process.env.ZCODE_DATA_BASE_DIR,home:process.env.ZCODE_HOME,userHome:process.env.HOME}),projection:{status:"idle"}}))',
      { mode: 0o700 },
    );
    process.env.FAKE_ACP = "0";
    process.env.TASK_AUTH = "existing";
    process.env.TASK_HARNESS = "ZCode";
    process.env.TASK_WORKSPACE = dir;
    process.env.ZCODE_DATA_BASE_DIR = join(dir, "account");
    process.env.ZCODE_HOME = join(dir, "account/.zcode");
    process.env.PATH = bin + ":" + original.PATH;
    let response = "";
    await runtime().adapter.execute("你好", new AbortController().signal, {
      session: () => {},
      discovery: () => {},
      permission: async () => ({ outcome: { outcome: "cancelled" } }),
      update: (n) => {
        if (
          n.update.sessionUpdate === "agent_message_chunk" &&
          n.update.content.type === "text"
        )
          response += n.update.content.text;
      },
    });
    assert.equal(
      response,
      JSON.stringify({
        data: process.env.ZCODE_DATA_BASE_DIR,
        home: process.env.ZCODE_HOME,
        userHome: original.HOME,
      }),
    );
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    await rm(dir, { recursive: true, force: true });
  }
});
