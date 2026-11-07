import { DatabaseSync } from "node:sqlite";
import { mkdirSync, openSync, closeSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  LIMITS,
  taskTurnSchema,
  taskCommunicationSchema,
  type TaskTurn,
  type TaskCommunication,
  type TaskMessageScope,
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
} from "../../shared/protocol.js";
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
} from "../../shared/task-wakeup.js";
const now = () => new Date().toISOString();
const storedWakeupTargetSchema = wakeupTargetSchema.or(dshWakeupTargetSchema);

const privateMessageFields =
  /^(authorization|cookie|csrf|claimId|publishRequestId|originTurnId|rawInput|rawOutput|(?:subscription|access|refresh|auth|bearer)?token)$|secret|password|api[_-]?key|private[_-]?key/i;
function communicationContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(communicationContent);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !privateMessageFields.test(key))
      .map(([key, item]) => [key, communicationContent(item)]),
  );
}

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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_turns (task_id TEXT NOT NULL REFERENCES tasks(id), task_turn INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(task_id,task_turn));
      CREATE TABLE IF NOT EXISTS task_communications (task_id TEXT NOT NULL REFERENCES tasks(id), seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(task_id,seq));
    `);
    for (const table of ["deliveries", "dsh_publish_requests"]) {
      if (
        !this.db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((row) => row.name === "task_turn")
      )
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN task_turn INTEGER`);
    }
  }
  turns(taskId: string): TaskTurn[] {
    return this.db
      .prepare("SELECT data FROM task_turns WHERE task_id=? ORDER BY task_turn")
      .all(taskId)
      .map((row) => taskTurnSchema.parse(JSON.parse(String(row.data))));
  }
  turn(taskId: string, taskTurn?: number): TaskTurn | undefined {
    const row =
      taskTurn === undefined
        ? this.db
            .prepare(
              "SELECT data FROM task_turns WHERE task_id=? ORDER BY task_turn DESC LIMIT 1",
            )
            .get(taskId)
        : this.db
            .prepare(
              "SELECT data FROM task_turns WHERE task_id=? AND task_turn=?",
            )
            .get(taskId, taskTurn);
    return row ? taskTurnSchema.parse(JSON.parse(String(row.data))) : undefined;
  }
  taskMessageScope(taskId: string): TaskMessageScope | undefined {
    const turn = this.turn(taskId);
    return turn && { taskId, taskTurn: turn.taskTurn };
  }
  runMessageScope(runId: string): TaskMessageScope | undefined {
    const run = this.run(runId);
    return run?.taskTurn === undefined
      ? undefined
      : { taskId: run.taskId, taskTurn: run.taskTurn };
  }
  saveTurn(turn: TaskTurn) {
    this.db
      .prepare(
        "INSERT INTO task_turns VALUES(?,?,?) ON CONFLICT(task_id,task_turn) DO UPDATE SET data=excluded.data",
      )
      .run(
        turn.taskId,
        turn.taskTurn,
        JSON.stringify(taskTurnSchema.parse(turn)),
      );
  }
  communication(
    taskId: string,
    taskTurn: number,
    from: TaskCommunication["from"],
    to: TaskCommunication["to"],
    type: string,
    content: unknown,
  ) {
    const write = () => {
      const seq = this.lastCommunication(taskId) + 1;
      const entry = taskCommunicationSchema.parse({
        taskId,
        taskTurn,
        seq,
        from,
        to,
        type,
        content: communicationContent(content),
        createdAt: now(),
      });
      this.db
        .prepare("INSERT INTO task_communications VALUES(?,?,?)")
        .run(taskId, seq, JSON.stringify(entry));
      return entry;
    };
    return this.inTransaction ? write() : this.transaction(write, false);
  }
  private lastCommunication(taskId: string) {
    const row = this.db
      .prepare(
        "SELECT seq FROM task_communications WHERE task_id=? ORDER BY seq DESC LIMIT 1",
      )
      .get(taskId);
    return Number(row?.seq ?? 0);
  }
  communications(taskId: string, seqAfter = 0) {
    const rows = this.db
      .prepare(
        "SELECT data FROM task_communications WHERE task_id=? AND seq>? ORDER BY seq LIMIT ?",
      )
      .all(taskId, seqAfter, LIMITS.list + 1);
    const entries = rows
      .slice(0, LIMITS.list)
      .map((row) =>
        taskCommunicationSchema.parse(JSON.parse(String(row.data))),
      );
    return {
      entries,
      lastSeq: this.lastCommunication(taskId),
      nextSeqAfter:
        rows.length > LIMITS.list ? (entries.at(-1)?.seq ?? null) : null,
    };
  }
  deliveryTurn(id: number) {
    const row = this.db
      .prepare("SELECT task_id,task_turn FROM deliveries WHERE id=?")
      .get(id);
    return (
      row && {
        taskId: String(row.task_id),
        taskTurn: row.task_turn == null ? undefined : Number(row.task_turn),
      }
    );
  }
  transaction<T>(fn: () => T, notify = true): T {
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    let result: T;
    try {
      result = fn();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.inTransaction = false;
    }
    if (notify) this.onChange();
    return result;
  }
  list(): Task[] {
    return this.db
      .prepare("SELECT data FROM tasks ORDER BY rowid DESC LIMIT ?")
      .all(LIMITS.list)
      .map((r) => {
        const task = taskSchema.parse(JSON.parse(String(r.data)));
        const scope = this.taskMessageScope(task.id);
        return scope ? { ...task, taskTurn: scope.taskTurn } : task;
      });
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
    const latest = this.turn(t.id);
    if (latest && latest.status !== t.status)
      this.saveTurn({ ...latest, status: t.status });
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
    this.saveTurn({
      taskId: t.id,
      taskTurn: 1,
      description: t.description,
      status: t.status,
      createdAt: t.createdAt,
      source: hostTarget
        ? {
            hostId: hostTarget.hostId,
            publisherSessionId:
              hostTarget.publisherSessionId ?? hostTarget.sessionId,
            originTurn: hostTarget.originTurn,
          }
        : null,
      wakeupTarget: target ?? null,
    });
    this.communication(t.id, 1, "publisher", "mingting", "new", taskInput);
    return t;
  }
  dshPublication(hostId: string, requestId: string) {
    const row = this.db
      .prepare(
        "SELECT task_id, fingerprint, task_turn FROM dsh_publish_requests WHERE host_id=? AND request_id=?",
      )
      .get(hostId, requestId);
    return row
      ? {
          taskId: String(row.task_id),
          fingerprint: String(row.fingerprint),
          taskTurn: row.task_turn == null ? undefined : Number(row.task_turn),
        }
      : undefined;
  }
  recordDshPublication(
    hostId: string,
    requestId: string,
    fingerprint: string,
    taskId: string,
    taskTurn = 1,
  ) {
    this.db
      .prepare(
        "INSERT INTO dsh_publish_requests(host_id,request_id,fingerprint,task_id,task_turn) VALUES(?,?,?,?,?)",
      )
      .run(hostId, requestId, fingerprint, taskId, taskTurn);
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
    const target = this.wakeupBinding(taskId);
    return target && "threadId" in target ? target : undefined;
  }
  private wakeupBinding(taskId: string, taskTurn?: number) {
    const turn = this.turn(taskId, taskTurn);
    if (turn) return turn.wakeupTarget ?? undefined;
    const row = this.db
      .prepare("SELECT data FROM task_wakeup_targets WHERE task_id=?")
      .get(taskId);
    return row
      ? storedWakeupTargetSchema.parse(JSON.parse(String(row.data)))
      : undefined;
  }
  browserWakeupSummary(taskId: string) {
    const binding = this.wakeupBinding(taskId);
    if (!binding) return;
    const multipleTurns = (this.turn(taskId)?.taskTurn ?? 0) > 1;
    const target =
      "sessionId" in binding
        ? { sessionId: binding.sessionId, originTurn: binding.originTurn }
        : { sessionId: binding.threadId, originTurn: binding.originTurnId };
    const events = this.db
      .prepare(
        "SELECT e.id, json_extract(e.data,'$.type') AS type, json_extract(e.data,'$.status') AS status, json_extract(r.data,'$.taskTurn') AS taskTurn FROM task_wakeup_events e LEFT JOIN runs r ON r.id=json_extract(e.data,'$.runId') WHERE e.task_id=? ORDER BY e.rowid",
      )
      .all(taskId)
      .map(({ taskTurn, ...event }) =>
        multipleTurns && taskTurn !== null ? { ...event, taskTurn } : event,
      );
    return browserWakeupSummarySchema.parse({ target, events });
  }
  private enqueueWakeup(
    type: WakeupEvent["type"],
    taskId: string,
    runId: string,
    approvalId: string | null,
  ) {
    const target = this.wakeupBinding(taskId, this.run(runId)?.taskTurn);
    if (!target) return;
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
  detail(id: string, seqAfter?: number): TaskDetail | undefined {
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
    const turns = this.turns(id);
    const latest = turns.at(-1);
    return {
      task: latest ? { ...task, taskTurn: latest.taskTurn } : task,
      runs,
      approvals,
      events,
      usageSummary: summarizeUsage(runs),
      ...(latest
        ? {
            turns: turns.map(
              ({ wakeupTarget: _wakeupTarget, ...turn }) => turn,
            ),
            communicationCount: this.lastCommunication(id),
          }
        : {}),
      ...(latest && seqAfter !== undefined
        ? { communications: this.communications(id, seqAfter) }
        : {}),
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
      .prepare(
        "INSERT INTO deliveries(task_id,created_at,task_turn) VALUES(?,?,?)",
      )
      .run(taskId, createdAt, this.turn(taskId)?.taskTurn ?? null);
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
