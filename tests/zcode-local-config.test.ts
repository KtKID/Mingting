import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
  symlink,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { prepareZcodeLocal } from "../scripts/prepare-zcode-local.js";

const providerId = "account:bigmodel-individual-coding-plan" as const;
const key = `account-provider:coding-plan:${providerId}:account:fixture-account:api-key`;
async function fixture() {
  await mkdir("var", { recursive: true });
  const root = await mkdtemp(resolve("var/zcode-config-test-"));
  const sourcePath = join(root, "source.json"),
    builtinPath = join(root, "builtin.json");
  await writeFile(
    sourcePath,
    JSON.stringify({
      [key]: "enc:v1:unused-old-api-key",
      "oauth:bigmodel:access_token": "enc:v1:existing-oauth",
      other: "private-unrelated",
    }),
  );
  await writeFile(
    builtinPath,
    JSON.stringify({ schemaVersion: 1, config: {} }),
  );
  return {
    root,
    sourcePath,
    builtinPath,
    options: {
      projectRoot: root,
      sourcePath,
      builtinPath,
      accountRoot: "account",
      providerConfigPath: "provider.json",
      providerId,
      modelId: "GLM-5.3" as const,
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}
test("Z4a project setup preserves encrypted login, binds one account and keeps source unchanged", async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.sourcePath, "utf8");
    const result = await prepareZcodeLocal(f.options);
    const expected = {
      "oauth:bigmodel:access_token": "enc:v1:existing-oauth",
      [`account-provider:${providerId}:identity`]: "fixture-account",
      [`account-provider:${providerId}:auth-source`]: "oauth",
    };
    assert.equal(
      await readFile(result.credentialsPath, "utf8"),
      JSON.stringify(expected, null, 2) + "\n",
    );
    assert.equal(await readFile(f.sourcePath, "utf8"), before);
    assert.equal((await stat(result.credentialsPath)).mode & 0o777, 0o600);
    assert.equal(
      (await stat(join(f.root, "account/.zcode/v2"))).mode & 0o777,
      0o700,
    );
    assert.match(await readFile(result.providerConfigPath, "utf8"), /GLM-5.3/);
    assert.deepEqual(await prepareZcodeLocal(f.options), result);
  } finally {
    await f.close();
  }
});
test("Z4a missing or ambiguous accounts and absent encrypted OAuth fail before writing", async () => {
  const f = await fixture();
  try {
    for (const records of [
      {},
      { [key]: "enc:v1:key" },
      {
        [key]: "enc:v1:key",
        [key.replace("fixture-account", "another-account")]: "enc:v1:key",
        "oauth:bigmodel:access_token": "enc:v1:oauth",
      },
    ]) {
      await writeFile(f.sourcePath, JSON.stringify(records));
      await assert.rejects(prepareZcodeLocal(f.options));
      await assert.rejects(stat(join(f.root, "account")));
    }
  } finally {
    await f.close();
  }
});
test("Z4a setup rejects outside-project paths and symlink destinations", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      prepareZcodeLocal({ ...f.options, accountRoot: "../outside" }),
      /项目目录内/,
    );
    await mkdir(join(f.root, "external"));
    await symlink(join(f.root, "external"), join(f.root, "account"));
    await assert.rejects(prepareZcodeLocal(f.options), /实体目录/);
    assert.equal(
      await readFile(f.sourcePath, "utf8"),
      JSON.stringify({
        [key]: "enc:v1:unused-old-api-key",
        "oauth:bigmodel:access_token": "enc:v1:existing-oauth",
        other: "private-unrelated",
      }),
    );
  } finally {
    await f.close();
  }
});
