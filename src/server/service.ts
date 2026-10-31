import { randomUUID } from "node:crypto";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  JsonRpcId,
} from "@agentclientprotocol/sdk";
import {
  LIMITS,
  publishTaskSchema,
  type PublishTask,
  type Decision,
  type Run,
  type Task,
} from "../shared/protocol.js";
import { Store } from "./store.js";
import { CodexAdapter } from "./codex-adapter.js";
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const now = () => new Date().toISOString();
const cancelled = (): RequestPermissionResponse => ({
  outcome: { outcome: "cancelled" },
});
type Pending = {
  runId: string;
  resolve: (v: RequestPermissionResponse) => void;
  timer: NodeJS.Timeout;
  cleanup: () => void;
};
export class TaskService {
  private active?: { task: Task; run: Run; abort: AbortController };
  private pending = new Map<string, Pending>();
  private pumping = false;
  private closed = false;
  private drainPromise: Promise<void> = Promise.resolve();
  constructor(
    public store: Store,
    private adapter: CodexAdapter,
  ) {
    store.recover();
    this.kick();
  }
  publish(raw: PublishTask) {
    if (this.closed) throw new AppError(503, "服务正在停止");
    const input = publishTaskSchema.parse(raw);
    if (this.store.countActive() >= LIMITS.queue)
      throw new AppError(429, "队列已满");
    const task = this.store.publish(input);
    this.kick();
    return { taskId: task.id };
  }
  private kick() {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    this.drainPromise = Promise.resolve()
      .then(() => this.drain())
      .finally(() => {
        this.pumping = false;
        if (!this.closed && this.store.queued()) this.kick();
      });
  }
  private async drain() {
    while (!this.closed) {
      const task = this.store.queued();
      if (!task) break;
      const run: Run = {
        id: randomUUID(),
        taskId: task.id,
        status: "running",
        sessionId: null,
        createdAt: now(),
        endedAt: null,
        output: "",
        error: null,
        stopReason: null,
        discovery: null,
      };
      task.status = "running";
      task.currentRunId = run.id;
      this.store.transaction(() => {
        this.store.saveRun(run);
        this.store.saveTask(task);
      });
      const abort = new AbortController();
      this.active = { task, run, abort };
      const timeout = setTimeout(
        () => abort.abort(new Error("执行超时")),
        LIMITS.runMs,
      );
      try {
        run.stopReason = await this.adapter.execute(
          `${task.title}\n\n${task.description}`,
          abort.signal,
          {
            session: (id) => {
              run.sessionId = id;
              this.store.saveRun(run);
            },
            discovery: (value) => {
              run.discovery = value;
              this.store.saveRun(run);
            },
            update: (value) => {
              this.store.appendEvent(run.id, value);
              const u = value.update;
              if (
                u.sessionUpdate === "agent_message_chunk" &&
                u.content.type === "text"
              )
                run.output = (run.output + u.content.text).slice(
                  -LIMITS.outputChars,
                );
              this.store.saveRun(run);
            },
            permission: (id, request, signal) =>
              this.permission(task, run, id, request, signal),
          },
        );
        if (!abort.signal.aborted) {
          task.status = run.status =
            run.stopReason === "end_turn"
              ? "succeeded"
              : run.stopReason === "cancelled"
                ? "cancelled"
                : "failed";
          if (run.status === "failed")
            run.error = "ACP 回合未正常结束：" + run.stopReason;
        }
      } catch (e) {
        if (!["cancelled", "interrupted"].includes(task.status)) {
          task.status = run.status = "failed";
          run.error =
            e instanceof Error ? e.message.slice(0, 2000) : "ACP 执行失败";
        }
      } finally {
        clearTimeout(timeout);
        this.expire(run.id);
        run.endedAt = now();
        this.store.transaction(() => {
          this.store.saveRun(run);
          this.store.saveTask(task);
        });
        this.active = undefined;
      }
    }
  }
  private permission(
    task: Task,
    run: Run,
    requestId: JsonRpcId,
    request: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    if (
      this.closed ||
      signal.aborted ||
      this.active?.abort.signal.aborted ||
      run.sessionId !== request.sessionId
    )
      return Promise.resolve(cancelled());
    const previous = this.store.approvals(run.id);
    if (
      previous.length >= LIMITS.approvalsPerRun ||
      this.pending.size >= LIMITS.pendingApprovals
    ) {
      this.cancel(task.id, "审批请求数量超限");
      return Promise.resolve(cancelled());
    }
    if (previous.some((a) => a.requestId === requestId))
      throw new AppError(409, "重复 ACP 请求 ID");
    const id = randomUUID();
    const approval = {
      id,
      taskId: task.id,
      runId: run.id,
      sessionId: request.sessionId,
      requestId,
      request,
      status: "pending" as const,
      optionId: null,
      createdAt: now(),
    };
    task.status = run.status = "awaiting_approval";
    this.store.transaction(() => {
      this.store.saveApproval(approval);
      this.store.saveRun(run);
      this.store.saveTask(task);
    });
    return new Promise((resolve) => {
      const expire = () => this.expireOne(id);
      const timer = setTimeout(() => {
        expire();
        this.cancel(task.id, "审批超时");
      }, LIMITS.approvalMs);
      const cleanup = () => signal.removeEventListener("abort", expire);
      this.pending.set(id, { runId: run.id, resolve, timer, cleanup });
      signal.addEventListener("abort", expire, { once: true });
    });
  }
  decide(id: string, decision: Decision) {
    const a = this.store.approval(id);
    const callback = this.pending.get(id);
    const active = this.active;
    if (
      !a ||
      a.status !== "pending" ||
      !callback ||
      !active ||
      active.abort.signal.aborted ||
      active.run.id !== a.runId ||
      a.runId !== decision.runId ||
      a.sessionId !== decision.sessionId ||
      active.run.sessionId !== a.sessionId
    )
      throw new AppError(409, "审批已失效或不属于当前执行");
    if (!a.request.options.some((o) => o.optionId === decision.optionId))
      throw new AppError(409, "审批选项无效");
    a.status = "decided";
    a.optionId = decision.optionId;
    this.store.transaction(() => {
      this.store.saveApproval(a);
      const waiting = this.store
        .approvals(a.runId)
        .some((x) => x.status === "pending");
      active.task.status = active.run.status = waiting
        ? "awaiting_approval"
        : "running";
      this.store.saveRun(active.run);
      this.store.saveTask(active.task);
    });
    this.pending.delete(id);
    clearTimeout(callback.timer);
    callback.cleanup();
    callback.resolve({
      outcome: { outcome: "selected", optionId: decision.optionId },
    });
  }
  private expireOne(id: string) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.cleanup();
    const a = this.store.approval(id)!;
    a.status = "expired";
    this.store.saveApproval(a);
    if (
      this.active?.run.id === a.runId &&
      this.active.task.status === "awaiting_approval" &&
      !this.store.approvals(a.runId).some((x) => x.status === "pending")
    ) {
      this.active.task.status = this.active.run.status = "running";
      this.store.saveRun(this.active.run);
      this.store.saveTask(this.active.task);
    }
    p.resolve(cancelled());
  }
  private expire(runId: string) {
    for (const [id, p] of this.pending)
      if (p.runId === runId) this.expireOne(id);
  }
  cancel(id: string, reason = "用户取消") {
    const task = this.store.task(id);
    if (!task) throw new AppError(404, "任务不存在");
    if (!["queued", "running", "awaiting_approval"].includes(task.status))
      throw new AppError(409, "任务已结束");
    if (this.active?.task.id === id) {
      const a = this.active;
      a.task.status = a.run.status = "cancelled";
      a.run.error = reason;
      this.expire(a.run.id);
      this.store.saveRun(a.run);
      this.store.saveTask(a.task);
      a.abort.abort(new Error(reason));
    } else {
      task.status = "cancelled";
      this.store.saveTask(task);
    }
  }
  retry(id: string) {
    if (this.closed) throw new AppError(503, "服务正在停止");
    const d = this.store.detail(id);
    if (!d) throw new AppError(404, "任务不存在");
    if (
      !["failed", "cancelled", "interrupted"].includes(d.task.status) ||
      this.active?.task.id === id
    )
      throw new AppError(409, "任务尚不能重试");
    if (
      d.runs.length >= LIMITS.runsPerTask ||
      this.store.countActive() >= LIMITS.queue
    )
      throw new AppError(429, "已达到队列或重试上限");
    d.task.status = "queued";
    this.store.saveTask(d.task);
    this.kick();
    return { taskId: id };
  }
  async close() {
    this.closed = true;
    if (this.active) {
      const a = this.active;
      if (a.task.status !== "cancelled") {
        a.task.status = a.run.status = "interrupted";
        a.run.error = "服务停止，原 ACP 连接已失效";
      }
      this.expire(a.run.id);
      a.abort.abort(new Error("服务停止"));
    }
    await this.drainPromise;
  }
}
