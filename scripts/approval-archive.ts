import { readFile, writeFile, mkdir, rename, readdir } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import {
  approvalBatchSchema,
  replayReportSchema,
  replayCaseSchema,
  scenarios,
  type ApprovalBatch,
} from "../src/shared/approval-replay.js";
import { readRecordingInput, recordingSchema } from "./approval-replay-data.js";

export async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
  });
  await rename(temporary, path);
}
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export async function preserveManualReport(root: string) {
  const text = await readFile(resolve(root, "run.json"), "utf8").catch(
    (error: unknown) => {
      if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success)
        return undefined;
      throw error;
    },
  );
  if (!text) return;
  const report = replayReportSchema.parse(JSON.parse(text));
  const directory = resolve(root, "runs", report.runId);
  try {
    await readFile(resolve(directory, "manifest.json"));
    return;
  } catch (error) {
    if (!z.object({ code: z.literal("ENOENT") }).safeParse(error).success)
      throw error;
  }
  await mkdir(resolve(directory, "inputs"), { recursive: true });
  const recording = await readFile(resolve(root, "recording.json"), "utf8");
  const inputPath = resolve(directory, "inputs/recording.json");
  await writeFile(inputPath, recording, { flag: "wx" }).catch(
    async (error: unknown) => {
      if (!z.object({ code: z.literal("EEXIST") }).safeParse(error).success)
        throw error;
      if ((await readFile(inputPath, "utf8")) !== recording)
        throw new Error("历史录制内容不同，保留已有输入");
    },
  );
  await atomicJson(resolve(directory, "report.json"), report);
  const passed = report.cases.filter((c) => c.passed).length;
  const manifest = approvalBatchSchema.parse({
    id: report.runId,
    mode: "manual",
    startedAt: report.startedAt,
    finishedAt: report.stopped
      ? (report.cases
          .flatMap((c) => c.steps.map((s) => s.at))
          .sort()
          .at(-1) ?? report.startedAt)
      : null,
    status: report.stopped
      ? passed === report.cases.length
        ? "passed"
        : "failed"
      : "interrupted",
    reportPath: `runs/${report.runId}/report.json`,
    recordingPath: `runs/${report.runId}/inputs/recording.json`,
    recordingSha256: digest(recording),
    caseCount: report.cases.length,
    passed,
    failed: report.cases.filter((c) => c.phase === "失败").length,
    skipped: report.cases.filter((c) => !c.passed && c.phase !== "失败").length,
    stages: [],
  });
  await atomicJson(resolve(directory, "manifest.json"), manifest);
}

