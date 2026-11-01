import { readFile, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { replayReportSchema } from "../src/shared/approval-replay.js";
import { detailSchema } from "../src/shared/protocol.js";

const root = resolve("reports/approval-e2e");
const report = replayReportSchema.parse(
  JSON.parse(await readFile(resolve(root, "run.json"), "utf8")),
);
if (!report.stopped) throw new Error("先停止回放协调器，再核对最终证据");
for (const source of report.sources) {
  if (
    createHash("sha256")
      .update(await readFile(source.path))
      .digest("hex") !== source.sha256
  )
    throw new Error("原始真实数据发生变化");
}
const boot = await fetch(report.platform + "/api/bootstrap");
const cookie = boot.headers.get("set-cookie")?.split(";")[0] ?? "";
for (const item of report.cases) {
  const response = await fetch(report.platform + "/api/tasks/" + item.taskId, {
    headers: { cookie },
  });
  if (!response.ok) throw new Error("60390缺少已回放任务：" + item.id);
  const live = detailSchema.parse(await response.json());
  if (!item.detail) throw new Error("用例缺少最终快照");
  const stable = (detail: typeof live) =>
    JSON.stringify({
      task: detail.task,
      approvals: detail.approvals,
      runs: detail.runs,
    });
  item.checks = item.checks.filter(
    (check) =>
      ![
        "平台任务与最终记录一致",
        "所有操作截图存在",
        "工具在完整十秒后才收到结果",
      ].includes(check.label),
  );
  item.checks.push({
    label: "平台任务与最终记录一致",
    passed: stable(live) === stable(item.detail),
  });
  for (const step of item.steps)
    if (step.image) {
      const image = await stat(resolve(root, step.image));
      step.at = image.mtime.toISOString();
      if (step.image.endsWith("-pending.png"))
        step.label = "截图：原始 Read 请求进入网页，双方待决定";
      else if (step.image.endsWith("-subscriber.png"))
        step.label =
          item.id === "R6"
            ? "截图：十秒结束后弹窗收起，任务列表显示完成"
            : "截图：订阅者" +
              (item.subscriber === "allow" ? "同意" : "拒绝") +
              "，用户仍可决定";
      else if (step.image.endsWith("-refreshed.png"))
        step.label = "截图：刷新后继续原有倒计时";
      else if (step.image.endsWith("-result.png"))
        step.label = item.cancel
          ? "截图：任务已取消，审批失效，工具保持阻断"
          : "截图：最终采用" +
            (item.user ? "用户" : "订阅者") +
            (item.user === "allow" ||
            (!item.user && item.subscriber === "allow")
              ? "同意"
              : "拒绝") +
            "，展示执行结果";
    }
  const approval = item.detail.approvals[0];
  if (!approval) throw new Error("缺少审批");
  if (!item.steps.some((step) => step.label.startsWith("平台原始时间"))) {
    const review = approval.reviewerDecisions[0];
    if (review)
      item.steps.push({
        at: review.decidedAt,
        label:
          "平台原始时间：订阅者提交" +
          (review.optionId === "allow_once" ? "同意" : "拒绝"),
      });
    if (approval.userDecision)
      item.steps.push({
        at: approval.userDecision.decidedAt,
        label:
          "平台原始时间：用户点击" +
          (approval.userDecision.optionId === "allow_once" ? "同意" : "拒绝"),
      });
  }
  item.steps.sort((a, b) => a.at.localeCompare(b.at));
  item.checks.push({
    label: "所有操作截图存在",
    passed: item.steps.filter((step) => step.image).length >= 2,
  });
  if (!item.user && !item.cancel) {
    const endedTool = item.detail.events.find(
      (event) =>
        event.notification.update.sessionUpdate === "tool_call_update" &&
        ["completed", "failed"].includes(
          event.notification.update.status ?? "",
        ),
    );
    item.checks.push({
      label: "工具在完整十秒后才收到结果",
      passed:
        !!endedTool &&
        Date.parse(endedTool.createdAt) >=
          Date.parse(approval.fallbackAt ?? ""),
    });
  }
  item.passed = item.checks.every((check) => check.passed);
  item.phase = item.passed ? "通过" : "失败";
}
const text = JSON.stringify(report, null, 2) + "\n";
await writeFile(resolve(root, "run.json"), text);
await writeFile(resolve(root, "runs", report.runId + ".json"), text);
console.log(
  JSON.stringify({
    cases: report.cases.length,
    passed: report.cases.filter((c) => c.passed).length,
    screenshots: report.cases.reduce(
      (n, c) => n + c.steps.filter((s) => s.image).length,
      0,
    ),
    checks: report.cases.reduce((n, c) => n + c.checks.length, 0),
  }),
);
if (report.cases.some((c) => !c.passed)) process.exitCode = 1;
