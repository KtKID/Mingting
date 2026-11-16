import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const evidenceDir =
  process.env.PROJECT_RECORDS_EVIDENCE_DIR ??
  "reports/project-records/20261116-01/evidence";

let first = "",
  second = "";
function fixture(name: string) {
  const root = mkdtempSync(join(tmpdir(), "record-board-"));
  const dir = join(root, "docs/spec/demo/tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "../spec.md"),
    `# ${name}模块\n\n用于状态核对的隔离项目。`,
  );
  for (const [id, title, status] of [
    ["a", "读取来源", "待实现"],
    ["b", "同步进度", "进行中"],
    ["c", "核对交付", "待验证"],
    ["d", "归档记录", "已完成"],
    ["e", "补充决定", "阻塞：等待需求确认"],
  ]) {
    writeFileSync(
      join(dir, `task-${id}.md`),
      `# ${title}\n> 状态：${status}\n\n来自 ${name} 的真实夹具文档。`,
    );
  }
  writeFileSync(join(dir, "task-unknown.md"), "# 尚待确认\n缺少状态声明。\n");
  const sibling = join(root, "docs/spec/sibling/tasks");
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, "../spec.md"), `# ${name}补充模块`);
  writeFileSync(join(sibling, "task-b.md"), "# 同步进度\n> 状态：待验证\n");
  writeFileSync(join(sibling, "task-extra.md"), "# 补充验收\n> 状态：已完成\n");
  return root;
}
test.beforeAll(() => {
  first = fixture("甲");
  second = fixture("乙");
});
test.afterAll(() => {
  rmSync(first, { recursive: true, force: true });
  rmSync(second, { recursive: true, force: true });
});
test.beforeEach(async ({ page }) => {
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
});
test.afterEach(async ({ page }, info) => {
  const entries = await page.coverage.stopJSCoverage();
  const directory = join(evidenceDir, "browser-coverage");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(
      directory,
      `${info.project.name}-${info.title.slice(0, 32).replace(/[^a-zA-Z0-9-]/g, "-")}.json`,
    ),
    JSON.stringify(entries),
  );
});

async function connect(page: Page, path: string, name: string) {
  await page.getByRole("button", { name: "接入项目", exact: true }).click();
  const form = page.getByRole("form", { name: "接入项目" });
  await form.getByLabel("项目目录", { exact: true }).fill(path);
  await form.getByLabel("项目名称（可选）", { exact: true }).fill(name);
  await form.getByRole("button", { name: "读取项目记录" }).click();
  await expect(
    page.getByRole("tab", { name: new RegExp(name) }),
  ).toHaveAttribute("aria-selected", "true");
}

async function expectVisibleColumnCounts(page: Page) {
  const board = page.getByRole("region", { name: "Spec 任务状态看板" });
  for (const phase of ["待开始", "进行中", "待验收", "已完成", "待核对"]) {
    const cards = board
      .locator(`[aria-label="${phase}任务"]`)
      .getByRole("button");
    const count = board.locator(".records-board-header > div").filter({
      hasText: new RegExp(`^${phase}\\d+$`),
    });
    await expect(count).toHaveText(`${phase}${await cards.count()}`);
  }
  await expect(page.locator(".records-summary")).toContainText("8 个 Task");
}

