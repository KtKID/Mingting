import { test, expect } from "@playwright/test";
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
