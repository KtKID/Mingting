import { createHash, createDecipheriv } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const selectionSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
  options: z.record(z.string(), z.unknown()).optional(),
});
const personalSchema = z.object({
  config: z.object({ defaultModelSelection: selectionSchema }),
});
const builtinSchema = z.object({
  revision: z.number().optional(),
  config: z.object({
    providerConfigRules: z.object({
      providerRules: z.array(
        z.object({
          providerId: z.string(),
          config: z.object({
            builtinModelIds: z.array(z.string()).optional(),
            access: z
              .object({
                type: z.string(),
                accountType: z.string().optional(),
                mode: z.string().optional(),
              })
              .optional(),
          }),
        }),
      ),
    }),
  }),
});
const credentialsSchema = z.record(z.string(), z.string());
const locationSchema = z.object({
  organizationId: z.string().min(1),
  projectId: z.string().min(1),
  apiKeyId: z.string().min(1),
});
const cacheKeySchema = z.tuple([
  z.string().url(),
  z.string(),
  z.string(),
  z.null(),
  z.literal(1), // Native API_KEY_USAGE_SCENE.CODING_PLAN.
  z.string(),
]);
const tokenSchema = z.object({
  code: z.union([
    z.literal(0),
    z.literal(200),
    z.literal("0"),
    z.literal("200"),
  ]),
  data: z.object({
    enable: z.literal(true).default(true),
    accessToken: z.string().min(1),
    tokenType: z.literal("Bearer"),
    expiresIn: z.number().positive(),
    expiresAt: z.number().positive(),
  }),
});
const requestSchema = z.object({
  providerId: z.string(),
  sessionId: z.string(),
  expectedAccountScope: z.string().optional(),
  rejectedProjectTokenFingerprint: z.string().optional(),
});

