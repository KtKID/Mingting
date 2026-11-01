import { test, expect, type Page } from "@playwright/test";
import {
  bootstrapSchema,
  publishResultSchema,
  detailSchema,
} from "../src/shared/protocol.js";
test.afterEach(async ({ page }) => {
  const response = await page.request.get("/api/bootstrap");
  const boot = bootstrapSchema.parse(await response.json());
  const tasks = (await (
    await page.request.get("/api/tasks")
  ).json()) as unknown;
  const { z } = await import("zod");
  const { taskSchema } = await import("../src/shared/protocol.js");
  for (const task of z.array(taskSchema).parse(tasks)) {
    if (["queued", "running", "awaiting_approval"].includes(task.status))
      await page.request.post(`/api/tasks/${task.id}/cancel`, {
        headers: {
          origin: new URL(page.url()).origin,
          "x-csrf-token": boot.csrf,
        },
        data: {},
      });
  }
});
test("A4 answer, reasoning and tools arrive before completion; reconnect and refresh preserve one tool", async ({
  page,
  context,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const title = "实时问候 · " + info.project.name;
  await page.goto("/");
  await page
    .getByRole("button", { name: "发布任务", exact: true })
    .first()
    .click();
  await page.getByLabel("任务标题").fill(title);
  await page.getByLabel("任务描述").fill("[stream] 简单问候");
  await page.getByLabel("发布人名字").fill("ACP 验证");
  await page
    .getByRole("dialog", { name: "发布任务" })
    .getByRole("button", { name: "发布任务", exact: true })
    .click();
  const d = page.getByRole("dialog", { name: "任务详情" });
  await expect(d.locator(".status")).toHaveText("待审批");
  await expect(d.locator(".answer-output")).toContainText("问候正在生成");
  await expect(d.locator(".reasoning")).toContainText("先读取问候文本");
  await expect(d.locator(".tool-card")).toHaveCount(1);
  await expect(d.locator(".tool-status")).toHaveText("等待执行");
  await context.setOffline(true);
  await context.setOffline(false);
  await expect(page.locator(".connection")).toContainText("本机已连接");
  await page
    .getByRole("dialog", { name: "操作审批" })
    .getByRole("button", { name: "同意", exact: true })
    .click();
  await expect(d.locator(".status")).toHaveText("已完成");
  await expect(d.locator(".tool-status")).toHaveText("已完成");
  await expect(d.locator(".answer-output")).toContainText(
    "selected:allow-once",
  );
  await page.reload();
  await page.getByRole("button", { name: "查看任务：" + title }).click();
  await expect(d.locator(".reasoning")).toContainText("先读取问候文本");
  await expect(d.locator(".tool-card")).toHaveCount(1);
  await expect(d.locator(".tool-status")).toHaveText("已完成");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `reports/approvals/stream-ui-${info.project.name}.png`,
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
test("publish, list three required fields, inspect permission and approve in browser", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const title = "完善项目安装说明 · " + info.project.name;
  await page.goto("/");
  await expect(
    page.getByText("当前使用 ACP 测试子进程", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "发布任务", exact: true })
    .first()
    .click();
  await page.getByLabel("任务标题").fill(title);
  await page
    .getByLabel("任务描述")
    .fill("检查安装步骤，补充启动命令与环境配置说明。");
  await page.getByLabel("发布人名字").fill("林小舟");
  await expect(
    page.getByRole("checkbox", { name: "订阅者 任务发起方" }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "第三方 开发中" }),
  ).toBeDisabled();
  await page
    .getByRole("dialog", { name: "发布任务" })
    .getByRole("button", { name: "发布任务", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "任务详情" });
  await expect(
    dialog.getByRole("heading", { name: "需要你的审批" }),
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: "操作审批" })
    .getByText("查看操作上下文与原始选项")
    .click();
  await expect(
    page.getByRole("dialog", { name: "操作审批" }).locator("details pre"),
  ).toContainText("echo demo — simulated only");
  await expect(
    dialog.locator(".metadata").getByText("林小舟", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `/tmp/task-mvp-${info.project.name}-approval.png`,
    fullPage: true,
  });
  await page
    .getByRole("dialog", { name: "操作审批" })
    .getByRole("button", { name: "同意", exact: true })
    .click();
  await expect(dialog.locator(".status")).toHaveText("已完成");
  await expect(
    dialog
      .locator(".result")
      .getByText("selected:allow-once", { exact: false }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "关闭任务详情" }).click();
  const row = page.getByRole("button", { name: "查看任务：" + title });
  await expect(row).toBeVisible();
  await expect(row.getByText("林小舟", { exact: true })).toBeVisible();
  await expect(
    row.getByText("检查安装步骤，补充启动命令与环境配置说明。"),
  ).toBeVisible();
  await page.screenshot({
    path: `/tmp/task-mvp-${info.project.name}-list.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  if (info.project.use.colorScheme === "dark") {
    const colors = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      return { bg: root.backgroundColor, fg: root.color };
    });
    expect(Number(colors.bg.match(/\d+/)![0])).toBeLessThan(80);
    expect(Number(colors.fg.match(/\d+/)![0])).toBeGreaterThan(150);
  }
  expect(errors).toEqual([]);
});

async function publishApprovalTask(page: Page, title: string) {
  const bootstrap = bootstrapSchema.parse(
    await (await page.request.get("/api/bootstrap")).json(),
  );
  const response = await page.request.post("/api/tasks", {
    headers: {
      origin: new URL(page.url()).origin,
      "x-csrf-token": bootstrap.csrf,
    },
    data: {
      title,
      description: "检查审批等待与用户优先规则",
      publisherName: "Codex",
      approvalTargets: ["subscriber"],
    },
  });
  expect(response.status()).toBe(201);
  const result = publishResultSchema.parse(await response.json());
  const subscription = result.approvalSubscription;
  if (!subscription) throw new Error("missing subscription");
  await expect
    .poll(async () => {
      const detail = detailSchema.parse(
        await (await page.request.get("/api/tasks/" + result.taskId)).json(),
      );
      return detail.approvals.length;
    })
    .toBeGreaterThan(0);
  await expect(page.getByRole("dialog", { name: "操作审批" })).toBeVisible();
  const detail = detailSchema.parse(
    await (await page.request.get("/api/tasks/" + result.taskId)).json(),
  );
  const approval = detail.approvals[0];
  if (!approval) throw new Error("missing approval");
  return { subscription, approval, taskId: result.taskId };
}

test("AR4 light viewing parameter and direct task link retain real approval history", async ({
  page,
}, info) => {
  await page.goto("/?theme=light");
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).colorScheme,
    ),
  ).toBe("light");
  const title = "任务链接回归 · " + info.project.name;
  const task = await publishApprovalTask(page, title);
  await page
    .getByRole("dialog", { name: "操作审批" })
    .getByRole("button", { name: "拒绝", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        detailSchema.parse(
          await (await page.request.get("/api/tasks/" + task.taskId)).json(),
        ).task.status,
    )
    .toBe("succeeded");
  await page.goto("/?theme=light&task=" + task.taskId);
  const drawer = page.getByRole("dialog", { name: "任务详情" });
  await expect(drawer.getByRole("heading", { name: title })).toBeVisible();
  await expect(drawer.locator(".answer-output")).toContainText(
    "selected:reject-once",
  );
  await expect(
    page.getByRole("link", { name: "审批测试记录" }),
  ).toHaveAttribute("href", "/approval-tests/");
  await drawer
    .getByRole("button", { name: "关闭任务详情", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "审批回放与测试记录", exact: true }),
  ).toBeVisible();
});

test("PUI1 automatic popup from list, subscriber clock survives refresh, user reject overrides allow", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const title = "用户优先 · " + info.project.name;
  const task = await publishApprovalTask(page, title);
  const popup = page.getByRole("dialog", { name: "操作审批" });
  await expect(
    popup.getByRole("heading", { name: "演示：执行测试操作（不会实际执行）" }),
  ).toBeVisible();
  await expect(popup.locator(".approval-description")).toContainText(
    "echo demo",
  );
  await expect(popup.locator(".approval-decisions")).toContainText("待决定");
  const review = await page.request.post("/subscriber/decision", {
    data: {
      ...task.subscription,
      approvalId: task.approval.id,
      runId: task.approval.runId,
      sessionId: task.approval.sessionId,
      optionId: "allow-once",
    },
  });
  expect(review.status()).toBe(200);
  await expect(popup.getByRole("timer")).toContainText(/10s|9s/);
  await expect(popup.locator(".decision-allow")).toContainText("订阅者");
  await expect(popup.locator(".decision-allow")).toContainText("同意");
  const before = detailSchema.parse(
    await (await page.request.get("/api/tasks/" + task.taskId)).json(),
  );
  await page.reload();
  await expect(popup).toBeVisible();
  await expect(popup.getByRole("timer")).toBeVisible();
  const after = detailSchema.parse(
    await (await page.request.get("/api/tasks/" + task.taskId)).json(),
  );
  expect(after.approvals[0]?.fallbackAt).toBe(before.approvals[0]?.fallbackAt);
  const timerBox = await popup.getByRole("timer").boundingBox();
  const headingBox = await popup.locator(".approval-heading").boundingBox();
  expect(
    timerBox && headingBox && timerBox.x > headingBox.x + headingBox.width / 2,
  ).toBeTruthy();
  await page.screenshot({
    path: `reports/approvals/popup-${info.project.name}.png`,
    fullPage: true,
    animations: "disabled",
  });
  await popup.getByRole("button", { name: "拒绝", exact: true }).click();
  await expect(popup).toBeHidden();
  await page.getByRole("button", { name: "查看任务：" + title }).click();
  const detail = page.getByRole("dialog", { name: "任务详情" });
  await expect(detail.locator(".status")).toHaveText("已完成");
  await expect(
    detail.locator(".approval-decisions .decision-allow"),
  ).toContainText("订阅者");
  await expect(
    detail.locator(".approval-decisions .decision-reject"),
  ).toContainText("用户");
  await expect(detail.locator(".answer-output")).toContainText(
    "selected:reject-once",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("PUI2 server applies subscriber reject after a real 10 seconds while user remains undecided", async ({
  page,
}, info) => {
  await page.goto("/");
  const task = await publishApprovalTask(
    page,
    "十秒自动裁决 · " + info.project.name,
  );
  const start = Date.now();
  const review = await page.request.post("/subscriber/decision", {
    data: {
      ...task.subscription,
      approvalId: task.approval.id,
      runId: task.approval.runId,
      sessionId: task.approval.sessionId,
      optionId: "reject-once",
    },
  });
  expect(review.status()).toBe(200);
  const popup = page.getByRole("dialog", { name: "操作审批" });
  await expect(popup.getByRole("timer")).toContainText(/10s|9s/);
  await expect(popup.locator(".decision-reject")).toContainText("订阅者");
  await expect(popup).toBeHidden({ timeout: 15000 });
  expect(Date.now() - start).toBeGreaterThanOrEqual(10000);
  await expect
    .poll(async () => {
      const detail = detailSchema.parse(
        await (await page.request.get("/api/tasks/" + task.taskId)).json(),
      );
      return detail.runs[0]?.output;
    })
    .toContain("selected:reject-once");
  const actual = detailSchema.parse(
    await (await page.request.get("/api/tasks/" + task.taskId)).json(),
  );
  expect(actual.approvals[0]?.resolvedBy).toBe("subscriber");
  expect(actual.approvals[0]?.userDecision).toBeNull();
});

test("browser reject decision and cancellation with explicit retry", async ({
  page,
}, info) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "发布任务", exact: true })
    .first()
    .click();
  await page
    .getByLabel("任务标题")
    .fill("审批拒绝与重试 · " + info.project.name);
  await page.getByLabel("任务描述").fill("演示拒绝不会自动变成允许。");
  await page.getByLabel("发布人名字").fill("测试者");
  await page
    .getByRole("dialog", { name: "发布任务" })
    .getByRole("button", { name: "发布任务", exact: true })
    .click();
  const d = page.getByRole("dialog", { name: "任务详情" });
  await page
    .getByRole("dialog", { name: "操作审批" })
    .getByRole("button", { name: "拒绝", exact: true })
    .click();
  await expect(
    d.locator(".result").getByText("selected:reject-once", { exact: false }),
  ).toBeVisible();
  await expect(d.locator(".status")).toHaveText("已完成");
  await d.getByRole("button", { name: "关闭任务详情" }).click();
  await page
    .getByRole("button", { name: "发布任务", exact: true })
    .first()
    .click();
  await page.getByLabel("任务标题").fill("取消执行 · " + info.project.name);
  await page.getByLabel("任务描述").fill("演示取消后旧审批失效。");
  await page.getByLabel("发布人名字").fill("测试者");
  await page
    .getByRole("dialog", { name: "发布任务" })
    .getByRole("button", { name: "发布任务", exact: true })
    .click();
  await expect(d.getByRole("heading", { name: "需要你的审批" })).toBeVisible();
  await page
    .getByRole("dialog", { name: "操作审批" })
    .getByRole("button", { name: "稍后审批" })
    .click();
  await d.getByRole("button", { name: "取消任务", exact: true }).click();
  await expect(d.getByRole("heading", { name: "审批已失效" })).toBeVisible();
  await d.getByRole("button", { name: "创建新执行并重试" }).click();
  await expect(d.getByRole("heading", { name: "需要你的审批" })).toBeVisible();
  await page
    .getByRole("dialog", { name: "操作审批" })
    .getByRole("button", { name: "拒绝", exact: true })
    .click();
  await expect(d.locator(".status")).toHaveText("已完成");
});

for (const bootstrapFails of [false, true]) {
  test(`reconnect terminal SSE with unchanged session; bootstrap failure=${bootstrapFails}`, async ({
    page,
  }) => {
    let eventRequests = 0,
      bootstrapRequests = 0;
    await page.route("**/api/events**", async (route) => {
      eventRequests++;
      if (eventRequests === 1) await route.fulfill({ status: 204 });
      else await route.continue();
    });
    await page.route("**/api/bootstrap", async (route) => {
      bootstrapRequests++;
      if (bootstrapFails && bootstrapRequests === 2)
        await route.fulfill({ status: 503, body: "temporary" });
      else await route.continue();
    });
    await page.goto("/");
    await expect
      .poll(() => eventRequests, { timeout: 8000 })
      .toBeGreaterThan(1);
    await expect(page.locator(".connection")).toContainText("本机已连接");
    await expect(page.locator(".connection")).toContainText("Codex");
  });
}
