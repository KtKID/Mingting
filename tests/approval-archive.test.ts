import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import {
  createApprovalArchive,
  freezeApprovalInputs,
  atomicJson,
  finishApprovalArchive,
  preserveManualReport,
} from "../scripts/approval-archive.js";
import { readApprovalHistory } from "../src/server/approval-history.js";
import {
  replayCaseSchema,
  approvalBatchSchema,
} from "../src/shared/approval-replay.js";
import { recordingPath } from "../scripts/approval-replay-data.js";
import { runStage } from "../scripts/run-regression.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
test("RA1 separate batches retain frozen inputs without overwriting earlier results", async () => {
  const root = await mkdtemp(join(tmpdir(), "approval-archive-"));
  try {
    const first = await createApprovalArchive(root, "approval");
    await freezeApprovalInputs(first);
    for (const item of first.report.cases)
      await atomicJson(
        resolve(first.directory, "cases", item.id + ".json"),
        replayCaseSchema.parse({ ...item, passed: true, phase: "通过" }),
      );
    first.manifest.stages.push({
      name: "approval",
      startedAt: first.manifest.startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      logPath: `runs/${first.id}/approval.log`,
    });
    await finishApprovalArchive(first);
    const before = await readFile(
      resolve(first.directory, "report.json"),
      "utf8",
    );
    const second = await createApprovalArchive(root, "default");
    await freezeApprovalInputs(second);
    second.manifest.stages.push({
      name: "build",
      startedAt: second.manifest.startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: 7,
      logPath: `runs/${second.id}/build.log`,
    });
    await finishApprovalArchive(second);
    assert.notEqual(first.id, second.id);
    assert.equal(
      await readFile(resolve(first.directory, "report.json"), "utf8"),
      before,
    );
    assert.equal(first.manifest.status, "passed");
    assert.equal(second.manifest.status, "failed");
    assert.equal(second.manifest.skipped, 10);
    assert.equal(
      hash(
        await readFile(
          resolve(first.directory, "inputs/recording.json"),
          "utf8",
        ),
      ),
      first.manifest.recordingSha256,
    );
    assert.equal(
      first.manifest.recordingSha256,
      second.manifest.recordingSha256,
    );
    const history = await readApprovalHistory(root);
    assert.equal(history.runs.length, 2);
    assert.ok(
      history.runs.some((run) => run.id === first.id && run.passed === 10),
    );
    assert.ok(
      history.runs.some(
        (run) => run.id === second.id && run.stages[0]?.exitCode === 7,
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("RA2 interrupted regression preserves partial results and its input snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "approval-interrupted-"));
  try {
    const archive = await createApprovalArchive(root, "approval");
    await freezeApprovalInputs(archive);
    const item = archive.report.cases[0];
    assert.ok(item);
    await atomicJson(resolve(archive.directory, "cases/R1.json"), {
      ...item,
      phase: "失败",
      checks: [{ label: "浏览器进程中断", passed: false }],
      steps: [{ at: new Date().toISOString(), label: "中断前已捕获审批" }],
    });
    await finishApprovalArchive(archive, "interrupted");
    assert.equal(archive.manifest.status, "interrupted");
    assert.equal(archive.manifest.failed, 1);
    assert.equal(archive.report.cases[0]?.steps.length, 1);
    assert.equal(archive.report.stopped, true);
    assert.ok(archive.manifest.finishedAt);
    assert.ok(
      (
        await readFile(
          resolve(archive.directory, "inputs/recording.json"),
          "utf8",
        )
      ).length,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("RA3 original visible replay is indexed once and its source bytes stay unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "approval-legacy-"));
  try {
    const template = await createApprovalArchive(root, "approval");
    const old = {
      ...template.report,
      runId: randomUUID(),
      platform: "http://127.0.0.1:60390",
      stopped: true,
      cases: template.report.cases.map((item) => ({
        ...item,
        passed: true,
        phase: "通过",
      })),
    };
    const text = JSON.stringify(old),
      input = await readFile(recordingPath, "utf8");
    await writeFile(resolve(root, "run.json"), text);
    await writeFile(resolve(root, "recording.json"), input);
    // Resume a legacy migration interrupted after copying only its immutable input.
    await mkdir(resolve(root, "runs", old.runId, "inputs"), {
      recursive: true,
    });
    await writeFile(
      resolve(root, "runs", old.runId, "inputs/recording.json"),
      input,
    );
    await preserveManualReport(root);
    await preserveManualReport(root);
    assert.equal(await readFile(resolve(root, "run.json"), "utf8"), text);
    assert.equal(
      await readFile(resolve(root, "recording.json"), "utf8"),
      input,
    );
    const entries = (await readApprovalHistory(root)).runs.filter(
      (run) => run.id === old.runId,
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.mode, "manual");
    assert.equal(entries[0]?.passed, 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("RA4 history ignores unfinished folders and surfaces corrupt manifests", async () => {
  const root = await mkdtemp(join(tmpdir(), "approval-history-"));
  try {
    const id = randomUUID();
    await mkdir(resolve(root, "runs", id), { recursive: true });
    assert.equal((await readApprovalHistory(root)).runs.length, 0);
    await writeFile(resolve(root, "runs", id, "manifest.json"), "{}");
    await assert.rejects(readApprovalHistory(root));
    assert.throws(() => approvalBatchSchema.parse({ id }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("RA5 a real failed subprocess retains exit status, full log and frozen input", async () => {
  const root = await mkdtemp(join(tmpdir(), "approval-failed-stage-"));
  try {
    const archive = await createApprovalArchive(root, "default");
    await freezeApprovalInputs(archive);
    const code = await runStage(
      archive,
      "build",
      ["run", "approval-retention-fixture-missing-script"],
      new AbortController().signal,
      process.env,
      false,
    );
    assert.notEqual(code, 0);
    await finishApprovalArchive(archive);
    assert.equal(archive.manifest.status, "failed");
    assert.equal(archive.manifest.stages[0]?.exitCode, code);
    assert.ok(
      (await readFile(resolve(archive.directory, "build.log"), "utf8")).length >
        0,
    );
    assert.equal(
      hash(
        await readFile(
          resolve(archive.directory, "inputs/recording.json"),
          "utf8",
        ),
      ),
      archive.manifest.recordingSha256,
    );
    assert.equal((await readApprovalHistory(root)).runs[0]?.status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default regression requires a successful browser stage", async () => {
  const root = await mkdtemp(join(tmpdir(), "approval-default-ui-"));
  try {
    for (const exitCode of [undefined, 1, 0]) {
      const archive = await createApprovalArchive(root, "default");
      for (const item of archive.report.cases)
        await atomicJson(
          resolve(archive.directory, "cases", item.id + ".json"),
          {
            ...item,
            passed: true,
            phase: "通过",
          },
        );
      const stage = (name: string, code: number) => ({
        startedAt: archive.manifest.startedAt,
        finishedAt: archive.manifest.startedAt,
        exitCode: code,
        logPath: `runs/${archive.id}/${name}.log`,
      });
      for (const name of ["unit", "build", "approval"] as const)
        archive.manifest.stages.push({ name, ...stage(name, 0) });
      if (exitCode !== undefined)
        archive.manifest.uiStage = { name: "ui", ...stage("ui", exitCode) };
      await finishApprovalArchive(archive);
      assert.equal(
        archive.manifest.status,
        exitCode === 0 ? "passed" : "failed",
      );
      if (exitCode === undefined) assert.match(archive.report.error, /网页/);
      if (exitCode === 1) assert.match(archive.report.error, /ui.*1/);
      const saved = JSON.parse(
        await readFile(resolve(archive.directory, "manifest.json"), "utf8"),
      );
      assert.deepEqual(
        approvalBatchSchema
          .omit({ uiStage: true })
          .parse(saved)
          .stages.map((result) => result.name),
        ["unit", "build", "approval"],
      );
      assert.equal(
        approvalBatchSchema.parse(saved).uiStage?.exitCode,
        exitCode,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
