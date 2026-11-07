import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const configSchema = z.strictObject({
  tasks: z.strictObject({
    wakeupResultTextLimit: z.int().positive(),
  }),
});

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
