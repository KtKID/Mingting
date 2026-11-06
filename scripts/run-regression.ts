import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { once } from "node:events";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  createApprovalArchive,
  freezeApprovalInputs,
  refreshApprovalCases,
  saveApprovalArchive,
  finishApprovalArchive,
  preserveManualReport,
  type ApprovalArchive,
} from "./approval-archive.js";
import {
  regressionStageSchema,
  uiRegressionStageSchema,
} from "../src/shared/approval-replay.js";

const POLL_MS = 500;
export async function runStage(
  archive: ApprovalArchive,
  name: z.infer<typeof regressionStageSchema>["name"] | "ui",
  args: string[],
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
  mirror = true,
) {
  const startedAt = new Date().toISOString();
  const file = resolve(archive.directory, name + ".log");
  const log = createWriteStream(file, { flags: "wx" });
  const logClosed = once(log, "close");
  const child = spawn("npm", args, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  if (mirror) {
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
  }
  let ended = false;
  const exit = new Promise<number>((done) => {
    child.once("error", (error) => {
      log.write(String(error) + "\n");
      ended = true;
      done(127);
    });
    child.once("close", (code) => {
      ended = true;
      done(code ?? 130);
    });
  });
  let killTimer: NodeJS.Timeout | undefined;
  const stop = () => {
    const pid = child.pid;
    if (!pid || ended) return;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-pid, signal);
      } catch {}
    };
    kill("SIGTERM");
    killTimer = setTimeout(() => kill("SIGKILL"), 2000);
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  try {
    while (!ended) {
      await Promise.race([exit, delay(POLL_MS)]);
      await refreshApprovalCases(archive);
    }
    const exitCode = await exit;
    log.end();
    await logClosed;
    const stage = {
      name,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode,
      logPath: `runs/${archive.id}/${name}.log`,
    };
    if (name === "ui")
      archive.manifest.uiStage = uiRegressionStageSchema.parse(stage);
    else archive.manifest.stages.push(regressionStageSchema.parse(stage));
    await saveApprovalArchive(archive);
    return exitCode;
  } finally {
    signal.removeEventListener("abort", stop);
    clearTimeout(killTimer);
    if (!ended) stop();
  }
}

export async function runRegression(approvalOnly = false) {
  const root = resolve("reports/approval-e2e");
  const archive = await createApprovalArchive(
    root,
    approvalOnly ? "approval" : "default",
  );
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  console.log(`审批回归批次 ${archive.id}；记录：${archive.directory}`);
  let exitCode = 1;
  try {
    await preserveManualReport(root);
    await freezeApprovalInputs(archive);
    const privateDirectory = resolve("var/approval-regression", archive.id);
    await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      APPROVAL_REGRESSION_ID: archive.id,
      APPROVAL_REGRESSION_DIR: archive.directory,
      APPROVAL_RECORDING_PATH: resolve(
        archive.directory,
        "inputs/recording.json",
      ),
      APPROVAL_REGRESSION_DB: resolve(privateDirectory, "platform.sqlite"),
      UI_REGRESSION_DB: resolve(privateDirectory, "ui.sqlite"),
    };
    if (!approvalOnly && !controller.signal.aborted)
      await runStage(
        archive,
        "unit",
        ["run", "test:unit"],
        controller.signal,
        env,
      );
    if (!controller.signal.aborted) {
      const built = await runStage(
        archive,
        "build",
        ["run", "build"],
        controller.signal,
        env,
      );
      if (built === 0 && !approvalOnly && !controller.signal.aborted)
        await runStage(
          archive,
          "ui",
          ["run", "test:ui"],
          controller.signal,
          env,
        );
      if (built === 0 && !controller.signal.aborted)
        await runStage(
          archive,
          "approval",
          [
            "exec",
            "--",
            "playwright",
            "test",
            "--config",
            "playwright.approval.config.ts",
          ],
          controller.signal,
          env,
        );
    }
    await finishApprovalArchive(
      archive,
      controller.signal.aborted ? "interrupted" : undefined,
    );
    exitCode =
      archive.manifest.status === "passed"
        ? 0
        : controller.signal.aborted
          ? 130
          : 1;
  } catch (error) {
    archive.report.error =
      error instanceof Error ? error.message : String(error);
    await finishApprovalArchive(
      archive,
      controller.signal.aborted ? "interrupted" : "failed",
    );
    console.error(archive.report.error);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    console.log(
      `批次 ${archive.id}：${archive.manifest.passed}/${archive.manifest.caseCount}，${archive.manifest.status}；记录已保留。`,
    );
  }
  return exitCode;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = z
    .array(z.literal("--approval-only"))
    .max(1)
    .parse(process.argv.slice(2));
  process.exitCode = await runRegression(args.includes("--approval-only"));
}
