import { DatabaseSync } from "node:sqlite";
import { mkdirSync, openSync, closeSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  LIMITS,
  type Task,
  type Run,
  type Approval,
  type PublishTask,
  type TaskDetail,
  taskSchema,
  runSchema,
  approvalSchema,
  eventSchema,
} from "../shared/protocol.js";
import type { SessionNotification } from "@agentclientprotocol/sdk";
const now = () => new Date().toISOString();
export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(path, "a", 0o600);
    closeSync(fd);
    chmodSync(path, 0o600);
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, run_id TEXT REFERENCES runs(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT REFERENCES runs(id), data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id); CREATE INDEX IF NOT EXISTS approvals_run ON approvals(run_id);
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id);`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  list(): Task[] {
    return this.db
      .prepare("SELECT data FROM tasks ORDER BY rowid DESC LIMIT ?")
      .all(LIMITS.list)
      .map((r) => taskSchema.parse(JSON.parse(r.data as string)));
  }
  queued(): Task | undefined {
    const r = this.db
      .prepare(
        "SELECT data FROM tasks WHERE json_extract(data,'$.status') = 'queued' ORDER BY rowid LIMIT 1",
      )
      .get();
    return r ? taskSchema.parse(JSON.parse(r.data as string)) : undefined;
  }
  countActive(): number {
    return Number(
      this.db
        .prepare(
          "SELECT count(*) AS n FROM tasks WHERE json_extract(data,'$.status') IN ('queued','running','awaiting_approval')",
        )
        .get()!.n,
    );
  }
  task(id: string): Task | undefined {
    const r = this.db.prepare("SELECT data FROM tasks WHERE id=?").get(id);
    return r ? taskSchema.parse(JSON.parse(r.data as string)) : undefined;
  }
  saveTask(t: Task) {
    t.updatedAt = now();
    this.db
      .prepare(
        "INSERT INTO tasks(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(t.id, JSON.stringify(t));
  }
  publish(input: PublishTask): Task {
    const t: Task = {
      ...input,
      id: randomUUID(),
      status: "queued",
      currentRunId: null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.saveTask(t);
    return t;
  }
  saveRun(r: Run) {
    this.db
      .prepare(
        "INSERT INTO runs(id,task_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(r.id, r.taskId, JSON.stringify(r));
  }
  saveApproval(a: Approval) {
    this.db
      .prepare(
        "INSERT INTO approvals(id,run_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(a.id, a.runId, JSON.stringify(a));
  }
  approval(id: string): Approval | undefined {
    const r = this.db.prepare("SELECT data FROM approvals WHERE id=?").get(id);
    return r ? approvalSchema.parse(JSON.parse(r.data as string)) : undefined;
  }
  approvals(runId: string): Approval[] {
    return this.db
      .prepare("SELECT data FROM approvals WHERE run_id=? ORDER BY rowid")
      .all(runId)
      .map((r) => approvalSchema.parse(JSON.parse(r.data as string)));
  }
  appendEvent(runId: string, notification: SessionNotification) {
    this.db
      .prepare("INSERT INTO events(run_id,data) VALUES(?,?)")
      .run(runId, JSON.stringify({ runId, createdAt: now(), notification }));
    this.db
      .prepare(
        "DELETE FROM events WHERE run_id=? AND id NOT IN (SELECT id FROM events WHERE run_id=? ORDER BY id DESC LIMIT ?)",
      )
      .run(runId, runId, LIMITS.events);
  }
  detail(id: string): TaskDetail | undefined {
    const task = this.task(id);
    if (!task) return;
    const runs = this.db
      .prepare("SELECT data FROM runs WHERE task_id=? ORDER BY rowid DESC")
      .all(id)
      .map((r) => runSchema.parse(JSON.parse(r.data as string)));
    const approvals = runs.flatMap((r) => this.approvals(r.id));
    const events = task.currentRunId
      ? this.db
          .prepare("SELECT id,data FROM events WHERE run_id=? ORDER BY id")
          .all(task.currentRunId)
          .map((r) =>
            eventSchema.parse({ ...JSON.parse(r.data as string), id: r.id }),
          )
      : [];
    return { task, runs, approvals, events };
  }
  recover() {
    this.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT data FROM runs WHERE json_extract(data,'$.status') IN ('running','awaiting_approval')",
        )
        .all();
      for (const row of rows) {
        const r = runSchema.parse(JSON.parse(row.data as string));
        r.status = "interrupted";
        r.endedAt = now();
        r.error = "服务重启，原 ACP 连接已丢失；请显式重试。";
        this.saveRun(r);
        const t = this.task(r.taskId)!;
        t.status = "interrupted";
        this.saveTask(t);
      }
      for (const row of this.db
        .prepare(
          "SELECT data FROM approvals WHERE json_extract(data,'$.status')='pending'",
        )
        .all()) {
        const a = approvalSchema.parse(JSON.parse(row.data as string));
        a.status = "expired";
        this.saveApproval(a);
      }
    });
  }
  close() {
    this.db.close();
  }
}
