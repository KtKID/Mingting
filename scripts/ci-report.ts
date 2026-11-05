import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { isAbsolute, matchesGlob, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";

const rawCase = z.object({
  "@_name": z.string(),
  "@_classname": z.string().optional(),
  "@_file": z.string().optional(),
  "@_time": z.coerce.number().finite().nonnegative().default(0),
  failure: z.unknown().optional(),
  error: z.unknown().optional(),
  skipped: z.unknown().optional(),
});
const rawSuite = z.object({
  "@_name": z.string().default("tests"),
  "@_file": z.string().optional(),
  testcase: z.array(rawCase).default([]),
  testsuite: z.array(z.unknown()).default([]),
});
const documentSchema = z.object({
  testsuites: z.unknown().optional(),
  testsuite: z.array(z.unknown()).optional(),
});
const testCase = z.object({
  name: z.string(),
  suite: z.string(),
  file: z.string(),
  seconds: z.number(),
  status: z.enum(["passed", "failed", "skipped"]),
  details: z.string(),
  evidence: z.string(),
});
export type TestCase = z.infer<typeof testCase>;

export function parseJUnit(xml: string, evidence: string): TestCase[] {
  const valid = XMLValidator.validate(xml);
  if (valid !== true) throw new Error(`Invalid JUnit XML: ${valid.err.msg}`);
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    isArray: (name) => name === "testcase" || name === "testsuite",
  });
  const parsed: unknown = parser.parse(xml);
  const doc = documentSchema.parse(parsed);
  function visit(input: unknown, parent = "", parentFile = ""): TestCase[] {
    const suite = rawSuite.parse(input);
    const name = parent ? `${parent} / ${suite["@_name"]}` : suite["@_name"];
    return [
      ...suite.testcase.map((item) =>
        testCase.parse({
          name: item["@_name"],
          suite: name,
          file: item["@_file"] ?? suite["@_file"] ?? parentFile,
          seconds: item["@_time"],
          status:
            item.failure !== undefined || item.error !== undefined
              ? "failed"
              : item.skipped !== undefined
                ? "skipped"
                : "passed",
          details:
            JSON.stringify(item.failure ?? item.error ?? item.skipped) ?? "",
          evidence,
        }),
      ),
      ...suite.testsuite.flatMap((child) =>
        visit(child, name, suite["@_file"] ?? parentFile),
      ),
    ];
  }
  const cases = doc.testsuites
    ? visit(doc.testsuites)
    : (doc.testsuite ?? []).flatMap((suite) => visit(suite));
  if (!cases.length)
    throw new Error(`JUnit has no executed cases: ${evidence}`);
  return cases;
}

export function publishJUnit(cases: TestCase[]): string {
  return new XMLBuilder({ ignoreAttributes: false, format: true }).build({
    testsuites: {
      testsuite: {
        "@_name": "Mingting CI",
        "@_tests": cases.length,
        "@_failures": cases.filter((item) => item.status === "failed").length,
        "@_skipped": cases.filter((item) => item.status === "skipped").length,
        "@_time": cases.reduce((sum, item) => sum + item.seconds, 0),
        testcase: cases.map((item) => ({
          "@_name": item.name,
          "@_classname": item.suite,
          "@_file": item.file,
          "@_time": item.seconds,
          ...(item.status === "failed"
            ? { failure: { "#text": item.details } }
            : {}),
          ...(item.status === "skipped" ? { skipped: "" } : {}),
        })),
      },
    },
  });
}

const metric = z.object({
  total: z.number().int().nonnegative(),
  covered: z.number().int().nonnegative(),
  pct: z.number().min(0).max(100),
});
const coverageSchema = z.record(
  z.string(),
  z.object({ lines: metric, branches: metric }),
);
const configSchema = z.object({
  include: z.array(z.string()),
  exclude: z.array(z.string()),
});
const outcomesSchema = z.record(z.string(), z.string());
export const cell = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;")
    .replaceAll(/\r?\n/g, " ");

