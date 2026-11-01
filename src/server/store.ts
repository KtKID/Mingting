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
  deliveryEventSchema,
  type DeliveryEvent,
} from "../shared/protocol.js";
import type { SessionNotification } from "@agentclientprotocol/sdk";
const now = () => new Date().toISOString();
export class Store {
  private db: DatabaseSync;
  onChange = () => {};
  private inTransaction = false;
  private changed() {
    if (!this.inTransaction) this.onChange();
  }
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
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id);
      CREATE TABLE IF NOT EXISTS runtime_metadata (key TEXT PRIMARY KEY,value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS approval_subscribers (task_id TEXT PRIMARY KEY REFERENCES tasks(id),token_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT REFERENCES tasks(id),created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS leases (run_id TEXT PRIMARY KEY REFERENCES runs(id),owner_id TEXT NOT NULL,claim_id TEXT NOT NULL,deadline INTEGER NOT NULL,seq INTEGER NOT NULL DEFAULT 0);`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      this.inTransaction = false;
      this.onChange();
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      this.inTransaction = false;
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
    this.changed();
  }
  publish(input: PublishTask): Task {
    const t: Task = {
      ...input,
      approvalTargets: input.approvalTargets ?? ["subscriber"],
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
    this.changed();
  }
  saveApproval(a: Approval) {
    this.db
      .prepare(
        "INSERT INTO approvals(id,run_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(a.id, a.runId, JSON.stringify(a));
    this.changed();
  }
  approval(id: string): Approval | undefined {
    const r = this.db.prepare("SELECT data FROM approvals WHERE id=?").get(id);
    return r ? approvalSchema.parse(JSON.parse(r.data as string)) : undefined;
  }
  saveApprovalSubscriber(taskId: string, tokenHash: string) {
    this.db
      .prepare("INSERT INTO approval_subscribers VALUES(?,?)")
      .run(taskId, tokenHash);
  }
  approvalSubscriber(taskId: string, tokenHash: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM approval_subscribers WHERE task_id=? AND token_hash=?",
        )
        .get(taskId, tokenHash),
    );
  }
  pendingApprovals(): Approval[] {
    return this.db
      .prepare(
        "SELECT data FROM approvals WHERE json_extract(data,'$.status')='pending' ORDER BY rowid",
      )
      .all()
      .map((row) => approvalSchema.parse(JSON.parse(String(row.data))));
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
  run(id: string): Run | undefined {
    const row = this.db.prepare("SELECT data FROM runs WHERE id=?").get(id);
    return row ? runSchema.parse(JSON.parse(row.data as string)) : undefined;
  }
  unfinished(): Run[] {
    return this.db
      .prepare(
        "SELECT data FROM runs WHERE json_extract(data,'$.endedAt') IS NULL",
      )
      .all()
      .map((r) => runSchema.parse(JSON.parse(r.data as string)));
  }
  queuedTasks(): Task[] {
    return this.db
      .prepare(
        "SELECT data FROM tasks WHERE json_extract(data,'$.status')='queued' ORDER BY rowid",
      )
      .all()
      .map((r) => taskSchema.parse(JSON.parse(r.data as string)));
  }
  deliver(taskId: string): DeliveryEvent {
    const createdAt = now();
    const result = this.db
      .prepare("INSERT INTO deliveries(task_id,created_at) VALUES(?,?)")
      .run(taskId, createdAt);
    return {
      id: Number(result.lastInsertRowid),
      type: "task.available",
      taskId,
      createdAt,
    };
  }
  deliveries(after: number): DeliveryEvent[] {
    return this.db
      .prepare(
        "SELECT id,task_id,created_at FROM deliveries WHERE id>? ORDER BY id LIMIT 200",
      )
      .all(after)
      .map((r) =>
        deliveryEventSchema.parse({
          id: Number(r.id),
          type: "task.available",
          taskId: r.task_id,
          createdAt: r.created_at,
        }),
      );
  }
  latestDelivery(): number {
    return Number(
      this.db.prepare("SELECT COALESCE(MAX(id),0) AS n FROM deliveries").get()!
        .n,
    );
  }
  lease(
    runId: string,
  ):
    | { ownerId: string; claimId: string; deadline: number; seq: number }
    | undefined {
    const r = this.db.prepare("SELECT * FROM leases WHERE run_id=?").get(runId);
    return r
      ? {
          ownerId: String(r.owner_id),
          claimId: String(r.claim_id),
          deadline: Number(r.deadline),
          seq: Number(r.seq),
        }
      : undefined;
  }
  saveLease(
    runId: string,
    ownerId: string,
    claimId: string,
    deadline: number,
    seq = 0,
  ) {
    this.db
      .prepare(
        "INSERT INTO leases VALUES(?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET deadline=excluded.deadline,seq=excluded.seq",
      )
      .run(runId, ownerId, claimId, deadline, seq);
  }
  quarantineUntil(): number {
    return Number(
      this.db
        .prepare("SELECT value FROM runtime_metadata WHERE key='quarantine'")
        .get()?.value ?? 0,
    );
  }
  setQuarantine(value: number) {
    this.db
      .prepare(
        "INSERT INTO runtime_metadata VALUES('quarantine',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(value);
  }
  recover() {
    this.transaction(() => {
      for (const r of this.unfinished()) {
        if (r.status !== "cancelled") r.status = "interrupted";
        r.endedAt = now();
        r.error = "服务重启，原领取已失效；请显式重试。";
        this.saveRun(r);
        const t = this.task(r.taskId)!;
        t.status = r.status;
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
      // Migrates queued tasks from the earlier direct-execution MVP and reannounces offline work.
      for (const t of this.queuedTasks()) this.deliver(t.id);
    });
  }
  close() {
    this.db.close();
  }
}
