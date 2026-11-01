import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { runtime } from "../src/server/runtime.js";

test("Z5 ZCode ACP child uses project account and HOME roots, with native thought/tool streaming", async () => {
  const original = { ...process.env };
  await mkdir("var", { recursive: true });
  const dir = await mkdtemp(resolve("var/zcode-env-test-"));
  try {
    const bin = join(dir, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "zcode"),
      `#!/usr/bin/env node
const write=x=>console.log(JSON.stringify(x));
write({type:"model.streaming",payload:{kind:"reasoning_delta",delta:"读取问候"}});
write({type:"tool.updated",payload:{kind:"scheduled",toolCallId:"t",toolName:"Read",input:{path:"HELLO.txt"}}});
write({type:"tool.updated",payload:{kind:"result",toolCallId:"t",result:{success:true,content:"hi"}}});
const response=JSON.stringify({data:process.env.ZCODE_DATA_BASE_DIR,home:process.env.ZCODE_HOME,userHome:process.env.HOME});
write({type:"model.streaming",payload:{kind:"text_delta",delta:response}});
write({type:"result",sessionId:"env-check",response,projection:{status:"idle"}});`,
      { mode: 0o700 },
    );
    process.env.FAKE_ACP = "0";
    process.env.TASK_AUTH = "existing";
    process.env.TASK_HARNESS = "ZCode";
    process.env.TASK_WORKSPACE = dir;
    process.env.ZCODE_DATA_BASE_DIR = join(dir, "account");
    process.env.ZCODE_HOME = join(dir, "account/.zcode");
    process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = join(dir, "builtin.json");
    process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = join(
      dir,
      "personal.json",
    );
    process.env.PATH = bin + ":" + original.PATH;
    let response = "";
    const kinds: string[] = [];
    await runtime().adapter.execute("你好", new AbortController().signal, {
      session: () => {},
      discovery: () => {},
      permission: async () => ({ outcome: { outcome: "cancelled" } }),
      update: (n) => {
        kinds.push(n.update.sessionUpdate);
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
        userHome: process.env.ZCODE_DATA_BASE_DIR,
      }),
    );
    assert.ok(kinds.includes("agent_thought_chunk"));
    assert.ok(kinds.includes("tool_call"));
    assert.ok(kinds.includes("tool_call_update"));
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    await rm(dir, { recursive: true, force: true });
  }
});
