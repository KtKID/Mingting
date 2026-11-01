import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { projectDirectory, projectPath } from "../src/server/local-path.js";

test("A11 project state rejects external, live symlink and dangling symlink destinations", async () => {
  await mkdir("var", { recursive: true });
  const local = await mkdtemp(resolve("var/local-path-test-"));
  const external = await mkdtemp(join(tmpdir(), "mingting-path-"));
  try {
    assert.throws(() => projectPath(external));
    assert.throws(() => projectPath(process.cwd()));
    await symlink(external, join(local, "linked"));
    await symlink(join(external, "missing"), join(local, "dangling"));
    for (const name of ["linked", "dangling"])
      assert.throws(() => projectDirectory(join(local, name, "state")));
    assert.equal(projectDirectory(join(local, "state")), join(local, "state"));
  } finally {
    await rm(local, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});