test("T6 record page connects two projects, filters, explains states and reads source", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "工作空间页面" });
  const tasksLink = nav.getByRole("link", { name: "任务台", exact: true });
  const recordsLink = nav.getByRole("link", { name: "项目记录", exact: true });
  await expect(tasksLink).toHaveAttribute("aria-current", "page");
  const tasksPosition = await tasksLink.boundingBox();
  const recordsPosition = await recordsLink.boundingBox();
  expect(tasksPosition?.x).toBe(recordsPosition?.x);
  expect(tasksPosition?.y).toBeLessThan(recordsPosition?.y ?? 0);
  await recordsLink.click();
  await expect(recordsLink).toHaveAttribute("aria-current", "page");
  await expect(page).toHaveURL(/\/records/);
  const firstName = `项目甲 ${info.project.name}`;
  await connect(page, first, firstName);
  const lane = page
    .getByRole("region", { name: "Spec 任务状态看板" })
    .getByRole("region", { name: "甲模块" });
  await expect(
    lane.getByRole("button", { name: "查看开发任务：读取来源" }),
  ).toBeVisible();
  await expect(lane.locator('[aria-label="待验收任务"]')).toContainText(
    "核对交付",
  );
  await expect(lane.locator('[aria-label="待核对任务"]')).toContainText(
    "尚待确认",
  );
  const sibling = page.getByRole("region", { name: "甲补充模块" });
  await expect(sibling.getByRole("button")).toHaveCount(2);
  await expect(lane.getByRole("button")).toHaveCount(6);
  await expect(sibling.locator('[aria-label="待验收任务"]')).toContainText(
    "同步进度",
  );
  await expect(lane.locator('[aria-label="进行中任务"]')).toContainText(
    "同步进度",
  );
  const normalCard = lane.getByRole("button", {
    name: "查看开发任务：同步进度",
  });
  const color = await normalCard.evaluate(
    (card) => getComputedStyle(card).borderInlineStartColor,
  );
  const blockedCard = lane.getByRole("button", {
    name: "查看开发任务：补充决定",
  });
  await expect(blockedCard).toHaveCSS("border-inline-start-color", color);
  await expect(blockedCard).toContainText("阻塞 · 等待需求确认");
  const reviewCard = sibling.getByRole("button", {
    name: "查看开发任务：同步进度",
  });
  await expect(reviewCard).not.toHaveCSS("border-inline-start-color", color);
  await normalCard.click();
  const detail = page.getByRole("dialog", { name: "开发任务详情" });
  await expect(detail).toContainText("进行中");
  await detail
    .getByRole("button", { name: /docs\/spec\/demo\/tasks\/task-b.md:2/ })
    .click();
  await expect(detail.getByRole("region", { name: "来源文档" })).toContainText(
    "来自 甲",
  );
  await detail.getByRole("button", { name: "关闭开发任务详情" }).click();
  await page.getByRole("button", { name: /待关注/ }).click();
  await expect(
    page.getByRole("button", { name: "查看开发任务：读取来源" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "查看开发任务：补充决定" }),
  ).toBeVisible();
  await expectVisibleColumnCounts(page);
  await connect(page, second, `项目乙 ${info.project.name}`);
  await expect(page.getByRole("region", { name: "乙模块" })).toBeVisible();
  await expect(page.getByRole("region", { name: "乙补充模块" })).toBeVisible();
  await expect(lane).toHaveCount(0);
  await page.getByRole("tab", { name: new RegExp(firstName) }).click();
  await page
    .getByRole("searchbox", { name: "搜索 Spec 或 Task" })
    .fill("读取来源");
  await expect(
    page.getByRole("button", { name: /^查看开发任务：/ }),
  ).toHaveCount(1);
  await expectVisibleColumnCounts(page);
  writeFileSync(
    join(first, "docs/spec/demo/tasks/task-a.md"),
    "# 读取来源\n> 状态：已完成\n",
  );
  await page.getByRole("button", { name: "刷新记录", exact: true }).click();
  await expect(lane.locator('[aria-label="已完成任务"]')).toContainText(
    "读取来源",
  );
  await expect(
    lane.getByRole("button", { name: "查看开发任务：读取来源" }),
  ).toHaveCSS("border-inline-start-color", color);
  await page.getByRole("searchbox", { name: "搜索 Spec 或 Task" }).fill("");
  await page.screenshot({
    path: join(evidenceDir, `board-${info.project.name}.png`),
    fullPage: true,
  });
  const width = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  expect(width.doc).toBeLessThanOrEqual(width.viewport);
  const board = await page
    .getByRole("region", { name: "Spec 任务状态看板" })
    .boundingBox();
  const sidebar = await nav.boundingBox();
  expect(board?.x).toBeGreaterThanOrEqual(
    (sidebar?.x ?? 0) + (sidebar?.width ?? 0),
  );
  expect(errors).toEqual([]);
});

