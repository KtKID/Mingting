import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
  approvalBatchSchema,
  approvalHistorySchema,
} from "../shared/approval-replay.js";

export async function readApprovalHistory(root: string) {
  const entries = await readdir(resolve(root, "runs"), {
    withFileTypes: true,
  }).catch((error: unknown) => {
    if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success)
      return [];
    throw error;
  });
  const runs = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          z.string().uuid().safeParse(entry.name).success,
      )
      .map(async (entry) => {
        const text = await readFile(
          resolve(root, "runs", entry.name, "manifest.json"),
          "utf8",
        ).catch((error: unknown) => {
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
  const complete = runs.filter((batch) => batch !== undefined);
  complete.sort(
    (a, b) =>
      b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id),
  );
  return approvalHistorySchema.parse({ version: 1, runs: complete });
}
