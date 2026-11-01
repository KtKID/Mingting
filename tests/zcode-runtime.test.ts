import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { runtime } from "../src/server/runtime.js";
import { fakeZcodeNative } from "./zcode-fixture.js";

test("Z5 ZCode ACP child uses project account and HOME roots, with native thought/tool streaming", async () => {
  const original = { ...process.env };
  await mkdir("var", { recursive: true });
  const dir = await mkdtemp(resolve("var/zcode-env-test-"));
  try {
    const bin = join(dir, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "zcode"), fakeZcodeNative, { mode: 0o700 });
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
    await writeFile(
      process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE,
      JSON.stringify({
        config: {
          defaultModelSelection: {
            providerId: "account:test",
            modelId: "test",
          },
        },
      }),
    );
    await writeFile(
      process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
      JSON.stringify({
        config: {
          providerConfigRules: {
            providerRules: [
              {
                providerId: "account:test",
                config: {
                  access: {
                    type: "zhipu-account",
                    accountType: "bigmodel",
                    mode: "individual-coding-plan",
                  },
                },
              },
            ],
          },
        },
      }),
    );
    await mkdir(join(dir, "account/.zcode/v2"), { recursive: true });
    await writeFile(
      join(dir, "account/.zcode/v2/credentials.json"),
      JSON.stringify({
        "account-provider:account:test:identity": "test",
        "account-provider:account:test:auth-source": "oauth",
        "oauth:bigmodel:access_token": "test",
      }),
    );
    let response = "";
    const kinds: string[] = [];
    await runtime().adapter.execute("env-check", new AbortController().signal, {
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