test("T6 real project sample shows five tasks and nineteen steps with delivery source", async ({
  page,
}, info) => {
  await page.goto("/records");
  await connect(page, resolve("."), "明庭");
  await page
    .getByRole("searchbox", { name: "搜索 Spec 或 Task" })
    .fill("Codex 任务设置");
  await expect(
    page.getByRole("button", { name: /^查看开发任务：/ }),
  ).toHaveCount(5);
  await page
    .getByRole("button", { name: "查看开发任务：真实任务流式验收与用量对账" })
    .click();
  const detail = page.getByRole("dialog", { name: "开发任务详情" });
  await expect(detail).toContainText("3/3 已验证");
  await expect(detail).toContainText("已完成");
  await expect(
    detail.getByRole("button", { name: /本次统一测试报告/ }),
  ).toBeVisible();
  await page.screenshot({
    path: join(evidenceDir, `real-detail-${info.project.name}.png`),
    fullPage: true,
  });
});

test("T3 system directory result prefills editable fields without registering until submission", async ({
  page,
}, info) => {
  const result = {
    status: "selected",
    projectRoot: first,
    projectName: "仓库根目录",
  };
  const finalName = `手动名称 ${info.project.name}`;
  await page.route("**/api/project-records/choose-directory", (route) =>
    route.fulfill({ json: result }),
  );
  await page.goto("/records");
  await page.getByRole("button", { name: "接入项目", exact: true }).click();
  const form = page.getByRole("form", { name: "接入项目" });
  const directory = form.getByLabel("项目目录", { exact: true });
  const name = form.getByLabel("项目名称（可选）", { exact: true });
  const picker = form.getByRole("button", { name: "选择文件夹" });
  await expect(directory).toHaveValue("");
  await picker.click({ timeout: 3000 });
  await expect(directory).toHaveValue(first);
  await expect(name).toHaveValue("仓库根目录");
  await expect(page.getByRole("tab", { name: /仓库根目录/ })).toHaveCount(0);
  await page.screenshot({
    path: join(evidenceDir, `folder-prefill-${info.project.name}.png`),
  });
  await name.fill(finalName);
  await picker.click();
  await expect(picker).toBeEnabled();
  await expect(name).toHaveValue(finalName);
  await page.route("**/api/project-records/choose-directory", (route) =>
    route.fulfill({ json: { status: "cancelled" } }),
  );
  await picker.click();
  await expect(picker).toBeEnabled();
  await expect(directory).toHaveValue(first);
  await expect(name).toHaveValue(finalName);
  await page.route("**/api/project-records/choose-directory", (route) =>
    route.fulfill({
      status: 422,
      json: { error: "所选文件夹不在 Git 工作树内" },
    }),
  );
  await picker.click();
  await expect(form.getByRole("alert")).toContainText("Git");
  await expect(directory).toHaveValue(first);
  await expect(name).toHaveValue(finalName);
  await form.getByRole("button", { name: "读取项目记录" }).click();
  await expect(
    page.getByRole("tab", { name: new RegExp(finalName) }),
  ).toHaveAttribute("aria-selected", "true");
});

test("T3 submitting the displayed default name registers or renames the same Git root", async ({
  page,
}, info) => {
  const root = fixture("默认名称");
  try {
    const defaultName = `仓库默认名 ${info.project.name}`;
    const previousName = `已有自定义名 ${info.project.name}`;
    await page.route("**/api/project-records/choose-directory", (route) =>
      route.fulfill({
        json: {
          status: "selected",
          projectRoot: root,
          projectName: defaultName,
        },
      }),
    );
    await page.goto("/records");
    const form = page.getByRole("form", { name: "接入项目" });
    const tab = page.getByRole("tab", { name: new RegExp(defaultName) });
    for (const alreadyConnected of [false, true]) {
      if (alreadyConnected) await connect(page, root, previousName);
      await page.getByRole("button", { name: "接入项目", exact: true }).click();
      await form.getByRole("button", { name: "选择文件夹" }).click();
      await expect(form.getByLabel("项目名称（可选）")).toHaveValue(
        defaultName,
      );
      await expect(tab).toHaveCount(0);
      await form.getByRole("button", { name: "读取项目记录" }).click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect(
        page.getByRole("tab", { name: new RegExp(previousName) }),
      ).toHaveCount(0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
