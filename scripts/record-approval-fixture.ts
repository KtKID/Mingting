import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import { detailSchema } from "../src/shared/protocol.js";
import { recordingSchema } from "./approval-replay-data.js";

const recordingPath = new URL(
  "../reports/zcode-approval-channel/recording.json",
  import.meta.url,
);

const files = [
  "live-success",
  "live-override",
  "live-projection",
  "live-subscriber-deny",
];
const originals = await Promise.all(
  files.map(async (name) => {
    const path = `reports/zcode-approval-channel/${name}.json`;
    const text = await readFile(path, "utf8");
    const { detail } = z
      .object({ detail: detailSchema })
      .parse(JSON.parse(text));
    return {
      detail,
      source: {
        path,
        taskId: detail.task.id,
        sha256: createHash("sha256").update(text).digest("hex"),
      },
    };
  }),
);
const allowed = originals[0]?.detail,
  denied = originals[3]?.detail;
if (!allowed || !denied) throw new Error("真实录制缺少成功或拒绝分支");
const request = allowed.approvals[0]?.request;
const createdAt = allowed.approvals[0]?.createdAt;
if (!request || !createdAt) throw new Error("真实录制缺少审批请求");
const before = allowed.events
  .filter((e) => e.createdAt <= createdAt)
  .map((e) => e.notification.update);
const after = (detail: typeof allowed) =>
  detail.events
    .filter(
      (e) =>
        e.createdAt > (detail.approvals[0]?.createdAt ?? "") &&
        ["tool_call_update", "agent_message_chunk"].includes(
          e.notification.update.sessionUpdate,
        ),
    )
    .map((e) => e.notification.update);
const recording = recordingSchema.parse({
  version: 1,
  sources: originals.map((o) => o.source),
  request,
  before,
  allowed: after(allowed),
  denied: after(denied),
  allowedOutput: allowed.runs[0]?.output,
  deniedOutput: denied.runs[0]?.output,
});
await mkdir(new URL(".", recordingPath), { recursive: true });
await writeFile(recordingPath, JSON.stringify(recording, null, 2) + "\n");
console.log(
  JSON.stringify({
    sources: recording.sources.length,
    before: before.length,
    allowed: recording.allowed.length,
    denied: recording.denied.length,
  }),
);
