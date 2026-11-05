import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cell,
  generateReport,
  incomplete,
  parseJUnit,
  publishJUnit,
  renderCases,
} from "../scripts/ci-report.js";

test("CI1 native Node JUnit direct cases retain failure, skip and source evidence", () => {
  const cases = parseJUnit(
    `<testsuites><testcase name="pass" file="tests/a.test.ts" time="1"/><testcase name="bad"><failure>wrong result</failure></testcase><testcase name="later"><skipped/></testcase></testsuites>`,
    "unit.xml",
  );
  assert.deepEqual(
    cases.map((item) => item.status),
    ["passed", "failed", "skipped"],
  );
  assert.equal(cases[0]?.file, "tests/a.test.ts");
  assert.match(cases[1]?.details ?? "", /wrong result/);
  const published = publishJUnit(cases);
  assert.match(published, /<testsuite /);
  assert.deepEqual(
    parseJUnit(published, "published.xml").map((item) => item.status),
    ["passed", "failed", "skipped"],
  );
});

test("CI2 Playwright nested suites and XML escaping preserve all cases", () => {
  const cases = parseJUnit(
    `<testsuites><testsuite name="browser" file="tests/ui.spec.ts"><testcase name="approve"/><testsuite name="nested"><testcase name="reject"><error>failed assertion</error></testcase></testsuite></testsuite></testsuites>`,
    "approval.xml",
  );
  assert.equal(cases.length, 2);
  assert.equal(cases[0]?.file, "tests/ui.spec.ts");
  assert.equal(cases[1]?.status, "failed");
  assert.equal(cases[1]?.file, "tests/ui.spec.ts");
  assert.match(renderCases(cases), /approval.xml/);
  assert.equal(cell("a|<script>\nb"), "a&#124;&lt;script&gt; b");
});

test("CI6 changed source omitted from coverage fails the real report command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mingting-ci-missing-source-"));
  try {
    await mkdir(join(dir, "src"));
    await mkdir(join(dir, "reports/ci/evidence/coverage"), { recursive: true });
    await writeFile(join(dir, "src/a.ts"), "export const value = 1;\n");
    await writeFile(
      join(dir, ".c8rc.json"),
      JSON.stringify({ include: ["src/**/*.ts"], exclude: [] }),
    );
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    git(["init", "-q"]);
    git(["add", "."]);
    git([
      "-c",
      "user.name=CI Fixture",
      "-c",
      "user.email=ci@example.invalid",
      "commit",
      "-qm",
      "baseline",
    ]);
    const base = git(["rev-parse", "HEAD"]).trim();
    await writeFile(join(dir, "src/a.ts"), "export const value = 2;\n");
    for (const name of ["unit.xml", "approval.xml"])
      await writeFile(
        join(dir, "reports/ci/evidence", name),
        '<testsuites><testcase name="ok"/></testsuites>',
      );
    await writeFile(
      join(dir, "reports/ci/evidence/diff-coverage.md"),
      "No measured changed lines\n",
    );
    const metric = { total: 1, covered: 1, pct: 100 };
    await writeFile(
      join(dir, "reports/ci/evidence/coverage/coverage-summary.json"),
      JSON.stringify({ total: { lines: metric, branches: metric } }),
    );
    assert.throws(() =>
      execFileSync(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          fileURLToPath(new URL("../scripts/ci-report.ts", import.meta.url)),
        ],
        {
          cwd: dir,
          env: {
            ...process.env,
            BASE_SHA: base,
            HEAD_SHA: base,
            UNIT_OUTCOME: "success",
            APPROVAL_OUTCOME: "success",
            DIFF_OUTCOME: "success",
          },
          stdio: "pipe",
        },
      ),
    );
    assert.match(
      await readFile(join(dir, "reports/ci/test-report.md"), "utf8"),
      /改动源码缺少覆盖数据：src\/a.ts/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CI3 invalid XML and zero selected cases cannot produce a passing test result", () => {
  assert.throws(() => parseJUnit("<testsuites>", "bad.xml"), /Invalid JUnit/);
  assert.throws(
    () => parseJUnit("<testsuites/>", "empty.xml"),
    /no executed cases/,
  );
  assert.equal(
    incomplete(
      { unit: "success", approval: "success", diff: "success" },
      [],
      [],
    ),
    true,
  );
});

test("CI4 missing artifacts still create a failed readable report and run metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mingting-ci-report-"));
  try {
    const failed = await generateReport(dir, "HEAD", "HEAD", {
      unit: "failure",
      approval: "skipped",
      diff: "failure",
    });
    assert.equal(failed, true);
    const report = await readFile(join(dir, "test-report.md"), "utf8");
    assert.match(report, /资料未完整/);
    assert.match(report, /缺少附件.*unit.xml/);
    assert.match(report, /未采集/);
    assert.match(
      await readFile(join(dir, "evidence/run.json"), "utf8"),
      /"failed": true/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CI5 failed and unexecuted stages remain failures even with green JUnit", () => {
  const cases = parseJUnit(
    '<testsuites><testcase name="ok"/></testsuites>',
    "unit.xml",
  );
  const outcomes = { unit: "success", approval: "success", diff: "success" };
  assert.equal(incomplete(outcomes, [], cases), false);
  assert.equal(
    incomplete({ ...outcomes, approval: "skipped" }, [], cases),
    true,
  );
  assert.equal(incomplete(outcomes, ["missing coverage"], cases), true);
});
