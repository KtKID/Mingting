import {
  readFile,
  writeFile,
  mkdir,
  lstat,
  rename,
  chmod,
  rm,
} from "node:fs/promises";
import { resolve, relative, dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { z } from "zod";

const optionsSchema = z
  .object({
    projectRoot: z.string().min(1),
    sourcePath: z.string().min(1),
    builtinPath: z.string().min(1),
    accountRoot: z.string().min(1),
    providerConfigPath: z.string().min(1),
    providerId: z.enum([
      "account:bigmodel-individual-coding-plan",
      "account:zai-individual-coding-plan",
    ]),
    modelId: z.enum(["GLM-5.3", "GLM-5.3-Flash"]),
    reasoningLevel: z.enum(["low", "high", "max"]).default("high"),
  })
  .strict();
const credentialsSchema = z.record(z.string(), z.string());
const locationKeySchema = z.tuple([
  z.string().url(),
  z.enum(["bigmodel", "zai"]),
  z.string(),
  z.null(),
  z.literal(1),
  z.literal("default"),
]);
type Options = z.input<typeof optionsSchema>;

function accountLocations(
  credentials: Record<string, string>,
  family: string,
  identity: string,
) {
  return Object.fromEntries(
    Object.entries(credentials).filter(([key, value]) => {
      if (
        !key.startsWith("project-key-location:v1:") ||
        !value.startsWith("enc:v1:")
      )
        return false;
      try {
        const parsed = locationKeySchema.safeParse(
          JSON.parse(
            decodeURIComponent(key.slice("project-key-location:v1:".length)),
          ),
        );
        return (
          parsed.success &&
          parsed.data[1] === family &&
          parsed.data[2] === identity
        );
      } catch {
        return false;
      }
    }),
  );
}

async function localPath(root: string, value: string) {
  const path = resolve(root, value),
    rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(".." + sep))
    throw new Error("运行配置必须位于项目目录内");
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    const stat = await lstat(current).catch((error: unknown) => {
      const code = z.object({ code: z.string() }).safeParse(error);
      if (code.success && code.data.code === "ENOENT") return undefined;
      throw error;
    });
    if (stat?.isSymbolicLink())
      throw new Error("运行配置路径应使用项目内实体目录");
  }
  return path;
}
async function privateJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

// Explicit setup command. The platform reads only this isolated account after setup.
export async function prepareZcodeLocal(raw: Options) {
  const input = optionsSchema.parse(raw),
    root = resolve(input.projectRoot);
  const accountRoot = await localPath(root, input.accountRoot);
  const credentialsPath = await localPath(
    root,
    join(accountRoot, ".zcode/v2/credentials.json"),
  );
  const builtinPath = await localPath(
    root,
    join(accountRoot, "provider/zcode-builtin.json"),
  );
  const configPath = await localPath(root, input.providerConfigPath);
  if (
    [credentialsPath, builtinPath, configPath].includes(
      resolve(input.sourcePath),
    )
  )
    throw new Error("源登录文件与输出配置应使用独立路径");
  const source = credentialsSchema.parse(
    JSON.parse(await readFile(input.sourcePath, "utf8")),
  );
  const prefix = `account-provider:coding-plan:${input.providerId}:account:`;
  const keys = Object.keys(source).filter(
    (k) => k.startsWith(prefix) && k.endsWith(":api-key"),
  );
  if (keys.length !== 1) throw new Error("所选 provider 需要唯一现有账户绑定");
  const key = keys[0];
  if (!key) throw new Error("缺少现有账户绑定");
  const identity = decodeURIComponent(
    key.slice(prefix.length, -":api-key".length),
  );
  if (!identity.trim()) throw new Error("账户绑定为空");
  const tokenKey = input.providerId.includes(":bigmodel-")
    ? "oauth:bigmodel:access_token"
    : "oauth:zai:access_token";
  const ciphertext = source[tokenKey];
  if (!ciphertext?.startsWith("enc:v1:"))
    throw new Error("需要现有 OAuth 登录的加密凭据");
  const builtin: unknown = JSON.parse(
    await readFile(input.builtinPath, "utf8"),
  );
  z.object({
    schemaVersion: z.literal(1),
    config: z.object({}).passthrough(),
  }).parse(builtin);
  const existing = await readFile(credentialsPath, "utf8")
    .then((text) => credentialsSchema.parse(JSON.parse(text)))
    .catch((error: unknown) => {
      const io = z.object({ code: z.literal("ENOENT") }).safeParse(error);
      if (io.success) return {};
      throw error;
    });
  const family = input.providerId.includes(":bigmodel-") ? "bigmodel" : "zai";
  await privateJson(credentialsPath, {
    [tokenKey]: ciphertext,
    [`account-provider:${input.providerId}:identity`]: identity,
    [`account-provider:${input.providerId}:auth-source`]: "oauth",
    ...accountLocations(existing, family, identity),
    ...accountLocations(source, family, identity),
  });
  await privateJson(builtinPath, builtin);
  await privateJson(configPath, {
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [] },
      modelConfigRules: {
        providerModelRules: [],
        manualProviderModelRules: [],
      },
      defaultModelSelection: {
        providerId: input.providerId,
        modelId: input.modelId,
        options: { reasoningLevel: input.reasoningLevel },
      },
    },
  });
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    accountRoot,
    credentialsPath,
    builtinPath,
    providerConfigPath: configPath,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const { values } = parseArgs({
      options: {
        source: { type: "string" },
        builtin: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
      },
    });
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const result = await prepareZcodeLocal(
      optionsSchema.parse({
        projectRoot: root,
        sourcePath: values.source,
        builtinPath: values.builtin,
        providerId:
          values.provider ?? "account:bigmodel-individual-coding-plan",
        modelId: values.model ?? "GLM-5.3",
        accountRoot: "var/zcode-local",
        providerConfigPath: "var/zcode-provider.json",
      }),
    );
    console.log(JSON.stringify(result, null, 2));
  } catch {
    console.error(
      "ZCode 项目配置初始化失败，请核对源登录、内置配置与唯一账户绑定。",
    );
    process.exitCode = 1;
  }
}