export async function createApprovalArchive(
  root: string,
  mode: "default" | "approval",
) {
  await mkdir(resolve(root, "runs"), { recursive: true });
  const id = randomUUID(),
    startedAt = new Date().toISOString();
  const directory = resolve(root, "runs", id);
  await mkdir(directory, { recursive: false });
  await mkdir(resolve(directory, "cases"));
  await mkdir(resolve(directory, "inputs"));
  const manifest = approvalBatchSchema.parse({
    id,
    mode,
    startedAt,
    finishedAt: null,
    status: "running",
    reportPath: `runs/${id}/report.json`,
    recordingPath: `runs/${id}/inputs/recording.json`,
    recordingSha256: null,
    caseCount: scenarios.length,
    passed: 0,
    failed: 0,
    skipped: scenarios.length,
    stages: [],
  });
  const report = replayReportSchema.parse({
    runId: id,
    startedAt,
    platform: "http://127.0.0.1:60391",
    kind: "全自动录制回归",
    stopped: false,
    error: "",
    commandId: "",
    currentCaseId: "",
    sources: [],
    cases: scenarios.map((s) => ({
      ...s,
      taskId: "",
      phase: "未执行",
      detail: null,
      passed: false,
      steps: [],
      checks: [],
      snapshotPath: `runs/${id}/cases/${s.id}.json`,
    })),
  });
  const archive = { root, id, directory, manifest, report };
  await saveApprovalArchive(archive);
  return archive;
}
export type ApprovalArchive = Awaited<ReturnType<typeof createApprovalArchive>>;
export async function saveApprovalArchive(archive: ApprovalArchive) {
  await atomicJson(
    resolve(archive.directory, "report.json"),
    replayReportSchema.parse(archive.report),
  );
  await atomicJson(
    resolve(archive.directory, "manifest.json"),
    approvalBatchSchema.parse(archive.manifest),
  );
}
export async function freezeApprovalInputs(archive: ApprovalArchive) {
  const text = await readRecordingInput();
  await writeFile(resolve(archive.directory, "inputs/recording.json"), text, {
    flag: "wx",
  });
  archive.manifest.recordingSha256 = digest(text);
  const recording = recordingSchema.parse(JSON.parse(text));
  archive.report.sources = recording.sources;
  await mkdir(resolve(archive.directory, "inputs/sources"));
  for (const source of recording.sources) {
    const original = await readFile(source.path, "utf8");
    await writeFile(
      resolve(archive.directory, "inputs/sources", source.taskId + ".json"),
      original,
      { flag: "wx" },
    );
    if (digest(original) !== source.sha256)
      throw new Error("真实录制哈希变化：" + source.taskId);
  }
  const paths = [
    "package.json",
    "playwright.config.ts",
    "playwright.approval.config.ts",
    "scripts/run-regression.ts",
    "scripts/approval-archive.ts",
    "tests/approval-replay-ui.spec.ts",
    "tests/ui.spec.ts",
    "scripts/approval-replay-acp.ts",
    "src/shared/approval-replay.ts",
    "src/server/service.ts",
    "src/server/http.ts",
    "src/connector/connector.ts",
    "src/web/main.tsx",
    "src/web/approval-report.tsx",
  ];
  const hashes = await Promise.all(
    paths.map(async (path) => ({
      path,
      sha256: digest(await readFile(path, "utf8")),
    })),
  );
  await atomicJson(resolve(archive.directory, "baseline.json"), {
    head: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    files: hashes,
  });
  await saveApprovalArchive(archive);
}
export async function refreshApprovalCases(archive: ApprovalArchive) {
  const names = await readdir(resolve(archive.directory, "cases"));
  for (const [index, scenario] of scenarios.entries()) {
    if (!names.includes(scenario.id + ".json")) continue;
    const record = replayCaseSchema.parse(
      JSON.parse(
        await readFile(
          resolve(archive.directory, "cases", scenario.id + ".json"),
          "utf8",
        ),
      ),
    );
    if (record.id !== scenario.id) throw new Error("回归用例文件与编号不一致");
    archive.report.cases[index] = record;
    if (record.phase === "执行中") archive.report.currentCaseId = record.id;
  }
  archive.manifest.passed = archive.report.cases.filter((c) => c.passed).length;
  archive.manifest.failed = archive.report.cases.filter(
    (c) => c.phase === "失败",
  ).length;
  archive.manifest.skipped =
    scenarios.length - archive.manifest.passed - archive.manifest.failed;
  await saveApprovalArchive(archive);
}
export async function finishApprovalArchive(
  archive: ApprovalArchive,
  status?: ApprovalBatch["status"],
) {
  await refreshApprovalCases(archive);
  archive.report.stopped = true;
  archive.manifest.finishedAt = new Date().toISOString();
  const { mode, stages, uiStage } = archive.manifest;
  const failedStages = (uiStage ? [...stages, uiStage] : stages)
    .filter((stage) => stage.exitCode !== 0)
    .map((stage) => `${stage.name} 退出码 ${stage.exitCode}`);
  if (mode === "default" && !uiStage) failedStages.push("网页回归未执行");
  archive.manifest.status =
    status ??
    (failedStages.length === 0 && archive.manifest.passed === scenarios.length
      ? "passed"
      : "failed");
  if (archive.manifest.status !== "passed" && !archive.report.error) {
    archive.report.error =
      failedStages.join("；") || "本轮存在失败或未执行的审批用例";
  }
  await saveApprovalArchive(archive);
}
