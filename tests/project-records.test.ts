import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readProjectRecord } from "../src/server/records/importer.js";
import { Store } from "../src/server/storage/store.js";
import { ProjectRecords } from "../src/server/records/service.js";
import { createPlatform } from "../src/server/transport/http.js";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { projectRecordsSchema } from "../src/shared/project-records.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mingting-records-"));
  const write = (path: string, content: string) => {
    const full = join(root, path);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, content);
  };
  write("docs/spec/example/spec.md", "# 示例模块\n\n一个可核对的目标。\n");
  return {
    root,
    write,
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("T1 real Codex spec maps five tasks and nineteen checklist steps", () => {
  const project = readProjectRecord(resolve("."));
  const spec = project.specs.find(
    (s) => s.path === "docs/spec/codex-task-settings-and-audit/spec.md",
  );
  assert.ok(spec, "真实 Spec 应进入记录");
  assert.equal(spec.tasks.length, 5);
  assert.equal(spec.tasks.flatMap((t) => t.steps).length, 19);
  assert.equal(spec.phase, "completed");
  assert.ok(spec.tasks.every((t) => t.phase === "completed" && t.statusSource));
  const evidence = spec.tasks
    .flatMap((t) => t.sources)
    .filter((s) => s.path.endsWith("test-report.md"));
  assert.equal(new Set(evidence.map((s) => s.path)).size, 1);
});

test("T2 explicit status wins, green steps await delivery, unknown remains visible", (t) => {
  const f = fixture();
  t.after(f.clean);
  f.write(
    "docs/spec/example/tech-design.md",
    "# 设计\n实施和真实任务验收待执行。\n",
  );
  f.write(
    "docs/spec/example/tasks/task-a/dev-checklist.md",
    "# task-a · 实现接口\n\n| T1 | 接口 | [x] 🟢 |\n",
  );
  f.write(
    "docs/spec/example/tasks/task-b.md",
    "# 阻塞任务\n> 状态：阻塞：等待需求确认\n\n## ⑤ 验证结果\n历史测试已完成。\n",
  );
  f.write(
    "docs/spec/example/tasks/task-c.md",
    "# 未声明状态\n这里说明已完成后如何处理。\n",
  );
  f.write(
    "docs/spec/example/tasks/task-d.md",
    "# 修改接口\n> 状态：进行中\n\n历史交付记录已完成。\n",
  );
  f.write(
    "docs/spec/example/tasks/task-e.md",
    "# 已交付\n> 状态 已完成 · 2026-11-05\n",
  );
  const tasks = readProjectRecord(f.root).specs[0]?.tasks;
  assert.ok(tasks);
  const task = (part: string) => tasks.find((v) => v.path.includes(part));
  assert.equal(task("task-a")?.phase, "awaiting_review");
  assert.equal(task("task-b")?.blocker, "等待需求确认");
  assert.equal(task("task-c")?.phase, "unknown");
  assert.equal(task("task-d")?.phase, "in_progress");
  assert.equal(task("task-e")?.phase, "completed");
});

test("T2 completion requires matching delivery totals and highlights failed checklist conflicts", (t) => {
  const f = fixture();
  t.after(f.clean);
  const steps =
    "| T1 | 接口 | [x] 🟢 |\n| T2 | 响应 | [x] 🟢 |\n| T3 | 部署 | [x] 🟢 |\n";
  for (const [task, totals] of [
    ["stale", "2/2"],
    ["partial", "2/3"],
    ["complete", "3/3"],
  ]) {
    f.write(
      `docs/spec/example/tasks/task-${task}/dev-checklist.md`,
      `# ${task}\n\n${steps}`,
    );
    f.write(
      `docs/spec/example/tasks/task-${task}/dev-report.md`,
      `# 验证结果\n\n- 行状态 ${totals} 通过\n`,
    );
  }
  f.write(
    "docs/spec/example/tasks/task-conflict/dev-checklist.md",
    "# conflict\n> 状态：已完成\n\n| T1 | 接口 | [ ] 🔴 |\n",
  );
  const tasks = readProjectRecord(f.root).specs[0]?.tasks;
  const byName = (name: string) => tasks?.find((task) => task.title === name);
  assert.equal(byName("stale")?.phase, "awaiting_review");
  assert.equal(byName("partial")?.phase, "awaiting_review");
  assert.equal(byName("complete")?.phase, "completed");
  assert.equal(byName("conflict")?.phase, "unknown");
  assert.match(byName("conflict")?.blocker ?? "", /T1 验证失败/);
});

test("T3 identities are project scoped and content versions track real changes", (t) => {
  const a = fixture(),
    b = fixture();
  t.after(a.clean);
  t.after(b.clean);
  const path = "docs/spec/example/tasks/task-a.md";
  a.write(path, "# A\n> 状态：待实现\n");
  b.write(path, "# A\n> 状态：待实现\n");
  const before = readProjectRecord(a.root),
    other = readProjectRecord(b.root);
  const again = readProjectRecord(a.root);
  assert.equal(again.id, before.id);
  assert.equal(again.sourceVersion, before.sourceVersion);
  assert.notEqual(before.id, other.id);
  assert.notEqual(before.specs[0]?.tasks[0]?.id, other.specs[0]?.tasks[0]?.id);
  a.write(path, "# A\n> 状态：待验证\n");
  const after = readProjectRecord(a.root);
  assert.equal(after.specs[0]?.tasks[0]?.id, before.specs[0]?.tasks[0]?.id);
  assert.notEqual(after.sourceVersion, before.sourceVersion);
  assert.equal(after.specs[0]?.tasks[0]?.phase, "awaiting_review");
});

test("T5 symlink escape is rejected and unsupported task text stays unknown", (t) => {
  const f = fixture(),
    outside = fixture();
  t.after(f.clean);
  t.after(outside.clean);
  mkdirSync(join(f.root, "docs/spec/example/tasks"), { recursive: true });
  outside.write("secret.md", "# secret");
  symlinkSync(
    join(outside.root, "secret.md"),
    join(f.root, "docs/spec/example/tasks/task-secret.md"),
  );
  assert.throws(() => readProjectRecord(f.root), /项目|路径/);
});

test("T3 records persist, refresh transitions, preserve last success on failure", (t) => {
  const f = fixture();
  t.after(f.clean);
  const db = join(f.root, "records.sqlite");
  const store = new Store(db),
    records = new ProjectRecords(store);
  f.write("docs/spec/example/tasks/task-a.md", "# A\n> 状态：待实现\n");
  const before = records.sync({ projectRoot: f.root, projectName: "甲项目" });
  const repeated = records.sync({ projectRoot: f.root });
  assert.equal(repeated.changedAt, before.changedAt);
  assert.equal(records.list().length, 1);
  f.write("docs/spec/example/tasks/task-a.md", "# A\n> 状态：进行中\n");
  records.refresh();
  assert.equal(records.list()[0]?.specs[0]?.tasks[0]?.phase, "in_progress");
  f.write("docs/spec/example/tasks/task-a.md", "# A\n> 状态：已完成\n");
  records.refresh();
  assert.equal(records.list()[0]?.specs[0]?.tasks[0]?.phase, "completed");
  const completed = records.list()[0];
  assert.ok(completed);
  rmSync(join(f.root, "docs"), { recursive: true });
  records.refresh();
  assert.equal(records.list()[0]?.observedAt, completed.observedAt);
  assert.ok(records.list()[0]?.syncError);
  assert.equal(records.list()[0]?.specs[0]?.tasks[0]?.phase, "completed");
  records.close();
  store.close();
  const reopened = new Store(db);
  t.after(() => reopened.close());
  assert.equal(reopened.projectRecords()[0]?.id, before.id);
  assert.equal(reopened.projectRecords()[0]?.name, "甲项目");
});

test("T4 actual MCP import and browser API share records with zero dispatch side effects", async (t) => {
  const f = fixture(),
    second = fixture();
  t.after(f.clean);
  t.after(second.clean);
  for (const [project, phase] of [
    [f, "待验证"],
    [second, "已完成"],
  ] as const) {
    project.write(
      "docs/spec/example/tasks/task-a.md",
      `# 接口\n> 状态：${phase}\n`,
    );
    project.write(
      "docs/spec/example/tasks/task-b.md",
      "# 入口\n> 状态：进行中\n",
    );
    project.write("docs/spec/sibling/spec.md", "# 补充模块\n");
    project.write(
      "docs/spec/sibling/tasks/task-a.md",
      "# 接口\n> 状态：待实现\n",
    );
    project.write(
      "docs/spec/sibling/tasks/task-b.md",
      "# 入口\n> 状态：进行中\n",
    );
  }
  const platform = createPlatform({
    dbPath: join(f.root, "db.sqlite"),
    workspace: f.root,
    mode: "fake",
  });
  const server = createServer(platform.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const client = new Client({ name: "records-test", version: "1" });
  t.after(async () => {
    await client.close();
    await platform.service.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    platform.store.close();
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + "/mcp")),
  );
  let available = 0;
  platform.service.events.on("available", () => available++);
  for (const project of [f, f, second]) {
    const result = await client.callTool({
      name: "sync_project_records",
      arguments: { projectRoot: project.root },
    });
    assert.ok(!result.isError);
  }
  assert.equal(platform.store.list().length, 0);
  assert.equal(platform.store.unfinished().length, 0);
  assert.equal(platform.store.deliveries(0).length, 0);
  assert.equal(available, 0);
  assert.equal((await fetch(base + "/api/project-records")).status, 403);
  const boot = await fetch(base + "/api/bootstrap");
  const cookie = boot.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const rows = projectRecordsSchema.parse(
    await (
      await fetch(base + "/api/project-records", { headers: { cookie } })
    ).json(),
  );
  assert.equal(rows.length, 2);
  const project = rows.find((row) => row.root === realpathSync(f.root));
  const siblingProject = rows.find(
    (row) => row.root === realpathSync(second.root),
  );
  for (const row of [project, siblingProject]) {
    assert.deepEqual(
      row?.specs.map((spec) => spec.tasks.length),
      [2, 2],
    );
    assert.equal(row?.specs[1]?.tasks[0]?.phase, "not_started");
    assert.equal(
      row?.specs[1]?.tasks[0]?.path,
      "docs/spec/sibling/tasks/task-a.md",
    );
  }
  assert.equal(project?.specs[0]?.tasks[0]?.phase, "awaiting_review");
  assert.equal(siblingProject?.specs[0]?.tasks[0]?.phase, "completed");
  const ids = rows.flatMap((row) =>
    row.specs.flatMap((spec) => spec.tasks.map((task) => task.id)),
  );
  assert.equal(new Set(ids).size, 8);
  assert.ok(project);
  const doc = await fetch(
    base +
      `/api/project-records/${project.id}/document?path=docs/spec/example/tasks/task-a.md`,
    { headers: { cookie } },
  );
  assert.equal(doc.status, 200);
  const denied = await fetch(
    base + `/api/project-records/${project.id}/document?path=docs/../../.env`,
    { headers: { cookie } },
  );
  assert.equal(denied.status, 404);
});
