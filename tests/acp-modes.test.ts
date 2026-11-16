import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import { CodexAdapter } from "../src/server/harness/codex/codex-adapter.js";

test("ACP diagnostics correlate request phases and omit task text", async (t) => {
  const workspace = await mkdtemp(resolve(tmpdir(), "mingting-acp-log-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const messages: string[] = [];
  t.mock.method(console, "info", (message: string) => messages.push(message));
  const diagnosticContext = { taskId: "task", runId: "run", taskTurn: 2 };
  const prompt = "private task text for diagnostics regression";
  const adapter = new CodexAdapter({
    command: process.execPath,
    args: [
      "--import",
      import.meta.resolve("tsx"),
      resolve("tests/fake-acp.ts"),
    ],
    workspace,
    env: { PATH: process.env.PATH },
  });

  const result = await adapter.execute(prompt, AbortSignal.timeout(5000), {
    diagnosticContext,
    discovery: () => {},
    session: () => {},
    update: () => {},
    permission: async () => ({ outcome: { outcome: "cancelled" } }),
  });
  assert.equal(result, "end_turn");
  assert.doesNotMatch(messages.join("\n"), /private task text/);
  const entries = z
    .array(
      z.object({
        event: z.string(),
        taskId: z.literal(diagnosticContext.taskId),
        runId: z.literal(diagnosticContext.runId),
        taskTurn: z.literal(diagnosticContext.taskTurn),
        acpPid: z.int().positive(),
        method: z.string().optional(),
        outcome: z.string().optional(),
        promptStarted: z.boolean().optional(),
      }),
    )
    .parse(messages.map((message) => JSON.parse(message)));
  const requests = entries.filter(
    (entry) => entry.event === "acp.request.finished",
  );
  assert.deepEqual(
    requests.map(({ method, outcome, promptStarted }) => [
      method,
      outcome,
      promptStarted,
    ]),
    [
      ["initialize", "ok", false],
      ["session/new", "ok", false],
      ["session/set_mode", "ok", false],
      ["session/prompt", "ok", true],
    ],
  );
  assert.equal(entries.at(-1)?.event, "acp.cleanup.finished");
  assert.equal(entries.at(-1)?.outcome, "ok");
});

test("A9 Grok cached-token ACP supports launch plan without advertised modes; Codex keeps required workspace mode", async () => {
  const base = {
    command: process.execPath,
    args: [
      "--import",
      import.meta.resolve("tsx"),
      resolve("tests/fake-acp.ts"),
    ],
    workspace: process.cwd(),
    env: { PATH: process.env.PATH, FAKE_GROK: "1" },
  };
  const hooks = {
    session: () => {},
    discovery: () => {},
    update: () => {},
    permission: async () => ({ outcome: { outcome: "cancelled" as const } }),
  };
  assert.equal(
    await new CodexAdapter({
      ...base,
      harnessName: "Grok",
      sessionMode: null,
      authMethod: "cached_token",
    }).execute("hi", AbortSignal.timeout(5000), hooks),
    "end_turn",
  );
  await assert.rejects(
    new CodexAdapter(base).execute("hi", AbortSignal.timeout(5000), hooks),
    /workspace-write/,
  );
});

for (const finish of ["正常结束", "崩溃"] as const) {
  test(
    `B3 ACP ${finish}时回收同组内拒绝退出的两层后代`,
    {
      skip: process.platform === "win32" && "此用例使用 Unix 进程组",
    },
    async (t) => {
      // 2026-11-07 全仓检查中，ACP 主进程正常结束，同组后代忽略 SIGTERM 后仍在运行。
      // 夹具等两层后代都装好信号处理器才结束主进程，覆盖正常退出和崩溃的收尾。
      const dir = await mkdtemp(resolve(tmpdir(), "mingting-acp-descendant-"));
      const pidFile = resolve(dir, "descendant.pid");
      const readPids = async () =>
        z
          .tuple([z.int().min(2), z.int().min(2)])
          .parse(JSON.parse(await readFile(pidFile, "utf8")));
      t.after(async () => {
        try {
          for (const pid of await readPids().catch(() => [])) {
            try {
              process.kill(pid, "SIGKILL");
            } catch (error) {
              if (!(
                error instanceof Error &&
                "code" in error &&
                error.code === "ESRCH"
              ))
                throw error;
            }
          }
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
      const adapter = new CodexAdapter({
        command: process.execPath,
        args: [
          "--import",
          import.meta.resolve("tsx"),
          resolve("tests/fake-acp.ts"),
        ],
        workspace: dir,
        mode: "fake",
        env: { PATH: process.env.PATH, FAKE_DESCENDANT_PID_FILE: pidFile },
      });
      const run = adapter.execute(
        finish === "崩溃"
          ? "[review-b3-descendant][crash]"
          : "[review-b3-descendant]",
        AbortSignal.timeout(6000),
        {
          session: () => {},
          discovery: () => {},
          update: () => {},
          permission: async () => ({ outcome: { outcome: "cancelled" } }),
        },
      );
      if (finish === "崩溃")
        await assert.rejects(run, /ACP 子进程已退出|ACP connection closed/);
      else assert.equal(await run, "end_turn");
      const pids = await readPids();
      assert.equal(new Set(pids).size, 2);
      for (const pid of pids) {
        const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
          encoding: "utf8",
        });
        assert.ifError(state.error);
        assert.ok(state.status === 0 || state.status === 1, state.stderr);
        // 系统可以暂时保留已退出的进程表项，Z 状态代表进程已经停止运行。
        assert.match(
          state.stdout.trim(),
          /^(?:Z.*)?$/,
          `ACP 收尾后同组后代 ${pid} 仍在运行`,
        );
      }
    },
  );
}
