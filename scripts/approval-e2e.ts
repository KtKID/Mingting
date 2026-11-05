import {
  readFile,
  writeFile,
  mkdir,
  rename,
  access,
  stat,
} from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CodexAdapter } from "../src/server/codex-adapter.js";
import { TaskConnector } from "../src/connector/connector.js";
import { localBase } from "../src/connector/transport.js";
import {
  bootstrapSchema,
  detailSchema,
  publishResultSchema,
  approvalSnapshotSchema,
  LIMITS,
  type TaskDetail,
  type ApprovalSubscription,
} from "../src/shared/protocol.js";
import {
  scenarios,
  commandSchema,
  loadRecording,
  optionFor,
} from "./approval-replay-data.js";
import { replayReportSchema } from "../src/shared/approval-replay.js";

const privateRoot = resolve("var/approval-e2e"),
  reportRoot = resolve("reports/approval-e2e");
const commandPath = resolve(privateRoot, "command.json");
await mkdir(privateRoot, { recursive: true, mode: 0o700 });
if (process.argv[2] === "control") {
  const command = commandSchema.parse({
    id: randomUUID(),
    caseId: process.argv[3] ?? "",
    action: process.argv[4],
    label: process.argv[5] ?? "",
    ...(process.argv[6] ? { image: process.argv[6] } : {}),
  });
  await writeFile(commandPath + ".tmp", JSON.stringify(command), {
    mode: 0o600,
  });
  await rename(commandPath + ".tmp", commandPath);
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    const report = await readFile(resolve(reportRoot, "run.json"), "utf8")
      .then((text) => replayReportSchema.parse(JSON.parse(text)))
      .catch(() => undefined);
    if (report?.commandId === command.id) {
      if (report.error) throw new Error(report.error);
      const current = report.cases.find((c) => c.id === command.caseId);
      if (command.action !== "start" || current?.detail?.approvals.length)
        break;
    }
    await delay(100);
  }
  console.log(
    JSON.stringify({
      caseId: command.caseId,
      action: command.action,
      commandId: command.id,
    }),
  );
} else {
  const base = localBase(
    process.env.APPROVAL_E2E_URL ?? "http://127.0.0.1:60390",
  );
  const POLL_MS = 250,
    CASE_TIMEOUT_MS = 10 * 60000;
  const recording = await loadRecording();
  for (const source of recording.sources) {
    const text = await readFile(resolve(source.path), "utf8");
    if (createHash("sha256").update(text).digest("hex") !== source.sha256)
      throw new Error("原始真实数据哈希发生变化");
  }
  await mkdir(resolve(reportRoot, "screenshots"), { recursive: true });
  await writeFile(
    resolve(reportRoot, "recording.json"),
    JSON.stringify(recording, null, 2) + "\n",
  );
  const bootstrap = await fetch(base + "/api/bootstrap");
  const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0] ?? "";
  const boot = bootstrapSchema.parse(await bootstrap.json());
  const tasks = z
    .array(detailSchema.shape.task)
    .parse(
      await fetch(base + "/api/tasks", { headers: { cookie } }).then((r) =>
        r.json(),
      ),
    );
  if (
    tasks.some((t) =>
      ["queued", "running", "awaiting_approval"].includes(t.status),
    )
  )
    throw new Error("平台存在活动任务，请在空闲时运行回放");
  const client = new Client({
    name: "Codex",
    version: "recorded-approval-e2e-1",
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + "/mcp")),
  );
  const state = replayReportSchema.parse({
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    platform: base,
    kind: "审批回放 · 平台与网页端到端",
    sources: recording.sources,
    stopped: false,
    error: "",
    commandId: "",
    currentCaseId: "",
    cases: scenarios.map((scenario) => ({
      ...scenario,
      title: `【审批回放 ${scenario.id}】${scenario.title}`,
      taskId: "",
      phase: "未执行",
      detail: null as TaskDetail | null,
      steps: [],
      checks: [],
      passed: false,
    })),
  });
  let connector: TaskConnector | undefined,
    subscription: ApprovalSubscription | undefined;
  let active: (typeof state.cases)[number] | undefined,
    fingerprint = "",
    lastCommand = await readFile(commandPath, "utf8")
      .then((text) => commandSchema.parse(JSON.parse(text)).id)
      .catch(() => ""),
    started = 0;
  let stopping = false;
  const note = (label: string, image?: string, snapshot?: unknown) =>
    active?.steps.push({
      at: new Date().toISOString(),
      label,
      ...(image ? { image: "screenshots/" + image } : {}),
      ...(snapshot ? { state: snapshot } : {}),
    });
  const save = async () => {
    const text =
      JSON.stringify(replayReportSchema.parse(state), null, 2) + "\n";
    await writeFile(resolve(reportRoot, "run.json.tmp"), text);
    await rename(
      resolve(reportRoot, "run.json.tmp"),
      resolve(reportRoot, "run.json"),
    );
  };
  const detail = async () => {
    if (!active?.taskId) throw new Error("当前用例尚未发布");
    const response = await fetch(base + "/api/tasks/" + active.taskId, {
      headers: { cookie },
    });
    if (!response.ok) throw new Error("读取任务失败");
    return detailSchema.parse(await response.json());
  };
  const vote = async (rejectLate = false) => {
    if (!active || !subscription) throw new Error("审批订阅缺失");
    const current = await detail(),
      approval = current.approvals[0];
    if (!approval) throw new Error("审批尚未创建");
    const response = await client.callTool({
      name: "submit_approval_decision",
      arguments: {
        ...subscription,
        approvalId: approval.id,
        runId: approval.runId,
        sessionId: approval.sessionId,
        optionId: optionFor(active.subscriber ?? "deny"),
      },
    });
    if (rejectLate) {
      active.checks.push({
        label: "用户先决定后，迟到订阅者意见被拒绝",
        passed: response.isError === true,
      });
      note("用户已决定；订阅者迟到提交被平台拒绝");
    } else {
      if (response.isError)
        throw new Error("订阅者提交失败：" + JSON.stringify(response.content));
      note(
        "Codex 订阅者提交" + (active.subscriber === "allow" ? "同意" : "拒绝"),
      );
    }
  };
  const handle = async (command: z.infer<typeof commandSchema>) => {
    if (command.action === "stop") {
      stopping = true;
      return;
    }
    const target = state.cases.find((c) => c.id === command.caseId);
    if (!target) throw new Error("未知测试用例");
    if (command.action === "start") {
      if (active && !["通过", "失败"].includes(active.phase))
        throw new Error("先结束当前用例");
      await connector?.close();
      if (target.taskId) throw new Error("本轮用例已经发布");
      active = target;
      state.currentCaseId = target.id;
      started = Date.now();
      fingerprint = "";
      const result = await client.callTool({
        name: "publish_task",
        arguments: {
          title: target.title,
          description: `审批回放测试：${target.title}。本轮文件操作及模型响应使用回放输入。`,
          publisherName: "Codex",
          targetHarness: "ZCode-Replay",
          approvalTargets: ["subscriber"],
        },
      });
      if (result.isError) throw new Error("发布测试失败");
      const published = publishResultSchema.parse(result.structuredContent);
      subscription = published.approvalSubscription;
      if (!subscription) throw new Error("发布缺少订阅凭据");
      target.taskId = published.taskId;
      target.phase = "等待审批";
      await writeFile(
        resolve(privateRoot, target.id + ".json"),
        JSON.stringify({ taskId: target.taskId, subscription }),
        { mode: 0o600 },
      );
      note("Codex 通过 MCP 发布测试任务，目标 ZCode-Replay");
      const adapter = new CodexAdapter({
        command: process.execPath,
        args: [
          "--import",
          import.meta.resolve("tsx"),
          resolve("scripts/approval-replay-acp.ts"),
        ],
        workspace: boot.workspace,
        mode: boot.mode,
        env: { PATH: process.env.PATH },
        sessionMode: null,
        harnessName: "ZCode-Replay",
      });
      connector = new TaskConnector(
        base,
        adapter,
        () => note("执行连接器收到任务通知"),
        "ZCode-Replay",
        (id) => id === target.taskId,
      );
      connector.start();
    } else {
      if (active !== target) throw new Error("命令与活动用例不一致");
      if (command.action === "vote") {
        if (!subscription) throw new Error("缺少订阅");
        const received = await client.callTool({
          name: "wait_for_approval",
          arguments: { ...subscription, waitMs: 0 },
        });
        if (received.isError) throw new Error("订阅审批失败");
        const snapshot = approvalSnapshotSchema.parse(
          received.structuredContent,
        );
        if (!snapshot.approvals.some((a) => a.status === "pending"))
          throw new Error("订阅者尚未收到审批");
        note("Codex 通过 MCP 订阅收到原始 Read 审批");
        await vote();
        if (target.refresh) {
          target.originalDeadline =
            (await detail()).approvals[0]?.fallbackAt ?? "";
          await vote();
          target.checks.push({
            label: "订阅者重复同意保持首次截止时间",
            passed:
              (await detail()).approvals[0]?.fallbackAt ===
              target.originalDeadline,
          });
        }
      } else if (command.action === "note") {
        if (command.image)
          await access(resolve(reportRoot, "screenshots", command.image));
        note(command.label, command.image);
        if (command.image) {
          const step = target.steps.at(-1);
          if (step)
            step.at = (
              await stat(resolve(reportRoot, "screenshots", command.image))
            ).mtime.toISOString();
        }
      } else if (command.action === "finish") {
        const current = await detail(),
          approval = current.approvals[0],
          run = current.runs[0];
        if (
          !approval ||
          !run ||
          ["queued", "running", "awaiting_approval"].includes(
            current.task.status,
          )
        )
          throw new Error("等待任务进入终态后再核对");
        target.detail = current;
        const chosen = target.user ?? target.subscriber;
        const expectedOption = chosen ? optionFor(chosen) : null;
        target.checks.push(
          {
            label: "任务正常完成或按用例取消",
            passed:
              current.task.status ===
              (target.cancel ? "cancelled" : "succeeded"),
          },
          {
            label: "用户意见准确保存",
            passed:
              (approval.userDecision?.optionId ?? null) ===
              (target.user ? optionFor(target.user) : null),
          },
          {
            label: "订阅者意见准确保存",
            passed:
              (approval.reviewerDecisions[0]?.optionId ?? null) ===
              (target.subscriber ? optionFor(target.subscriber) : null),
          },
          {
            label: "最终采用方符合用户优先规则",
            passed:
              approval.resolvedBy ===
              (target.cancel ? null : target.user ? "user" : "subscriber"),
          },
          {
            label: "最终选项符合预期",
            passed:
              approval.optionId === (target.cancel ? null : expectedOption),
          },
          {
            label: "审批终态准确",
            passed: approval.status === (target.cancel ? "expired" : "decided"),
          },
        );
        if (!target.cancel)
          target.checks.push(
            {
              label: "工具状态匹配同意或拒绝",
              passed:
                run.tools[0]?.status ===
                (chosen === "allow" ? "completed" : "failed"),
            },
            {
              label: "实际返回对应录制结果",
              passed:
                run.output ===
                (chosen === "allow"
                  ? recording.allowedOutput
                  : recording.deniedOutput),
            },
          );
        else
          target.checks.push({
            label: "取消后工具保持阻断",
            passed: run.tools.every((t) => t.status !== "completed"),
          });
        if (target.subscriber)
          target.checks.push({
            label: "用户窗口恰好10秒",
            passed:
              Date.parse(approval.fallbackAt ?? "") -
                Date.parse(approval.reviewerDecisions[0]?.decidedAt ?? "") ===
              LIMITS.approvalGraceMs,
          });
        if (!target.subscriber) await vote(true);
        if (target.refresh) {
          target.checks.push({
            label: "刷新后截止时间保持原值",
            passed:
              approval.fallbackAt === target.originalDeadline &&
              target.steps.some((step) => step.label.includes("刷新后")),
          });
        }
        target.passed = target.checks.every((c) => c.passed);
        target.phase = target.passed ? "通过" : "失败";
        note("核对平台持久化审批、工具状态与返回结果：" + target.phase);
        await connector?.close();
        connector = undefined;
      }
    }
  };
  process.once("SIGINT", () => {
    stopping = true;
  });
  process.once("SIGTERM", () => {
    stopping = true;
  });
  try {
    await save();
    console.log(
      JSON.stringify({
        ready: true,
        platform: base,
        cases: state.cases.length,
      }),
    );
    while (!stopping) {
      const command = await readFile(commandPath, "utf8")
        .then((text) => commandSchema.parse(JSON.parse(text)))
        .catch(() => undefined);
      if (command && command.id !== lastCommand) {
        lastCommand = command.id;
        try {
          await handle(command);
          state.error = "";
        } catch (error) {
          state.error = error instanceof Error ? error.message : "测试命令失败";
        }
        state.commandId = command.id;
      }
      if (active?.taskId && !["通过", "失败"].includes(active.phase)) {
        const current = await detail();
        active.detail = current;
        const approval = current.approvals[0];
        const snapshot = {
          taskStatus: current.task.status,
          approvalStatus: approval?.status,
          subscriber: approval?.reviewerDecisions,
          user: approval?.userDecision,
          fallbackAt: approval?.fallbackAt,
          resolvedBy: approval?.resolvedBy,
          tools: current.runs[0]?.tools.map((t) => ({
            title: t.title,
            status: t.status,
          })),
          output: current.runs[0]?.output,
        };
        const next = JSON.stringify(snapshot);
        if (next !== fingerprint) {
          fingerprint = next;
          note(
            approval?.status === "decided"
              ? "平台已裁决，执行器收到最终选项"
              : approval?.fallbackAt
                ? "订阅者已决定，等待用户十秒窗口"
                : approval
                  ? "真实 ACP 权限请求进入明庭，网页等待审批"
                  : "平台已领取任务，等待 ACP 请求",
            undefined,
            snapshot,
          );
        }
        if (Date.now() - started > CASE_TIMEOUT_MS)
          throw new Error("当前回放用例等待超时");
      }
      await save();
      await delay(POLL_MS);
    }
  } catch (error) {
    state.error = String(error);
    process.exitCode = 1;
  } finally {
    await connector?.close();
    await client.close();
    state.stopped = true;
    await save();
    await mkdir(resolve(reportRoot, "runs"), { recursive: true });
    await writeFile(
      resolve(reportRoot, "runs", state.runId + ".json"),
      JSON.stringify(state, null, 2) + "\n",
    );
  }
}
