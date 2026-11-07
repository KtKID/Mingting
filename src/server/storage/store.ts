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
/** 生成用于持久化的 UTC 时间戳。 */
const now = () => new Date().toISOString();
const storedWakeupTargetSchema = wakeupTargetSchema.or(dshWakeupTargetSchema);

const privateMessageFields =
  /^(authorization|cookie|csrf|claimId|publishRequestId|originTurnId|rawInput|rawOutput|(?:subscription|access|refresh|auth|bearer)?token)$|secret|password|api[_-]?key|private[_-]?key/i;
/** 递归清理通信内容，移除匹配敏感字段规则的键和值。 */
function communicationContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(communicationContent);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        /* 过滤凭据、认领标识和工具原始输入输出等私有字段。 */ ([key]) =>
          !privateMessageFields.test(key),
      )
      .map(
        /* 递归清理保留下来的嵌套字段。 */ ([key, item]) => [
          key,
          communicationContent(item),
        ],
      ),
  );
}

/** 跨已结束运行汇总同口径用量，保留覆盖程度与溢出字段。 */
function summarizeUsage(runs: Run[]): TaskDetail["usageSummary"] {
  const finished = runs.filter(/* 仅纳入已结束的运行。 */ (run) => run.endedAt);
  if (
    !finished.some(
      /* 检查任务是否有受审计的执行器或已记录用量。 */ (run) =>
        isAuditedHarness(run.harnessName) || run.usage,
    )
  )
    return;
  const usage = finished.flatMap(
    /* 仅纳入符合主回合统计口径的记录。 */ (run) =>
      run.usage?.scope === "primary_prompt" &&
      run.usage.basis === "token_breakdown_v1"
        ? [run.usage]
        : [],
  );
  const overflow: NonNullable<TaskDetail["usageSummary"]>["overflow"] = [];
  const counts = usageCountsSchema.parse(
    Object.fromEntries(
      usageCountsSchema.keyof().options.map((key) => {
        // 逐个字段汇总有效计数，超出安全整数范围时记录溢出。
        const values = usage
          .map(/* 读取每条用量记录中对应的计数。 */ (entry) => entry[key])
          .filter(
            /* 排除缺报字段，保留实际报告的零值。 */ (value) => value !== null,
          );
        if (!values.length) return [key, null];
        const total = values.reduce(
          /* 用大整数累加该字段，保留溢出判断所需的精度。 */ (sum, value) =>
            sum + BigInt(value),
          0n,
        );
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
      usage.every(
        /* 确认所有纳入的用量记录都完整。 */ (entry) =>
          entry.coverage === "complete",
      ) &&
      !overflow.length
        ? "complete"
        : usage.some(
              /* 确认至少有一条记录报告了用量字段。 */ (entry) =>
                entry.coverage !== "missing",
            )
          ? "partial"
          : "missing",
  };
}

export class Store {
  private db: DatabaseSync;
  /** 为存储变更提供默认空回调，组装服务时可以替换。 */
  onChange = () => {};
  private inTransaction = false;
  /** 在事务外通知监听方，事务内的通知由提交阶段统一处理。 */
  private changed() {
    if (!this.inTransaction) this.onChange();
  }
  /** 打开 SQLite 数据库，创建表与索引并补齐旧库所需的列。 */
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
          .some(
            /* 检查旧表是否已有任务轮次列。 */ (row) =>
              row.name === "task_turn",
          )
      )
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN task_turn INTEGER`);
    }
  }
  /** 按轮次升序读取任务的全部轮次。 */
  turns(taskId: string): TaskTurn[] {
    return this.db
      .prepare("SELECT data FROM task_turns WHERE task_id=? ORDER BY task_turn")
      .all(taskId)
      .map(
        /* 将数据库记录解析为已校验的任务轮次。 */ (row) =>
          taskTurnSchema.parse(JSON.parse(String(row.data))),
      );
  }
  /** 读取指定的任务轮次，省略轮次时读取最新一轮。 */
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
  /** 取得任务最新一轮的通信归属。 */
  taskMessageScope(taskId: string): TaskMessageScope | undefined {
    const turn = this.turn(taskId);
    return turn && { taskId, taskTurn: turn.taskTurn };
  }
  /** 按运行记录上的轮次确定通信归属，兼容缺少轮次的旧记录。 */
  runMessageScope(runId: string): TaskMessageScope | undefined {
    const run = this.run(runId);
    return run?.taskTurn === undefined
      ? undefined
      : { taskId: run.taskId, taskTurn: run.taskTurn };
  }
  /** 按任务 ID 和轮次写入或更新轮次记录。 */
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
  /** 保存脱敏的任务通信，事务内复用当前事务，事务外独立提交。 */
  communication(
    taskId: string,
    taskTurn: number,
    from: TaskCommunication["from"],
    to: TaskCommunication["to"],
    type: string,
    content: unknown,
  ) {
    /** 分配任务内的下一条通信序号并持久化记录。 */
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
  /** 取得任务最新通信序号，空记录从零起算。 */
  private lastCommunication(taskId: string) {
    const row = this.db
      .prepare(
        "SELECT seq FROM task_communications WHERE task_id=? ORDER BY seq DESC LIMIT 1",
      )
      .get(taskId);
    return Number(row?.seq ?? 0);
  }
  /** 按游标分页读取任务通信，多读一行来判断是否需要下一页游标。 */
  communications(taskId: string, seqAfter = 0) {
    const rows = this.db
      .prepare(
        "SELECT data FROM task_communications WHERE task_id=? AND seq>? ORDER BY seq LIMIT ?",
      )
      .all(taskId, seqAfter, LIMITS.list + 1);
    const entries = rows
      .slice(0, LIMITS.list)
      .map(
        /* 解析并校验本页的通信记录。 */ (row) =>
          taskCommunicationSchema.parse(JSON.parse(String(row.data))),
      );
    return {
      entries,
      lastSeq: this.lastCommunication(taskId),
      nextSeqAfter:
        rows.length > LIMITS.list ? (entries.at(-1)?.seq ?? null) : null,
    };
  }
  /** 按投递 ID 查找任务和对应轮次，兼容旧投递记录。 */
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
  /** 在 SQLite 写事务中执行同步操作，失败回滚，提交后按需通知。 */
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
  /** 读取最近创建的一批任务，并附上各自的最新轮次。 */
  list(): Task[] {
    return this.db
      .prepare("SELECT data FROM tasks ORDER BY rowid DESC LIMIT ?")
      .all(LIMITS.list)
      .map((r) => {
        // 校验单条任务，并在存在轮次记录时附上轮次。
        const task = taskSchema.parse(JSON.parse(String(r.data)));
        const scope = this.taskMessageScope(task.id);
        return scope ? { ...task, taskTurn: scope.taskTurn } : task;
      });
  }
  /** 读取最早进入队列的任务。 */
  queued(): Task | undefined {
    const r = this.db
      .prepare(
        "SELECT data FROM tasks WHERE json_extract(data,'$.status') = 'queued' ORDER BY rowid LIMIT 1",
      )
      .get();
    return r ? taskSchema.parse(JSON.parse(r.data as string)) : undefined;
  }
  /** 统计排队、执行中和等待审批的任务总数。 */
  countActive(): number {
    return Number(
      this.db
        .prepare(
          "SELECT count(*) AS n FROM tasks WHERE json_extract(data,'$.status') IN ('queued','running','awaiting_approval')",
        )
        .get()!.n,
    );
  }
  /** 按 ID 读取并校验任务记录。 */
  task(id: string): Task | undefined {
    const r = this.db.prepare("SELECT data FROM tasks WHERE id=?").get(id);
    return r ? taskSchema.parse(JSON.parse(r.data as string)) : undefined;
  }
  /** 更新时间戳和最新轮次状态，保存任务并按需通知监听方。 */
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
  /** 创建排队任务与首轮记录，保存唤醒绑定和发单通信。 */
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
  /** 按宿主和请求 ID 查找幂等发单记录及其指纹。 */
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
  /** 记录宿主发单请求、内容指纹及对应任务轮次。 */
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
  /** 保存运行状态，运行结束时按绑定创建完成唤醒事件。 */
  saveRun(r: Run) {
    this.db
      .prepare(
        "INSERT INTO runs(id,task_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(r.id, r.taskId, JSON.stringify(r));
    if (r.endedAt) this.enqueueWakeup("task.completed", r.taskId, r.id, null);
    this.changed();
  }
  /** 保存审批状态，待审批时按绑定创建审批唤醒事件。 */
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
  /** 取得任务绑定的 Codex 聊天唤醒目标。 */
  wakeupTarget(taskId: string): WakeupTarget | undefined {
    const target = this.wakeupBinding(taskId);
    return target && "threadId" in target ? target : undefined;
  }
  /** 优先读取对应轮次的唤醒绑定，旧任务从原绑定表读取。 */
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
  /** 为网页详情提供最新唤醒目标和该任务的事件状态。 */
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
      .map(
        /* 多轮任务附上事件所属轮次，单轮任务沿用精简事件结构。 */ ({
          taskTurn,
          ...event
        }) =>
          multipleTurns && taskTurn !== null ? { ...event, taskTurn } : event,
      );
    return browserWakeupSummarySchema.parse({ target, events });
  }
  /** 按运行所属轮次的绑定创建待发送事件，用稳定 ID 去重，DSH 仅接收完成事件。 */
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
  /** 按写入顺序查询 Codex 唤醒事件，可限定任务。 */
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
    return rows.map(
      /* 把数据库记录校验为 Codex 唤醒事件。 */ (row) =>
        wakeupEventSchema.parse(JSON.parse(String(row.data))),
    );
  }
  /** 按写入顺序读取待投递的 Codex 唤醒事件。 */
  pendingWakeups(): WakeupEvent[] {
    return this.db
      .prepare(
        "SELECT data FROM task_wakeup_events WHERE json_extract(data,'$.status')='pending' AND json_extract(data,'$.target.hostId') IS NULL ORDER BY rowid",
      )
      .all()
      .map(
        /* 解析每条待投递的 Codex 事件。 */ (row) =>
          wakeupEventSchema.parse(JSON.parse(String(row.data))),
      );
  }
  /** 校验并更新 Codex 唤醒事件，通知服务监听方。 */
  saveWakeup(event: WakeupEvent) {
    const valid = wakeupEventSchema.parse(event);
    this.db
      .prepare("UPDATE task_wakeup_events SET data=? WHERE id=? AND task_id=?")
      .run(JSON.stringify(valid), valid.id, valid.taskId);
    this.changed();
  }
  /** 获取指定 DSH 宿主最早的一条待确认唤醒事件。 */
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
  /** 按事件 ID 和宿主 ID 查询 DSH 唤醒事件。 */
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
  /** 校验并更新 DSH 唤醒事件。 */
  saveDshWakeup(event: DshWakeupEvent) {
    const valid = dshWakeupEventSchema.parse(event);
    this.db
      .prepare("UPDATE task_wakeup_events SET data=? WHERE id=?")
      .run(JSON.stringify(valid), valid.id);
  }
  /** 按 ID 读取并校验审批记录。 */
  approval(id: string): Approval | undefined {
    const r = this.db.prepare("SELECT data FROM approvals WHERE id=?").get(id);
    return r ? approvalSchema.parse(JSON.parse(r.data as string)) : undefined;
  }
  /** 为任务保存审批订阅令牌摘要。 */
  saveApprovalSubscriber(taskId: string, tokenHash: string) {
    this.db
      .prepare("INSERT INTO approval_subscribers VALUES(?,?)")
      .run(taskId, tokenHash);
  }
  /** 为任务保存结果订阅令牌摘要。 */
  saveResultSubscriber(taskId: string, tokenHash: string) {
    this.db
      .prepare("INSERT INTO task_result_subscribers VALUES(?,?)")
      .run(taskId, tokenHash);
  }
  /** 核对任务和结果订阅令牌摘要是否匹配。 */
  resultSubscriber(taskId: string, tokenHash: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM task_result_subscribers WHERE task_id=? AND token_hash=?",
        )
        .get(taskId, tokenHash),
    );
  }
  /** 按写入顺序读取任务的全部已结束运行。 */
  finishedRuns(taskId: string): Run[] {
    return this.db
      .prepare(
        "SELECT data FROM runs WHERE task_id=? AND json_extract(data,'$.endedAt') IS NOT NULL ORDER BY rowid",
      )
      .all(taskId)
      .map(
        /* 解析并校验已结束的运行记录。 */ (row) =>
          runSchema.parse(JSON.parse(String(row.data))),
      );
  }
  /** 核对任务和审批订阅令牌摘要是否匹配。 */
  approvalSubscriber(taskId: string, tokenHash: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM approval_subscribers WHERE task_id=? AND token_hash=?",
        )
        .get(taskId, tokenHash),
    );
  }
  /** 按写入顺序读取仍待处理的审批。 */
  pendingApprovals(): Approval[] {
    return this.db
      .prepare(
        "SELECT data FROM approvals WHERE json_extract(data,'$.status')='pending' ORDER BY rowid",
      )
      .all()
      .map(
        /* 解析并校验待处理的审批记录。 */ (row) =>
          approvalSchema.parse(JSON.parse(String(row.data))),
      );
  }
  /** 按写入顺序读取指定运行的所有审批。 */
  approvals(runId: string): Approval[] {
    return this.db
      .prepare("SELECT data FROM approvals WHERE run_id=? ORDER BY rowid")
      .all(runId)
      .map(
        /* 把数据库记录解析为已校验的审批对象。 */ (r) =>
          approvalSchema.parse(JSON.parse(r.data as string)),
      );
  }
  /** 追加 ACP 原始通知，仅保留该运行最近一批事件。 */
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
  /** 校验并追加运行审计条目，然后通知服务监听方。 */
  appendRunAudit(entry: RunAudit) {
    const audit = runAuditSchema.parse(entry);
    this.db
      .prepare("INSERT INTO run_audit VALUES(?,?,?,?)")
      .run(audit.runId, audit.seq, audit.kind, JSON.stringify(audit));
    this.changed();
  }
  /** 按运行和序号游标读取有数量上限的审计条目。 */
  runAudit(runId: string, after: number, limit: number): RunAudit[] {
    return this.db
      .prepare(
        "SELECT data FROM run_audit WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?",
      )
      .all(runId, after, limit)
      .map(
        /* 解析并校验审计条目的结构。 */ (row) =>
          runAuditSchema.parse(JSON.parse(String(row.data))),
      );
  }
  /** 从审计记录取得运行最近一次上下文用量观测。 */
  latestContext(runId: string) {
    const row = this.db
      .prepare(
        "SELECT data FROM run_audit WHERE run_id=? AND kind='context' ORDER BY seq DESC LIMIT 1",
      )
      .get(runId);
    const audit = row && runAuditSchema.parse(JSON.parse(String(row.data)));
    return audit?.kind === "context" ? audit.observation : undefined;
  }
  /** 组装任务详情、运行、审批、当前运行事件和用量，可附上通信分页。 */
  detail(id: string, seqAfter?: number): TaskDetail | undefined {
    const task = this.task(id);
    if (!task) return;
    const runs = this.db
      .prepare("SELECT data FROM runs WHERE task_id=? ORDER BY rowid DESC")
      .all(id)
      .map((r) => {
        // 解析运行，并为受审计的执行器附上最新上下文观测。
        const run = runSchema.parse(JSON.parse(r.data as string));
        return {
          ...run,
          context: isAuditedHarness(run.harnessName)
            ? this.latestContext(run.id)
            : undefined,
        };
      });
    const approvals = runs.flatMap(
      /* 合并各次运行关联的审批记录。 */ (r) => this.approvals(r.id),
    );
    const events = task.currentRunId
      ? this.db
          .prepare("SELECT id,data FROM events WHERE run_id=? ORDER BY id")
          .all(task.currentRunId)
          .map(
            /* 把 SQLite 行 ID 附到当前运行的原始事件。 */ (r) =>
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
              /* 向详情返回轮次字段时移除内部唤醒绑定。 */ ({
                wakeupTarget: _wakeupTarget,
                ...turn
              }) => turn,
            ),
            communicationCount: this.lastCommunication(id),
          }
        : {}),
      ...(latest && seqAfter !== undefined
        ? { communications: this.communications(id, seqAfter) }
        : {}),
    };
  }
  /** 按 ID 读取并校验单次运行。 */
  run(id: string): Run | undefined {
    const row = this.db.prepare("SELECT data FROM runs WHERE id=?").get(id);
    return row ? runSchema.parse(JSON.parse(row.data as string)) : undefined;
  }
  /** 查找所有尚未记录结束时间的运行。 */
  unfinished(): Run[] {
    return this.db
      .prepare(
        "SELECT data FROM runs WHERE json_extract(data,'$.endedAt') IS NULL",
      )
      .all()
      .map(
        /* 解析重启恢复可能需要处理的运行。 */ (r) =>
          runSchema.parse(JSON.parse(r.data as string)),
      );
  }
  /** 按写入顺序查找全部排队任务。 */
  queuedTasks(): Task[] {
    return this.db
      .prepare(
        "SELECT data FROM tasks WHERE json_extract(data,'$.status')='queued' ORDER BY rowid",
      )
      .all()
      .map(
        /* 解析并校验每条排队任务。 */ (r) =>
          taskSchema.parse(JSON.parse(r.data as string)),
      );
  }
  /** 保存可重放的任务投递事件，并关联当前轮次。 */
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
  /** 从指定游标后按序读取至多 200 条投递事件。 */
  deliveries(after: number): DeliveryEvent[] {
    return this.db
      .prepare(
        "SELECT id,task_id,created_at FROM deliveries WHERE id>? ORDER BY id LIMIT 200",
      )
      .all(after)
      .map(
        /* 将数据库行转换成连接器使用的任务可认领事件。 */ (r) =>
          deliveryEventSchema.parse({
            id: Number(r.id),
            type: "task.available",
            taskId: r.task_id,
            createdAt: r.created_at,
          }),
      );
  }
  /** 取得最新投递 ID，尚无事件时返回零。 */
  latestDelivery(): number {
    return Number(
      this.db.prepare("SELECT COALESCE(MAX(id),0) AS n FROM deliveries").get()!
        .n,
    );
  }
  /** 按运行 ID 查找认领租约及其最后一次上报序号。 */
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
  /** 创建认领租约，续租时只更新截止时间和上报序号。 */
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
  /** 读取全局隔离截止时间，缺省时返回零。 */
  quarantineUntil(): number {
    return Number(
      this.db
        .prepare("SELECT value FROM runtime_metadata WHERE key='quarantine'")
        .get()?.value ?? 0,
    );
  }
  /** 保存全局隔离截止时间。 */
  setQuarantine(value: number) {
    this.db
      .prepare(
        "INSERT INTO runtime_metadata VALUES('quarantine',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(value);
  }
  /** 在事务中恢复重启前留下的任务与审批，并重新广播排队任务。 */
  recover() {
    this.transaction(() => {
      // 终结未收尾运行，使待处理审批过期，并为排队任务补发投递。
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
  /** 关闭 SQLite 数据库连接。 */
  close() {
    this.db.close();
  }
}
