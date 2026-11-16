import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createPlatform } from "../src/server/transport/http.js";
import { bootstrapSchema } from "../src/shared/protocol.js";

function gitFixture(t: TestContext) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "project-picker-")));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, "仓库 with spaces");
  const subdir = join(root, "docs", "spec");
  mkdirSync(subdir, { recursive: true });
  execFileSync("git", ["init", "--quiet", root]);
  return { temp, root, subdir };
}

async function httpFixture(
  t: TestContext,
  choose: (signal: AbortSignal) => Promise<string | null>,
) {
  const repo = gitFixture(t);
  const platform = createPlatform({
    dbPath: join(repo.temp, "records.sqlite"),
    workspace: repo.root,
    mode: "fake",
    chooseProjectDirectory: choose,
  });
  const server = createServer(platform.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await platform.service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    platform.store.close();
  });
  const boot = await fetch(origin + "/api/bootstrap");
  const cookie = boot.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const { csrf } = bootstrapSchema.parse(await boot.json());
  return {
    ...repo,
    platform,
    pick: (
      headers: HeadersInit = { cookie, origin, "x-csrf-token": csrf },
      signal?: AbortSignal,
    ) =>
      fetch(origin + "/api/project-records/choose-directory", {
        method: "POST",
        headers,
        signal,
      }),
    cookie,
    origin,
  };
}

test("T1 selected child folder resolves real Git root and worktree root separately", async (t) => {
  let selected = "";
  const repo = await httpFixture(t, async () => selected);
  selected = repo.subdir;
  const first = await repo.pick();
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), {
    status: "selected",
    projectRoot: repo.root,
    projectName: "仓库 with spaces",
  });
  execFileSync("git", [
    "-C",
    repo.root,
    "-c",
    "user.name=Picker test",
    "-c",
    "user.email=picker@example.invalid",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "Fixture",
  ]);
  const worktree = join(repo.temp, "linked-worktree");
  execFileSync("git", [
    "-C",
    repo.root,
    "worktree",
    "add",
    "--quiet",
    "--detach",
    worktree,
  ]);
  selected = join(worktree, "src");
  mkdirSync(selected);
  const linked = await repo.pick();
  assert.equal(linked.status, 200);
  assert.deepEqual(await linked.json(), {
    status: "selected",
    projectRoot: worktree,
    projectName: "linked-worktree",
  });
});

test("T2 directory picker needs session and CSRF, handles cancellation and non-Git, and records no changes", async (t) => {
  let selected: string | null = null;
  let count = 0;
  const repo = await httpFixture(t, async () => {
    count++;
    return selected;
  });
  assert.equal((await repo.pick({})).status, 403);
  assert.equal(
    (await repo.pick({ cookie: repo.cookie, origin: repo.origin })).status,
    403,
  );
  assert.equal(count, 0);
  const canceled = await repo.pick();
  assert.equal(canceled.status, 200);
  assert.deepEqual(await canceled.json(), { status: "cancelled" });
  selected = repo.temp;
  const invalid = await repo.pick();
  assert.equal(invalid.status, 422);
  assert.match(JSON.stringify(await invalid.json()), /Git/);
  assert.deepEqual(repo.platform.store.projectRecords(), []);
  assert.deepEqual(repo.platform.store.list(), []);
  assert.deepEqual(repo.platform.store.unfinished(), []);
  assert.deepEqual(repo.platform.store.deliveries(0), []);
});

test(
  "T2 closing a pending request aborts the dialog and lets the next request pick",
  { timeout: 5000 },
  async (t) => {
    const events = new EventEmitter();
    const started = once(events, "started");
    const aborted = once(events, "aborted");
    let requests = 0;
    const repo = await httpFixture(t, async (signal) => {
      if (++requests > 1) return null;
      events.emit("started");
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      events.emit("aborted");
      return null;
    });
    const controller = new AbortController();
    const closed = assert.rejects(repo.pick(undefined, controller.signal), {
      name: "AbortError",
    });
    await started;
    assert.equal((await repo.pick()).status, 409);
    controller.abort();
    await closed;
    await aborted;
    const retry = await repo.pick();
    assert.deepEqual(await retry.json(), { status: "cancelled" });
    assert.equal(requests, 2);
  },
);
