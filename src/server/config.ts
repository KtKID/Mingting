import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { LIMITS } from "../shared/protocol.js";

const frameAncestorSchema = z.url().refine((value) => {
  const origin = new URL(value);
  return (
    origin.protocol === "http:" &&
    origin.hostname === "127.0.0.1" &&
    origin.origin === value
  );
}, "web.frameAncestor 需要本机 KMH 的 HTTP 来源，如 http://127.0.0.1:60000");

const configSchema = z.strictObject({
  web: z
    .strictObject({ frameAncestor: frameAncestorSchema.optional() })
    .optional(),
  tasks: z.strictObject({
    wakeupResultTextLimit: z.int().positive(),
    runReportBodyBytes: z
      .int()
      .positive()
      .default(LIMITS.acpBytes + 64 * 1024),
    approvalWaitMs: z.int32().nonnegative().default(LIMITS.approvalWaitMs),
  }),
});

/** 读取并校验 YAML 配置，解析失败时在错误中带上文件路径。 */
export function loadConfig(
  path: string | URL = new URL("../../config.yaml", import.meta.url),
) {
  try {
    const raw: unknown = parse(readFileSync(path, "utf8"));
    return configSchema.parse(raw);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`无法读取明庭配置 ${path}：${detail}`, { cause });
  }
}
