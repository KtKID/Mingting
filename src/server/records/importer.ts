import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { z } from "zod";
import {
  aggregateRecordPhase,
  projectRecordSchema,
  type ProjectRecord,
  type RecordedTask,
  type RecordPhase,
  type RecordSource,
  type RecordStep,
} from "../../shared/project-records.js";

export const RECORD_LIMITS = {
  fileBytes: 1024 * 1024,
  specs: 200,
  tasks: 1000,
  projects: 40,
  pollMs: 10000,
};
const missingFile = z.object({ code: z.literal("ENOENT") });
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const sourceId = (root: string, path = "") =>
  digest(`${root}\n${path}`).slice(0, 24);
type Document = { path: string; text: string; lines: string[] };

/** 所有文档读取都经过项目边界与文本类型检查。 */
export function readRecordDocument(root: string, path: string): string {
  if (
    isAbsolute(path) ||
    !/^(docs|reports)\//.test(path) ||
    !/\.(md|txt|log|json)$/.test(path)
  )
    throw new Error("文档路径须位于项目 docs 或 reports 内");
  const canonical = realpathSync(resolve(root, path));
  if (!canonical.startsWith(root + sep))
    throw new Error("文档路径超出项目范围");
  const stat = statSync(canonical);
  if (!stat.isFile() || stat.size > RECORD_LIMITS.fileBytes)
    throw new Error("文档类型或大小超出读取范围");
  return readFileSync(canonical, "utf8");
}
function heading(doc: Document, fallback: string) {
  const title =
    doc.lines
      .find((l) => /^# /.test(l))
      ?.slice(2)
      .trim() ?? fallback;
  return title.replace(/^task-[\w-]+\s*·\s*/, "");
}
function source(doc: Document, line: number, label: string): RecordSource {
  return {
    path: doc.path,
    line: line + 1,
    label,
    excerpt: (doc.lines[line] ?? "").slice(0, 500),
  };
}
function phaseFromHeader(
  doc: Document,
):
  | { phase: RecordPhase; blocker: string | null; source: RecordSource }
  | undefined {
  for (let i = 0; i < Math.min(30, doc.lines.length); i++) {
    const match = doc.lines[i]?.match(
      /^>\s*(?:\*\*)?状态(?:\*\*)?\s*[：:]?\s*(.+)$/,
    );
    if (!match) continue;
    const value = match[1].replace(/\*\*/g, "").trim();
    let phase: RecordPhase;
    if (/^(阻塞|验证失败|失败)/.test(value))
      return {
        phase: "in_progress",
        blocker:
          value.replace(/^(阻塞|验证失败|失败)\s*[：:]?\s*/, "") || value,
        source: source(doc, i, "任务状态"),
      };
    if (/^(已完成|验收通过|已交付)/.test(value)) phase = "completed";
    else if (/^(待验收|待验证|开发完成|开发结束)/.test(value))
      phase = "awaiting_review";
    else if (/^(进行中|开发中|实施中)/.test(value)) phase = "in_progress";
    else if (/^(待实现|待开始|未开始|待开发)/.test(value))
      phase = "not_started";
    else phase = "unknown";
    return { phase, blocker: null, source: source(doc, i, "任务状态") };
  }
  return undefined;
}
function steps(doc: Document): RecordStep[] {
  return doc.lines.flatMap((line) => {
    if (!/^\|\s*T\d+\s*\|/.test(line)) return [];
    const cells = line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((v) => v.trim());
    const raw = cells.at(-1) ?? "";
    const status: RecordStep["status"] = /\[x\].*🟢/i.test(raw)
      ? "passed"
      : /\[!\]|🔴/.test(raw)
        ? "failed"
        : /▶/.test(raw)
          ? "active"
          : /\[ \]/.test(raw)
            ? "pending"
            : "unknown";
    return [{ id: cells[0] ?? "", title: cells[1] ?? "", status }];
  });
}

/** 同步读取可重复的项目快照，任一读取失败保持整次观察失败。 */
export function readProjectRecord(
  inputRoot: string,
  name?: string,
): ProjectRecord {
  if (!isAbsolute(inputRoot)) throw new Error("项目目录须使用绝对路径");
  const root = realpathSync(inputRoot);
  const documents = new Map<string, Document>();
  const read = (path: string, optional = false): Document | undefined => {
    const normalized = relative(root, resolve(root, path)).split(sep).join("/");
    const cached = documents.get(normalized);
    if (cached) return cached;
    try {
      const text = readRecordDocument(root, normalized);
      const doc = { path: normalized, text, lines: text.split(/\r?\n/) };
      documents.set(normalized, doc);
      return doc;
    } catch (error) {
      if (optional && missingFile.safeParse(error).success) return undefined;
      throw error;
    }
  };
  const list = (path: string, optional = false) => {
    try {
      const canonical = realpathSync(resolve(root, path));
      if (!canonical.startsWith(root + sep))
        throw new Error("目录路径超出项目范围");
      return readdirSync(canonical, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    } catch (error) {
      if (optional && missingFile.safeParse(error).success) return [];
      throw error;
    }
  };
  const refs = (doc: Document): RecordSource[] => {
    const found: RecordSource[] = [];
    doc.lines.forEach((line, index) => {
      for (const match of line.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
        const target = match[2]?.split("#")[0];
        if (!target || /^(https?:|mailto:|\/)/.test(target)) continue;
        const path = relative(root, resolve(root, dirname(doc.path), target))
          .split(sep)
          .join("/");
        if (
          !/^(docs|reports)\//.test(path) ||
          !/\.(md|txt|log|json)$/.test(path)
        )
          continue;
        found.push({
          path,
          line: 1,
          label: match[1] ?? path,
          excerpt: `引用自 ${doc.path}:${index + 1}`,
        });
      }
    });
    return found;
  };
  const specEntries = list("docs/spec");
  if (specEntries.length > RECORD_LIMITS.specs)
    throw new Error("项目 Spec 数量超出本批同步上限");
  let taskCount = 0;
  const specs: ProjectRecord["specs"] = [];
  for (const entry of specEntries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const base = `docs/spec/${entry.name}`;
    const specDoc = read(`${base}/spec.md`, true);
    if (!specDoc) continue;
    const tasks: RecordedTask[] = [];
    for (const item of list(`${base}/tasks`, true)) {
      const isFolder =
        item.isDirectory() ||
        (item.isSymbolicLink() && !item.name.endsWith(".md"));
      if (
        !item.name.startsWith("task-") ||
        (!isFolder && !item.name.endsWith(".md"))
      )
        continue;
      const path = isFolder
        ? `${base}/tasks/${item.name}/dev-checklist.md`
        : `${base}/tasks/${item.name}`;
      const doc = read(path, true);
      if (!doc) continue;
      if (++taskCount > RECORD_LIMITS.tasks)
        throw new Error("项目 Task 数量超出本批同步上限");
      const report = isFolder
        ? read(`${base}/tasks/${item.name}/dev-report.md`, true)
        : undefined;
      const internal = isFolder ? steps(doc) : [];
      const explicit =
        phaseFromHeader(doc) ?? (report ? phaseFromHeader(report) : undefined);
      const firstFailed = internal.find((s) => s.status === "failed");
      const deliveryLine =
        report?.lines.findIndex((line) => {
          const totals = /^-\s*行状态\s*(\d+)\/(\d+)\s*通过/.exec(line);
          return (
            Number(totals?.[1]) === internal.length &&
            Number(totals?.[2]) === internal.length
          );
        }) ?? -1;
      let phase: RecordPhase = "unknown";
      let statusSource: RecordSource | null = null;
      let blocker: string | null = null;
      if (explicit) {
        phase = explicit.phase;
        blocker = explicit.blocker;
        statusSource = explicit.source;
        if (phase === "completed" && firstFailed) {
          phase = "unknown";
          blocker = `文档标为已完成，清单中 ${firstFailed.id} 验证失败`;
        }
      } else if (internal.length) {
        if (firstFailed) {
          phase = "in_progress";
          blocker = `${firstFailed.id} 验证失败`;
        } else if (internal.every((s) => s.status === "passed"))
          phase = report && deliveryLine >= 0 ? "completed" : "awaiting_review";
        else if (
          internal.some((s) => s.status === "active" || s.status === "passed")
        )
          phase = "in_progress";
        else if (internal.every((s) => s.status === "pending"))
          phase = "not_started";
        const line = doc.lines.findIndex((l) => /^\|\s*T\d+\s*\|/.test(l));
        statusSource =
          report && phase === "completed"
            ? source(report, deliveryLine, "交付记录")
            : source(doc, Math.max(0, line), "开发清单");
      }
      const references = [
        source(doc, 0, "任务文档"),
        ...refs(doc),
        ...(report ? [source(report, 0, "开发报告"), ...refs(report)] : []),
      ];
      tasks.push({
        id: sourceId(root, path),
        title: heading(doc, item.name),
        path,
        phase,
        blocker,
        summary: statusSource?.excerpt ?? "任务状态等待文档确认",
        steps: internal,
        sources: [...new Map(references.map((s) => [s.path, s])).values()],
        statusSource,
      });
    }
    const goal =
      specDoc.lines.find(
        (l) => /本次目标与范围/.test(l) && !l.startsWith("#"),
      ) ??
      specDoc.lines.find((l) => l.trim() && !/^(#|>|\||<!--)/.test(l)) ??
      "";
    specs.push({
      id: sourceId(root, specDoc.path),
      title: heading(specDoc, entry.name),
      path: specDoc.path,
      goal: goal.replace(/^[-*\s]+|\*\*/g, "").slice(0, 500),
      tasks,
      phase: aggregateRecordPhase(tasks),
    });
  }
  const now = new Date().toISOString();
  return projectRecordSchema.parse({
    id: sourceId(root),
    name: name ?? basename(root),
    root,
    specs,
    sourceVersion: digest(
      [...documents]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, doc]) => `${path}\n${doc.text}`)
        .join("\n"),
    ),
    observedAt: now,
    changedAt: now,
    syncError: null,
  });
}
