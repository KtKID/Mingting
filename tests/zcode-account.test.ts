import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import {
  loadZcodeAccount,
  decryptZcodeCredential,
} from "../src/server/zcode-account.js";

const providerId = "account:bigmodel-individual-coding-plan";
function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    createHash("sha256").update("test-secret").digest(),
    iv,
  );
  const data = Buffer.concat([cipher.update(value), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${data.toString("base64url")}`;
}
async function fixture(origin = "https://bigmodel.cn") {
  await mkdir("var", { recursive: true });
  const dir = await mkdtemp(resolve("var/zcode-auth-test-"));
  const state = join(dir, ".zcode/v2");
  await mkdir(state, { recursive: true });
  const credentials = {
    [`account-provider:${providerId}:identity`]: "test-account",
    [`account-provider:${providerId}:auth-source`]: "oauth",
    "oauth:bigmodel:access_token": encrypt("oauth-test-value"),
    ["project-key-location:v1:" +
    encodeURIComponent(
      JSON.stringify([origin, "bigmodel", "test-account", null, 1, "default"]),
    )]: encrypt(
      JSON.stringify({
        organizationId: "org",
        projectId: "project",
        apiKeyId: "key-id",
      }),
    ),
  };
  const credentialsPath = join(state, "credentials.json");
  const personal = join(dir, "personal.json"),
    builtin = join(dir, "builtin.json");
  await writeFile(credentialsPath, JSON.stringify(credentials));
  await writeFile(
    personal,
    JSON.stringify({
      config: {
        defaultModelSelection: {
          providerId,
          modelId: "GLM-5.3",
          options: { reasoningLevel: "high" },
        },
      },
    }),
  );
  await writeFile(
    builtin,
    JSON.stringify({
      revision: 43,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId,
              config: {
                builtinModelIds: ["GLM-5.3"],
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
  const env = {
    ZCODE_DATA_BASE_DIR: dir,
    ZCODE_CREDENTIAL_SECRET: "test-secret",
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
  };
  return {
    dir,
    env,
    credentials,
    credentialsPath,
    personal,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
const response = () =>
  new Response(
    JSON.stringify({
      code: 200,
      data: {
        accessToken: "ephemeral-test-value",
        tokenType: "Bearer",
        expiresIn: 3600,
        expiresAt: Date.now() + 3600000,
      },
    }),
  );

test("O1 project OAuth overlay and request-only token preserve identity, model and cache scope", async () => {
  const f = await fixture();
  let requests = 0;
  try {
    const account = await loadZcodeAccount(f.env, async (url, init) => {
      requests++;
      assert.equal(
        String(url),
        "https://bigmodel.cn/api/biz/v1/organization/org/projects/project/api_keys/key-id/access_tokens",
      );
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer oauth-test-value",
      );
      assert.equal(init?.redirect, "error");
      return response();
    });
    if (!account) throw new Error("missing account");
    assert.equal(account.selection.options?.reasoningLevel, "high");
    assert.doesNotMatch(
      JSON.stringify(account.overlay),
      /oauth-test-value|ephemeral-test-value/,
    );
    const input = { sessionId: "s", providerId };
    const results = await Promise.all([
      account.headers(input, "s"),
      account.headers(input, "s"),
    ]);
    assert.equal(requests, 1);
    assert.equal(results[0]?.requestAuth.apiKey, "ephemeral-test-value");
    await account.headers(
      { ...input, expectedAccountScope: results[0]?.requestAuth.accountScope },
      "s",
    );
    assert.equal(requests, 1);
    await account.headers(
      {
        ...input,
        rejectedProjectTokenFingerprint: createHash("sha256")
          .update("ephemeral-test-value")
          .digest("hex"),
      },
      "s",
    );
    assert.equal(requests, 2);
    await assert.rejects(
      account.headers({ ...input, providerId: "another" }, "s"),
      /身份不匹配/,
    );
    await assert.rejects(account.headers(input, "wrong-session"), /身份不匹配/);
    await assert.rejects(
      account.headers({ ...input, expectedAccountScope: "changed" }, "s"),
      /身份不匹配/,
    );
  } finally {
    await f.cleanup();
  }
});

test("O2 untrusted saved token origin causes zero credential transmissions", async () => {
  for (const origin of ["https://evil.example", "http://bigmodel.cn"]) {
    const f = await fixture(origin);
    let requests = 0;
    try {
      const account = await loadZcodeAccount(f.env, async () => {
        requests++;
        return response();
      });
      if (!account) throw new Error("missing account");
      await assert.rejects(
        account.headers({ sessionId: "s", providerId }, "s"),
        /位置缓存/,
      );
      assert.equal(requests, 0);
    } finally {
      await f.cleanup();
    }
  }
});

test("O3 OAuth identity change rejects existing sessions and late token responses", async () => {
  const f = await fixture();
  try {
    const account = await loadZcodeAccount(f.env, async () => {
      await writeFile(
        f.credentialsPath,
        JSON.stringify({
          ...f.credentials,
          "oauth:bigmodel:access_token": encrypt("rotated-oauth"),
        }),
      );
      return response();
    });
    if (!account) throw new Error("missing account");
    await assert.rejects(
      account.headers({ sessionId: "s", providerId }, "s"),
      /短期令牌获取失败/,
    );
    await assert.rejects(
      account.headers({ sessionId: "s", providerId }, "s"),
      /身份不匹配/,
    );
  } finally {
    await f.cleanup();
  }
});

test("O4 invalid, expired and oversized token responses produce redacted errors", async () => {
  const f = await fixture();
  try {
    for (const body of [
      "secret-invalid-json",
      JSON.stringify({
        code: 200,
        data: { enable: false, accessToken: "secret" },
      }),
      JSON.stringify({
        code: 200,
        data: {
          accessToken: "secret",
          tokenType: "Bearer",
          expiresIn: 1,
          expiresAt: 1,
        },
      }),
      "secret".repeat(20000),
    ]) {
      const account = await loadZcodeAccount(
        f.env,
        async () => new Response(body),
      );
      if (!account) throw new Error("missing account");
      await assert.rejects(
        account.headers({ sessionId: "s", providerId }, "s"),
        (error: unknown) =>
          error instanceof Error &&
          error.message === "ZCode 项目短期令牌获取失败" &&
          !String(error.cause).includes("secret"),
      );
    }
  } finally {
    await f.cleanup();
  }
});

test("O5 credential corruption and file symlinks fail closed; absent account configuration stays optional", async () => {
  assert.equal(await loadZcodeAccount({}), undefined);
  assert.equal(
    decryptZcodeCredential(encrypt("test-value"), "test-secret"),
    "test-value",
  );
  assert.throws(
    () => decryptZcodeCredential(encrypt("test-value"), "wrong"),
    /解密失败/,
  );
  const f = await fixture();
  try {
    const link = join(f.dir, "personal-link.json");
    await symlink(f.personal, link);
    await assert.rejects(
      loadZcodeAccount({ ...f.env, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: link }),
      /实体路径/,
    );
  } finally {
    await f.cleanup();
  }
});
