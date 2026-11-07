import { lstatSync, mkdirSync } from "node:fs";
import { resolve, relative, isAbsolute, sep, join } from "node:path";
import { z } from "zod";

/** 解析项目内路径，并逐段拒绝已存在的符号链接。 */
export function projectPath(value: string): string {
  const path = resolve(value),
    rel = relative(process.cwd(), path);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
    throw new Error("Harness 状态与配置应位于项目目录内");
  let current = process.cwd();
  for (const part of rel.split(sep)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new Error("Harness 配置应使用项目内实体路径");
    } catch (error) {
      const parsed = z.object({ code: z.string() }).safeParse(error);
      if (parsed.success && parsed.data.code === "ENOENT") continue;
      throw error;
    }
  }
  return path;
}
/** 校验目标路径后，以 0700 权限创建缺失的项目内目录。 */
export function projectDirectory(value: string): string {
  const path = projectPath(value);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}
