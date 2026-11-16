import { realpathSync } from "node:fs";
import {
  syncProjectRecordsSchema,
  type ProjectRecord,
} from "../../shared/project-records.js";
import type { Store } from "../storage/store.js";
import {
  RECORD_LIMITS,
  readProjectRecord,
  readRecordDocument,
} from "./importer.js";

/** 管理来源观察生命周期，向所有展示客户端提供相同快照。 */
export class ProjectRecords {
  private timer: ReturnType<typeof setInterval>;
  constructor(private store: Store) {
    this.timer = setInterval(() => this.refresh(), RECORD_LIMITS.pollMs);
    this.timer.unref();
  }
  list() {
    return this.store.projectRecords();
  }
  sync(raw: unknown): ProjectRecord {
    const input = syncProjectRecordsSchema.parse(raw);
    const root = realpathSync(input.projectRoot);
    const existing = this.list();
    const previous = existing.find((p) => p.root === root);
    if (!previous && existing.length >= RECORD_LIMITS.projects)
      throw new Error("已接入项目数量达到上限");
    try {
      const next = readProjectRecord(root, input.projectName ?? previous?.name);
      if (previous && previous.sourceVersion === next.sourceVersion)
        next.changedAt = previous.changedAt;
      this.store.saveProjectRecord(next);
      return next;
    } catch (error) {
      if (previous)
        this.store.saveProjectRecord({
          ...previous,
          syncError: error instanceof Error ? error.message : "项目同步失败",
        });
      throw error;
    }
  }
  refresh() {
    for (const project of this.list()) {
      try {
        this.sync({ projectRoot: project.root });
      } catch (error) {
        // 根目录暂时离线也保留上次成功快照及其观察时间。
        this.store.saveProjectRecord({
          ...project,
          syncError: error instanceof Error ? error.message : "项目同步失败",
        });
      }
    }
  }
  document(id: string, path: string) {
    const project = this.list().find((p) => p.id === id);
    if (!project) throw new Error("项目记录不存在");
    const paths = project.specs.flatMap((s) => [
      s.path,
      ...s.tasks.flatMap((t) => t.sources.map((r) => r.path)),
    ]);
    if (!paths.includes(path)) throw new Error("文档路径未登记在本项目记录中");
    return { path, content: readRecordDocument(project.root, path) };
  }
  close() {
    clearInterval(this.timer);
  }
}
