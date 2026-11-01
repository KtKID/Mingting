import { test, expect } from "@playwright/test";
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
  await d.getByRole("button", { name: "允许一次 allow_once" }).click();
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
    path: `reports/acp-streaming/ui-${info.project.name}.png`,
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
  await page
    .getByRole("dialog", { name: "发布任务" })
    .getByRole("button", { name: "发布任务", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "任务详情" });
  await expect(
    dialog.getByRole("heading", { name: "需要你的审批" }),
  ).toBeVisible();
  await dialog.getByText("查看操作上下文与原始选项").click();
  await expect(
    dialog.getByText("echo demo — simulated only", { exact: false }),
  ).toBeVisible();
  await expect(dialog.getByText("林小舟", { exact: true })).toBeVisible();
  await page.screenshot({
    path: `/tmp/task-mvp-${info.project.name}-approval.png`,
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "允许一次 allow_once" }).click();
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
  await d.getByRole("button", { name: "拒绝一次 reject_once" }).click();
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
  await d.getByRole("button", { name: "取消任务", exact: true }).click();
  await expect(d.getByRole("heading", { name: "审批已失效" })).toBeVisible();
  await d.getByRole("button", { name: "创建新执行并重试" }).click();
  await expect(d.getByRole("heading", { name: "需要你的审批" })).toBeVisible();
  await d.getByRole("button", { name: "拒绝一次 reject_once" }).click();
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
