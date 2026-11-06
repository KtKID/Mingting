import { DatabaseSync } from "node:sqlite";
import { mkdirSync, openSync, closeSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  LIMITS,
  isAuditedHarness,
  type Task,
  type Run,
  type Approval,
  type PublishTask,
  type TaskDetail,
  taskSchema,
  runSchema,
  approvalSchema,
  runAuditSchema,
  usageCountsSchema,
  type RunAudit,
  eventSchema,
  deliveryEventSchema,
  browserWakeupSummarySchema,
  type DeliveryEvent,
} from "../shared/protocol.js";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  dshWakeupEventSchema,
  dshWakeupTargetSchema,
  type DshWakeupEvent,
  type DshWakeupTarget,
  wakeupEventSchema,
  wakeupTargetSchema,
  type WakeupEvent,
  type WakeupTarget,
} from "../shared/task-wakeup.js";
const now = () => new Date().toISOString();
const storedWakeupTargetSchema = wakeupTargetSchema.or(dshWakeupTargetSchema);

function summarizeUsage(runs: Run[]): TaskDetail["usageSummary"] {
  const finished = runs.filter((run) => run.endedAt);
  if (!finished.some((run) => isAuditedHarness(run.harnessName) || run.usage))
    return;
  const usage = finished.flatMap((run) =>
    run.usage?.scope === "primary_prompt" &&
    run.usage.basis === "token_breakdown_v1"
      ? [run.usage]
      : [],
  );
  const overflow: NonNullable<TaskDetail["usageSummary"]>["overflow"] = [];
  const counts = usageCountsSchema.parse(
    Object.fromEntries(
      usageCountsSchema.keyof().options.map((key) => {
        const values = usage
          .map((entry) => entry[key])
          .filter((value) => value !== null);
        if (!values.length) return [key, null];
        const total = values.reduce((sum, value) => sum + BigInt(value), 0n);
        if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
          overflow.push(key);
          return [key, null];
        }
        return [key, Number(total)];
      }),
    ),
  );
  return {
    ...counts,
    scope: "primary_prompt",
    basis: "token_breakdown_v1",
    runCount: finished.length,
    overflow,
    coverage:
      usage.length === finished.length &&
      usage.every((entry) => entry.coverage === "complete") &&
      !overflow.length
        ? "complete"
        : usage.some((entry) => entry.coverage !== "missing")
          ? "partial"
          : "missing",
  };
}

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
      CREATE TABLE IF NOT EXISTS run_audit (run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, seq INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run_id,seq));
      CREATE INDEX IF NOT EXISTS run_audit_context ON run_audit(run_id,seq DESC) WHERE kind='context';
      CREATE TABLE IF NOT EXISTS runtime_metadata (key TEXT PRIMARY KEY,value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS approval_subscribers (task_id TEXT PRIMARY KEY REFERENCES tasks(id),token_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_result_subscribers (task_id TEXT PRIMARY KEY REFERENCES tasks(id),token_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT REFERENCES tasks(id),created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS leases (run_id TEXT PRIMARY KEY REFERENCES runs(id),owner_id TEXT NOT NULL,claim_id TEXT NOT NULL,deadline INTEGER NOT NULL,seq INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS task_wakeup_targets (task_id TEXT PRIMARY KEY REFERENCES tasks(id),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_wakeup_events (id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dsh_publish_requests (host_id TEXT NOT NULL,request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id),PRIMARY KEY(host_id,request_id));
      CREATE INDEX IF NOT EXISTS task_wakeup_host_pending ON task_wakeup_events(json_extract(data,'$.target.hostId'),json_extract(data,'$.status')) WHERE json_extract(data,'$.target.hostId') IS NOT NULL;
      CREATE INDEX IF NOT EXISTS task_wakeup_status ON task_wakeup_events(json_extract(data,'$.status'));`);
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
  publish(input: PublishTask, hostTarget?: DshWakeupTarget): Task {
    const { wakeup, ...taskInput } = input;
    const t: Task = {
      ...taskInput,
      approvalTargets: input.approvalTargets ?? ["subscriber"],
      id: randomUUID(),
      status: "queued",
      currentRunId: null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.saveTask(t);
    const target = hostTarget ?? wakeup;
    if (target)
      this.db
        .prepare("INSERT INTO task_wakeup_targets VALUES(?,?)")
        .run(t.id, JSON.stringify(target));
    return t;
  }
  dshPublication(hostId: string, requestId: string) {
    const row = this.db
      .prepare(
        "SELECT task_id, fingerprint FROM dsh_publish_requests WHERE host_id=? AND request_id=?",
      )
      .get(hostId, requestId);
    return row
      ? { taskId: String(row.task_id), fingerprint: String(row.fingerprint) }
      : undefined;
  }
  recordDshPublication(
    hostId: string,
    requestId: string,
    fingerprint: string,
    taskId: string,
  ) {
    this.db
      .prepare("INSERT INTO dsh_publish_requests VALUES(?,?,?,?)")
      .run(hostId, requestId, fingerprint, taskId);
  }
  saveRun(r: Run) {
    this.db
      .prepare(
        "INSERT INTO runs(id,task_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(r.id, r.taskId, JSON.stringify(r));
    if (r.endedAt) this.enqueueWakeup("task.completed", r.taskId, r.id, null);
    this.changed();
  }
  saveApproval(a: Approval) {
    this.db
      .prepare(
        "INSERT INTO approvals(id,run_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(a.id, a.runId, JSON.stringify(a));
    if (a.status === "pending")
      this.enqueueWakeup("approval.requested", a.taskId, a.runId, a.id);
    this.changed();
  }
  wakeupTarget(taskId: string): WakeupTarget | undefined {
    const row = this.db
      .prepare(
        "SELECT data FROM task_wakeup_targets WHERE task_id=? AND json_extract(data,'$.hostId') IS NULL",
      )
      .get(taskId);
    return row
      ? wakeupTargetSchema.parse(JSON.parse(String(row.data)))
      : undefined;
  }
  browserWakeupSummary(taskId: string) {
    const row = this.db
      .prepare("SELECT data FROM task_wakeup_targets WHERE task_id=?")
      .get(taskId);
    if (!row) return;
    const binding = storedWakeupTargetSchema.parse(
      JSON.parse(String(row.data)),
    );
    const target =
      "sessionId" in binding
        ? { sessionId: binding.sessionId, originTurn: binding.originTurn }
        : { sessionId: binding.threadId, originTurn: binding.originTurnId };
    const events = this.db
      .prepare(
        "SELECT id, json_extract(data,'$.type') AS type, json_extract(data,'$.status') AS status FROM task_wakeup_events WHERE task_id=? ORDER BY rowid",
      )
      .all(taskId);
    return browserWakeupSummarySchema.parse({ target, events });
  }
  private enqueueWakeup(
    type: WakeupEvent["type"],
    taskId: string,
    runId: string,
    approvalId: string | null,
  ) {
    const row = this.db
      .prepare("SELECT data FROM task_wakeup_targets WHERE task_id=?")
      .get(taskId);
    if (!row) return;
    const target: unknown = JSON.parse(String(row.data));
    const dshTarget = dshWakeupTargetSchema.safeParse(target);
    if (dshTarget.success && type !== "task.completed") return;
    const record = {
      id: `${type}:${approvalId ?? runId}`,
      type,
      taskId,
      runId,
      approvalId,
      target,
      createdAt: now(),
      status: "pending",
      attempts: 0,
      deliveredAt: null,
      receipt: null,
      error: null,
      resumedTurnId: null,
      acknowledgedAt: null,
    };
    const event = dshTarget.success
      ? dshWakeupEventSchema.parse(record)
      : wakeupEventSchema.parse(record);
    this.db
      .prepare("INSERT OR IGNORE INTO task_wakeup_events VALUES(?,?,?)")
      .run(event.id, taskId, JSON.stringify(event));
  }
  taskWakeups(taskId?: string): WakeupEvent[] {
    const rows = taskId
      ? this.db
          .prepare(
            "SELECT data FROM task_wakeup_events WHERE task_id=? AND json_extract(data,'$.target.hostId') IS NULL ORDER BY rowid",
          )
          .all(taskId)
      : this.db
          .prepare(
            "SELECT data FROM task_wakeup_events WHERE json_extract(data,'$.target.hostId') IS NULL ORDER BY rowid",
          )
          .all();
    return rows.map((row) =>
      wakeupEventSchema.parse(JSON.parse(String(row.data))),
    );
  }
  pendingWakeups(): WakeupEvent[] {
    return this.db
      .prepare(
        "SELECT data FROM task_wakeup_events WHERE json_extract(data,'$.status')='pending' AND json_extract(data,'$.target.hostId') IS NULL ORDER BY rowid",
      )
      .all()
      .map((row) => wakeupEventSchema.parse(JSON.parse(String(row.data))));
  }
  saveWakeup(event: WakeupEvent) {
    const valid = wakeupEventSchema.parse(event);
    this.db
      .prepare("UPDATE task_wakeup_events SET data=? WHERE id=? AND task_id=?")
      .run(JSON.stringify(valid), valid.id, valid.taskId);
    this.changed();
  }
  pendingDshWakeup(hostId: string) {
    const row = this.db
      .prepare(
        "SELECT data FROM task_wakeup_events WHERE json_extract(data,'$.target.hostId') IS NOT NULL AND json_extract(data,'$.target.hostId')=? AND json_extract(data,'$.status')='pending' ORDER BY rowid LIMIT 1",
      )
      .get(hostId);
    return row
      ? dshWakeupEventSchema.parse(JSON.parse(String(row.data)))
      : undefined;
  }
  dshWakeup(eventId: string, hostId: string) {
    const row = this.db
      .prepare(
        "SELECT data FROM task_wakeup_events WHERE id=? AND json_extract(data,'$.target.hostId')=?",
      )
      .get(eventId, hostId);
    return row
      ? dshWakeupEventSchema.parse(JSON.parse(String(row.data)))
      : undefined;
  }
  saveDshWakeup(event: DshWakeupEvent) {
    const valid = dshWakeupEventSchema.parse(event);
    this.db
      .prepare("UPDATE task_wakeup_events SET data=? WHERE id=?")
      .run(JSON.stringify(valid), valid.id);
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
  saveResultSubscriber(taskId: string, tokenHash: string) {
    this.db
      .prepare("INSERT INTO task_result_subscribers VALUES(?,?)")
      .run(taskId, tokenHash);
  }
  resultSubscriber(taskId: string, tokenHash: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM task_result_subscribers WHERE task_id=? AND token_hash=?",
        )
        .get(taskId, tokenHash),
    );
  }
  finishedRuns(taskId: string): Run[] {
    return this.db
      .prepare(
        "SELECT data FROM runs WHERE task_id=? AND json_extract(data,'$.endedAt') IS NOT NULL ORDER BY rowid",
      )
      .all(taskId)
      .map((row) => runSchema.parse(JSON.parse(String(row.data))));
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
  appendRunAudit(entry: RunAudit) {
    const audit = runAuditSchema.parse(entry);
    this.db
      .prepare("INSERT INTO run_audit VALUES(?,?,?,?)")
      .run(audit.runId, audit.seq, audit.kind, JSON.stringify(audit));
    this.changed();
  }
  runAudit(runId: string, after: number, limit: number): RunAudit[] {
    return this.db
      .prepare(
        "SELECT data FROM run_audit WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?",
      )
      .all(runId, after, limit)
      .map((row) => runAuditSchema.parse(JSON.parse(String(row.data))));
  }
  latestContext(runId: string) {
    const row = this.db
      .prepare(
        "SELECT data FROM run_audit WHERE run_id=? AND kind='context' ORDER BY seq DESC LIMIT 1",
      )
      .get(runId);
    const audit = row && runAuditSchema.parse(JSON.parse(String(row.data)));
    return audit?.kind === "context" ? audit.observation : undefined;
  }
  detail(id: string): TaskDetail | undefined {
    const task = this.task(id);
    if (!task) return;
    const runs = this.db
      .prepare("SELECT data FROM runs WHERE task_id=? ORDER BY rowid DESC")
      .all(id)
      .map((r) => {
        const run = runSchema.parse(JSON.parse(r.data as string));
        return {
          ...run,
          context: isAuditedHarness(run.harnessName)
            ? this.latestContext(run.id)
            : undefined,
        };
      });
    const approvals = runs.flatMap((r) => this.approvals(r.id));
    const events = task.currentRunId
      ? this.db
          .prepare("SELECT id,data FROM events WHERE run_id=? ORDER BY id")
          .all(task.currentRunId)
          .map((r) =>
            eventSchema.parse({ ...JSON.parse(r.data as string), id: r.id }),
          )
      : [];
    return {
      task,
      runs,
      approvals,
      events,
      usageSummary: summarizeUsage(runs),
    };
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
