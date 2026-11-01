import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  scenarios,
  optionFor,
  replayCaseSchema,
} from "../src/shared/approval-replay.js";
import {
  bootstrapSchema,
  publishResultSchema,
  detailSchema,
  approvalSnapshotSchema,
  LIMITS,
  type TaskDetail,
} from "../src/shared/protocol.js";
import { loadRecording } from "../scripts/approval-replay-data.js";
import { CodexAdapter } from "../src/server/codex-adapter.js";
import { TaskConnector } from "../src/connector/connector.js";
import { atomicJson } from "../scripts/approval-archive.js";

for (const scenario of scenarios)
  test(scenario.id + " " + scenario.title, async ({ page }) => {
    const batch = z
      .object({
        APPROVAL_REGRESSION_DIR: z.string().min(1),
        APPROVAL_REGRESSION_ID: z.string().uuid(),
        APPROVAL_RECORDING_PATH: z.string().min(1),
      })
      .parse(process.env);
    const result = replayCaseSchema.parse({
      ...scenario,
      taskId: "",
      phase: "执行中",
      detail: null,
      passed: false,
      steps: [],
      checks: [],
      snapshotPath: `runs/${batch.APPROVAL_REGRESSION_ID}/cases/${scenario.id}.json`,
    });
    const save = () =>
      atomicJson(
        resolve(batch.APPROVAL_REGRESSION_DIR, "cases", scenario.id + ".json"),
        replayCaseSchema.parse(result),
      );
    const note = (label: string) =>
      result.steps.push({ at: new Date().toISOString(), label });
    const check = (label: string, actual: unknown, expected: unknown) => {
      try {
        expect(actual, label).toEqual(expected);
        result.checks.push({ label, passed: true });
      } catch (error) {
        result.checks.push({ label, passed: false });
        throw error;
      }
    };
    let current: (() => Promise<TaskDetail>) | undefined;
    const capture = async (label: string, stage: string) => {
      const filename = scenario.id + "-" + stage + ".png";
      await mkdir(resolve(batch.APPROVAL_REGRESSION_DIR, "cases"), {
        recursive: true,
      });
      await page.screenshot({
        path: resolve(batch.APPROVAL_REGRESSION_DIR, "cases", filename),
      });
      result.steps.push({
        at: new Date().toISOString(),
        label,
        image: `runs/${batch.APPROVAL_REGRESSION_ID}/cases/${filename}`,
      });
      if (current) result.detail = await current();
      await save();
    };
    await save();
    const base = "http://127.0.0.1:60391";
    const recording = await loadRecording();
    const client = new Client({
      name: "Codex",
      version: "recorded-e2e-regression",
    });
    let connector: TaskConnector | undefined;
    try {
      await page.goto("/?theme=light");
      // Wait for the page's first session cookie before sharing its request context.
      await expect(
        page
          .locator(".page-heading")
          .getByRole("button", { name: "发布任务", exact: true }),
      ).toBeEnabled();
      const boot = bootstrapSchema.parse(
        await (await page.request.get("/api/bootstrap")).json(),
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL(base + "/mcp")),
      );
      const title = "【录制回归 " + scenario.id + "】" + scenario.title;
      const published = await client.callTool({
        name: "publish_task",
        arguments: {
          title,
          description: "复用真实 ZCode 审批数据，模型与工具使用录制响应。",
          publisherName: "Codex",
          targetHarness: "ZCode-Replay",
          approvalTargets: ["subscriber"],
        },
      });
      expect(published.isError).not.toBe(true);
      const task = publishResultSchema.parse(published.structuredContent);
      result.taskId = task.taskId;
      note("Codex 通过 MCP 发布审批回归任务");
      await save();
      const subscription = task.approvalSubscription;
      if (!subscription) throw new Error("缺少审批订阅");
      const adapter = new CodexAdapter({
        command: process.execPath,
        args: [
          "--import",
          import.meta.resolve("tsx"),
          resolve("scripts/approval-replay-acp.ts"),
        ],
        workspace: boot.workspace,
        mode: boot.mode,
        env: {
          PATH: process.env.PATH,
          APPROVAL_RECORDING_PATH: batch.APPROVAL_RECORDING_PATH,
        },
        sessionMode: null,
      });
      connector = new TaskConnector(
        base,
        adapter,
        undefined,
        "ZCode-Replay",
        (id) => id === task.taskId,
      );
      connector.start();
      const readCurrent = async () =>
        detailSchema.parse(
          await (await page.request.get("/api/tasks/" + task.taskId)).json(),
        );
      current = readCurrent;
      const popup = page.getByRole("dialog", { name: "操作审批" });
      await expect(popup).toBeVisible();
      const first = (await readCurrent()).approvals[0];
      if (!first) throw new Error("缺少实际审批");
      check(
        "原始操作输入与真实录制一致",
        first.request.toolCall.rawInput,
        recording.request.toolCall.rawInput,
      );
      check(
        "原始审批选项与真实录制一致",
        first.request.options,
        recording.request.options,
      );
      await capture("Read 请求进入审批弹窗，双方待决定", "pending");
      if (scenario.cancel) {
        await popup.getByRole("button", { name: "稍后审批" }).click();
        await page
          .getByRole("button", { name: "查看任务：" + title, exact: true })
          .click();
      }
      let deadline: string | null = null;
      const vote = async (optionId: string) =>
        client.callTool({
          name: "submit_approval_decision",
          arguments: {
            ...subscription,
            approvalId: first.id,
            runId: first.runId,
            sessionId: first.sessionId,
            optionId,
          },
        });
      if (scenario.subscriber) {
        const received = await client.callTool({
          name: "wait_for_approval",
          arguments: { ...subscription, waitMs: 0 },
        });
        check(
          "订阅者通过MCP收到当前审批",
          approvalSnapshotSchema.parse(received.structuredContent).approvals[0]
            ?.id,
          first.id,
        );
        check(
          "订阅者自动提交成功",
          (await vote(optionFor(scenario.subscriber))).isError === true,
          false,
        );
        note(
          "订阅者自动提交" +
            (scenario.subscriber === "allow" ? "同意" : "拒绝"),
        );
        deadline = (await readCurrent()).approvals[0]?.fallbackAt ?? null;
        check(
          "用户窗口为完整十秒",
          Date.parse(deadline ?? "") -
            Date.parse(
              (await readCurrent()).approvals[0]?.reviewerDecisions[0]
                ?.decidedAt ?? "",
            ),
          LIMITS.approvalGraceMs,
        );
        await capture("订阅者已决定，保留完整十秒用户窗口", "subscriber");
      }
      if (scenario.refresh) {
        check(
          "重复订阅者意见被幂等接受",
          (await vote(optionFor("allow"))).isError === true,
          false,
        );
        await page.reload();
        await expect(popup.getByRole("timer")).toBeVisible();
        check(
          "刷新保持原截止时间",
          (await readCurrent()).approvals[0]?.fallbackAt,
          deadline,
        );
        await capture("刷新后仍沿用原截止时间", "refreshed");
      }
      if (scenario.user)
        await popup
          .getByRole("button", {
            name: scenario.user === "allow" ? "同意" : "拒绝",
            exact: true,
          })
          .click();
      if (scenario.cancel)
        await page
          .getByRole("button", { name: "取消任务", exact: true })
          .click();
      note(
        scenario.cancel
          ? "自动点击取消任务"
          : scenario.user
            ? "用户自动点击" + (scenario.user === "allow" ? "同意" : "拒绝")
            : "用户保持待决定，等待真实十秒到期",
      );
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect
        .poll(async () => (await readCurrent()).task.status, { timeout: 20000 })
        .toBe(scenario.cancel ? "cancelled" : "succeeded");
      const final = await readCurrent(),
        approval = final.approvals[0],
        run = final.runs[0];
      if (!approval || !run) throw new Error("缺少终态数据");
      const selected = scenario.user ?? scenario.subscriber;
      check(
        "用户意见准确保存",
        approval.userDecision?.optionId ?? null,
        scenario.user ? optionFor(scenario.user) : null,
      );
      check(
        "订阅者意见准确保存",
        approval.reviewerDecisions[0]?.optionId ?? null,
        scenario.subscriber ? optionFor(scenario.subscriber) : null,
      );
      check(
        "最终采用方遵守用户优先",
        approval.resolvedBy,
        scenario.cancel ? null : scenario.user ? "user" : "subscriber",
      );
      check(
        "任务终态符合用例",
        final.task.status,
        scenario.cancel ? "cancelled" : "succeeded",
      );
      check(
        "审批终态符合用例",
        approval.status,
        scenario.cancel ? "expired" : "decided",
      );
      check(
        "最终选项符合用例",
        approval.optionId,
        scenario.cancel ? null : selected ? optionFor(selected) : null,
      );
      if (!scenario.cancel) {
        check(
          "返回正确的真实录制响应",
          run.output,
          selected === "allow"
            ? recording.allowedOutput
            : recording.deniedOutput,
        );
        check(
          "工具状态匹配同意或拒绝",
          run.tools[0]?.status,
          selected === "allow" ? "completed" : "failed",
        );
      } else
        check(
          "取消后工具保持阻断",
          run.tools.every((tool) => tool.status !== "completed"),
          true,
        );
      if (!scenario.subscriber)
        check("用户先决定后拒绝迟到订阅者", (await vote("deny")).isError, true);
      if (scenario.refresh)
        check("最终结果保留首次截止时间", approval.fallbackAt, deadline);
      await page.goto("/?theme=light&task=" + task.taskId);
      await expect(
        page.getByRole("dialog", { name: "任务详情" }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: title, exact: true }),
      ).toBeVisible();
      const thoughts = page.locator("details.reasoning[open] > summary");
      if (await thoughts.count()) await thoughts.click();
      await capture("审批完成，展示最终决定与执行结果", "result");
      result.passed = true;
      result.phase = "通过";
    } catch (error) {
      result.passed = false;
      result.phase = "失败";
      result.checks.push({
        label:
          error instanceof Error ? error.message.slice(0, 4000) : String(error),
        passed: false,
      });
      await capture("测试失败时的实际页面", "failure").catch(() => {});
      throw error;
    } finally {
      const cleanup = await Promise.allSettled([
        connector?.close(),
        client.close(),
      ]);
      for (const entry of cleanup)
        if (entry.status === "rejected") {
          result.passed = false;
          result.phase = "失败";
          result.checks.push({
            label: "清理失败：" + String(entry.reason),
            passed: false,
          });
        }
      if (current) result.detail = await current().catch(() => result.detail);
      const approval = result.detail?.approvals[0];
      if (approval?.reviewerDecisions[0])
        result.steps.push({
          at: approval.reviewerDecisions[0].decidedAt,
          label: "平台记录：订阅者决定",
        });
      if (approval?.userDecision)
        result.steps.push({
          at: approval.userDecision.decidedAt,
          label: "平台记录：用户决定",
        });
      result.steps.sort((a, b) => a.at.localeCompare(b.at));
      await save();
      if (cleanup.some((entry) => entry.status === "rejected"))
        throw new Error("回归连接器清理失败，见本例归档");
    }
  });