async function readProjectJson(path: string) {
  const root = await realpath(
    resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  );
  const actual = await realpath(path);
  const rel = relative(root, actual);
  if (
    !rel ||
    rel === ".." ||
    rel.startsWith(".." + sep) ||
    isAbsolute(rel) ||
    actual !== resolve(path)
  )
    throw new Error("ZCode 账户文件须使用项目内实体路径");
  return JSON.parse(await readFile(actual, "utf8")) as unknown;
}
export function decryptZcodeCredential(value: string, secret: string) {
  if (!value.startsWith("enc:v1:")) return value;
  try {
    const [iv, tag, data] = z
      .tuple([z.string().min(1), z.string().min(1), z.string().min(1)])
      .parse(value.slice(7).split("."));
    if (
      Buffer.from(iv, "base64url").length !== 12 ||
      Buffer.from(tag, "base64url").length !== 16
    )
      throw new Error("invalid cipher envelope");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      createHash("sha256").update(secret).digest(),
      Buffer.from(iv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(data, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("ZCode 项目登录解密失败");
  }
}

// The native app-server delegates account ownership to its host. Reuse only the
// existing project account and native key-location cache; short-lived tokens stay in memory.
export async function loadZcodeAccount(
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
) {
  const personalPath = env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  const builtinPath = env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  if (!personalPath && !builtinPath) return undefined;
  if (
    !personalPath ||
    !builtinPath ||
    !env.ZCODE_DATA_BASE_DIR ||
    !env.ZCODE_CREDENTIAL_SECRET
  )
    throw new Error("ZCode 项目账户配置不完整");
  const selection = personalSchema.parse(await readProjectJson(personalPath))
    .config.defaultModelSelection;
  const builtin = builtinSchema.parse(await readProjectJson(builtinPath));
  const provider = builtin.config.providerConfigRules.providerRules.find(
    (rule) => rule.providerId === selection.providerId,
  );
  if (
    provider?.config.access?.type !== "zhipu-account" ||
    provider.config.access.accountType !== "bigmodel" ||
    provider.config.access.mode !== "individual-coding-plan"
  )
    throw new Error(
      "当前 ZCode ACP 账户通道需要项目内 BigModel OAuth Coding Plan",
    );
  const credentialsPath = resolve(
    env.ZCODE_DATA_BASE_DIR,
    ".zcode/v2/credentials.json",
  );
  const secret = env.ZCODE_CREDENTIAL_SECRET;
  const readIdentity = async () => {
    const credentials = credentialsSchema.parse(
      await readProjectJson(credentialsPath),
    );
    const identity = decryptZcodeCredential(
      z
        .string()
        .min(1)
        .parse(
          credentials[`account-provider:${selection.providerId}:identity`],
        ),
      secret,
    );
    const source = decryptZcodeCredential(
      credentials[`account-provider:${selection.providerId}:auth-source`] ?? "",
      secret,
    );
    const oauth = decryptZcodeCredential(
      z.string().min(1).parse(credentials["oauth:bigmodel:access_token"]),
      secret,
    );
    if (source !== "oauth")
      throw new Error("ZCode 项目账户需要现有 OAuth 登录");
    return {
      credentials,
      identity,
      oauth,
      scope: createHash("sha256")
        .update(
          JSON.stringify([selection.providerId, "bigmodel", identity, oauth]),
        )
        .digest("hex"),
    };
  };
  const initial = await readIdentity();
  let cached:
    | { token: string; expiresAt: number; apiKeyId: string; scope: string }
    | undefined;
  let resolving: Promise<NonNullable<typeof cached>> | undefined;
  const refresh = async () => {
    const owner = await readIdentity();
    if (owner.scope !== initial.scope)
      throw new Error("ZCode 项目登录已改变，请重建会话");
    const saved = Object.entries(owner.credentials).flatMap(([key, value]) => {
      if (!key.startsWith("project-key-location:v1:")) return [];
      try {
        const parsed = cacheKeySchema.safeParse(
          JSON.parse(
            decodeURIComponent(key.slice("project-key-location:v1:".length)),
          ),
        );
        if (
          !parsed.success ||
          parsed.data[1] !== "bigmodel" ||
          parsed.data[2] !== owner.identity ||
          parsed.data[5] !== "default"
        )
          return [];
        const url = new URL(parsed.data[0]);
        if (
          url.protocol !== "https:" ||
          !["bigmodel.cn", "open.bigmodel.cn"].includes(url.hostname) ||
          url.port ||
          url.username ||
          url.password ||
          url.pathname !== "/"
        )
          return [];
        return [
          {
            origin: url.origin,
            location: locationSchema.parse(
              JSON.parse(decryptZcodeCredential(value, secret)),
            ),
          },
        ];
      } catch {
        return [];
      }
    });
    if (saved.length !== 1 || !saved[0])
      throw new Error(
        "ZCode 项目缺少唯一有效的既有 Coding Plan 位置缓存，请先通过原生 CLI 初始化",
      );
    const { origin, location } = saved[0];
    const endpoint = `${origin}/api/biz/v1/organization/${encodeURIComponent(location.organizationId)}/projects/${encodeURIComponent(location.projectId)}/api_keys/${encodeURIComponent(location.apiKeyId)}/access_tokens`;
    try {
      const response = await request(endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${owner.oauth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ clientType: "zcode", clientVersion: "0.17.1" }),
      });
      if (!response.ok) throw new Error("request failed");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("missing response body");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 65536) throw new Error("response too large");
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const text = Buffer.concat(chunks).toString("utf8");
      const result = tokenSchema.parse(JSON.parse(text)).data;
      if (result.expiresAt * (result.expiresAt < 1e12 ? 1000 : 1) <= Date.now())
        throw new Error("expired token");
      if ((await readIdentity()).scope !== owner.scope)
        throw new Error("identity changed");
      return {
        token: result.accessToken,
        expiresAt: result.expiresAt,
        apiKeyId: location.apiKeyId,
        scope: owner.scope,
      };
    } catch {
      throw new Error("ZCode 项目短期令牌获取失败");
    }
  };
  return {
    selection,
    overlay: {
      revision: "mingting-account:" + initial.scope,
      basedOnZCodeBuiltinRevision: `zcode-builtin:${builtin.revision ?? 0}:${createHash("sha256").update(resolve(builtinPath)).digest("hex")}`,
      providers: {
        [selection.providerId]: {
          builtinModelIds: provider.config.builtinModelIds,
          access: { type: "zhipu-account", entitled: true },
        },
      },
      states: {
        [selection.providerId]: {
          availability: "available",
          entitled: true,
          current: true,
        },
      },
    },
    async headers(value: unknown, sessionId: string) {
      const input = requestSchema.parse(value);
      if (
        input.sessionId !== sessionId ||
        input.providerId !== selection.providerId ||
        (input.expectedAccountScope &&
          input.expectedAccountScope !== initial.scope) ||
        (await readIdentity()).scope !== initial.scope
      )
        throw new Error("ZCode 请求期账户身份不匹配");
      const rejected = input.rejectedProjectTokenFingerprint;
      if (
        cached &&
        rejected === createHash("sha256").update(cached.token).digest("hex")
      )
        cached = undefined;
      if (
        !cached ||
        cached.expiresAt * (cached.expiresAt < 1e12 ? 1000 : 1) - Date.now() <
          120000
      ) {
        resolving ??= refresh();
        try {
          cached = await resolving;
        } finally {
          resolving = undefined;
        }
      }
      return {
        headersApplied: true,
        requestAuth: {
          apiKey: cached.token,
          apiKeyId: cached.apiKeyId,
          accountScope: cached.scope,
        },
      };
    },
  };
}
