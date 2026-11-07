import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
  approvalBatchSchema,
  approvalHistorySchema,
} from "../../shared/approval-replay.js";

/** 从审批回归归档读取有清单的批次，按开始时间由新到旧返回。 */
export async function readApprovalHistory(root: string) {
  const entries = await readdir(resolve(root, "runs"), {
    withFileTypes: true,
  }).catch((error: unknown) => {
    // 归档目录缺失时返回空列表，其余读取错误交给调用方。
    if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success)
      return [];
    throw error;
  });
  const runs = await Promise.all(
    entries
      .filter(
        /* 只读取以批次 UUID 命名的目录。 */ (entry) =>
          entry.isDirectory() &&
          z.string().uuid().safeParse(entry.name).success,
      )
      .map(async (entry) => {
        // 读取并校验单个批次的清单。
        const text = await readFile(
          resolve(root, "runs", entry.name, "manifest.json"),
          "utf8",
        ).catch((error: unknown) => {
          // 单批清单缺失时跳过该批次，其余读取错误向上抛出。
          if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success)
            return undefined;
          throw error;
        });
        if (!text) return undefined;
        const batch = approvalBatchSchema.parse(JSON.parse(text));
        if (batch.id !== entry.name)
          throw new Error("审批批次目录与记录不一致");
        return batch;
      }),
  );
  const complete = runs.filter(
    /* 只保留成功读取到清单的批次。 */ (batch) => batch !== undefined,
  );
  complete.sort(
    /* 最新的开始时间排在前面，同一时刻按批次 ID 倒序。 */ (a, b) =>
      b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id),
  );
  return approvalHistorySchema.parse({ version: 1, runs: complete });
}