export function renderCases(cases: TestCase[], head?: string): string {
  return [
    "| 用例 / 操作与预期主定义 | 结果 | 秒 | 实际失败/跳过信息 | 原始记录 |",
    "|---|---|---:|---|---|",
    ...cases.map(
      (item) =>
        `| ${cell(item.name)} (${item.file && head ? `[源码](https://github.com/KtKID/Mingting/blob/${encodeURIComponent(head)}/${item.file.split("/").map(encodeURIComponent).join("/")})` : cell(item.file || item.suite)}) | ${item.status} | ${item.seconds.toFixed(3)} | ${cell(item.details)} | [JUnit](${item.evidence}) |`,
    ),
  ].join("\n");
}

export function incomplete(
  outcomes: Record<string, string>,
  problems: string[],
  cases: TestCase[],
) {
  return (
    problems.length > 0 ||
    !cases.length ||
    cases.some((item) => item.status === "failed") ||
    ["unit", "approval", "diff"].some((stage) => outcomes[stage] !== "success")
  );
}

export async function generateReport(
  directory: string,
  base: string,
  head: string,
  outcomes: Record<string, string>,
) {
  const root = process.cwd();
  const problems: string[] = [];
  const cases: TestCase[] = [];
  const load = async (name: string) => {
    try {
      const text = await readFile(resolve(directory, name), "utf8");
      if (!text.trim()) throw new Error("empty attachment");
      return text;
    } catch {
      problems.push(`缺少附件：${name}`);
      return undefined;
    }
  };
  for (const name of ["unit.xml", "approval.xml"]) {
    const xml = await load(`evidence/${name}`);
    if (xml !== undefined) {
      try {
        cases.push(
          ...parseJUnit(xml, `evidence/${name}`).map((item) => ({
            ...item,
            file: isAbsolute(item.file) ? relative(root, item.file) : item.file,
          })),
        );
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  const diff = await load("evidence/diff-coverage.md");
  const rawCoverage = await load("evidence/coverage/coverage-summary.json");
  let coverage = coverageSchema.parse({});
  if (rawCoverage !== undefined) {
    try {
      coverage = coverageSchema.parse(JSON.parse(rawCoverage));
    } catch (error) {
      problems.push(`覆盖数据格式错误：${String(error)}`);
    }
  }
  if (!coverage.total) problems.push("覆盖数据缺少 total");
  const config = configSchema.parse(
    JSON.parse(await readFile(resolve(root, ".c8rc.json"), "utf8")),
  );
  const changed = execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", "-z", base],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  const inScope = changed.filter(
    (path) =>
      config.include.some((pattern) => matchesGlob(path, pattern)) &&
      !config.exclude.some((pattern) => matchesGlob(path, pattern)),
  );
  const byPath = new Map(
    Object.entries(coverage).map(([path, metrics]) => [
      isAbsolute(path) ? relative(root, path) : path,
      metrics,
    ]),
  );
  for (const path of inScope)
    if (!byPath.has(path)) problems.push(`改动源码缺少覆盖数据：${path}`);
  const branchRows = inScope.map((path) => {
    const data = byPath.get(path);
    return `| ${cell(path)} | ${data ? `${data.branches.covered}/${data.branches.total} (${data.branches.pct}%)` : "未采集"} |`;
  });
  const failed = incomplete(outcomes, problems, cases);
  const report = [
    "# 明庭 · 本次代码改动测试报告",
    "",
    `- 结论：${failed ? "失败 / 资料未完整" : "通过"}`,
    `- 比较基线：\`${base}\` → 被测版本：\`${head}\``,
    `- 测试：通过 ${cases.filter((item) => item.status === "passed").length}，失败 ${cases.filter((item) => item.status === "failed").length}，跳过 ${cases.filter((item) => item.status === "skipped").length}`,
    `- 阶段：${Object.entries(outcomes)
      .map(([key, value]) => `${key}=${value}`)
      .join(", ")}`,
    "- 统计范围：本批 node:test 与审批服务进程合计；网页客户端运行时覆盖另行采集。操作、预期与断言以测试源码及审批场景定义为主定义。",
    "",
    "## 本次修改覆盖率与未覆盖行",
    "",
    diff ?? "未采集",
    "",
    "## 本次修改文件的分支覆盖（整文件口径）",
    "",
    "| 修改文件 | 整文件分支已覆盖/总数 |",
    "|---|---|",
    ...branchRows,
    ...(inScope.length ? [] : ["| 本次范围内零可执行源码改动 | 不适用 |"]),
    "",
    "## 用例明细",
    "",
    renderCases(cases, head),
    "",
    "## 缺口与边界",
    "",
    ...problems.map((problem) => `- ${cell(problem)}`),
    "- diff-cover 提供改动行与未覆盖位置；分支表采用整文件统计。用例与覆盖数据按测试批次关联，逐用例动态覆盖归属另行采集。",
    "- 真实模型、当前聊天唤醒及线上私人数据验收按各功能定义另行执行。",
    "",
    "## 附件",
    "",
    "- [发布用 JUnit 汇总](evidence/results.xml)",
    "- [Node 原始 JUnit](evidence/unit.xml) / [审批原始 JUnit](evidence/approval.xml)",
    "- [覆盖率原始数据](evidence/coverage/coverage-final.json) / [Cobertura](evidence/coverage/cobertura-coverage.xml)",
    "- [后端输出](evidence/unit.log) / [审批与构建输出](evidence/approval.log) / [diff-cover 输出](evidence/diff.log)",
    "- 本机审批回放位于 reports/approval-e2e/runs/。",
    "",
  ].join("\n");
  await mkdir(resolve(directory, "evidence"), { recursive: true });
  await writeFile(resolve(directory, "test-report.md"), report);
  await writeFile(
    resolve(directory, "evidence/results.xml"),
    publishJUnit(cases),
  );
  await writeFile(
    resolve(directory, "evidence/run.json"),
    JSON.stringify(
      {
        base,
        head,
        outcomes,
        problems,
        failed,
        node: process.version,
        cwd: root,
      },
      null,
      2,
    ) + "\n",
  );
  return failed;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const env = z
    .object({
      BASE_SHA: z.string().min(1),
      HEAD_SHA: z.string().min(1),
      UNIT_OUTCOME: z.string().default("not-run"),
      APPROVAL_OUTCOME: z.string().default("not-run"),
      DIFF_OUTCOME: z.string().default("not-run"),
    })
    .parse(process.env);
  const failed = await generateReport(
    "reports/ci",
    env.BASE_SHA,
    env.HEAD_SHA,
    outcomesSchema.parse({
      unit: env.UNIT_OUTCOME,
      approval: env.APPROVAL_OUTCOME,
      diff: env.DIFF_OUTCOME,
    }),
  );
  process.exitCode = failed ? 1 : 0;
}
