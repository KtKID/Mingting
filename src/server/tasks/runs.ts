import { randomUUID } from "node:crypto";
import {
  LIMITS,
  isAuditedHarness,
  type Claim,
  type ConnectorUpdate,
  type DeliveryEvent,
  type Owner,
  type Run,
  type TaskMessageScope,
} from "../../shared/protocol.js";
import { validateAcp } from "../harness/acp/acp-validation.js";
import type { Store } from "../storage/store.js";
import { AppError } from "./app-error.js";
import { expireRunApprovals } from "./approvals.js";
import type { HarnessRegistry } from "./harness-registry.js";
import { applyProgress } from "./progress.js";

const now = () => new Date().toISOString();

export class TaskRuns {
  constructor(
    private store: Store,
    private workspace: string,
    private mode: "fake" | "codex",
    private registry: HarnessRegistry,
    private isClosed: () => boolean,
    private available: (event: DeliveryEvent) => void,
  ) {}

  /** 校验认领身份和投递归属，取得通信应关联的任务轮次。 */
  claimMessageScope(
    taskId: string,
    owner: Owner,
    generation?: string,
    deliveryId?: number,
  ): TaskMessageScope | undefined {
    const task = this.store.task(taskId);
    if (!task) return;
    this.registry.claimIdentity(task, owner.ownerId, generation);
    if (deliveryId === undefined) return this.store.taskMessageScope(taskId);
    const delivery = this.store.deliveryTurn(deliveryId);
    return delivery?.taskId === taskId && delivery.taskTurn !== undefined
      ? { taskId, taskTurn: delivery.taskTurn }
      : undefined;
  }
  /** 只有认领租约与请求者匹配时才提供运行的通信归属。 */
  runMessageScope(runId: string, owner: Owner) {
    const lease = this.store.lease(runId);
    return lease?.ownerId === owner.ownerId && lease.claimId === owner.claimId
      ? this.store.runMessageScope(runId)
      : undefined;
  }
  /** 认领当前轮的排队任务，允许相同认领请求幂等重放。 */
  claim(
    taskId: string,
    owner: Owner,
    generation?: string,
    deliveryId?: number,
  ): Claim {
    return this.store.transaction(() => {
      // 在事务内核对轮次投递、复用既有认领或创建运行和租约。
      const t = this.store.task(taskId);
      if (!t) throw new AppError(404, "任务不存在");
      const turn = this.store.turn(taskId);
      if (deliveryId !== undefined) {
        const delivery = this.store.deliveryTurn(deliveryId);
        if (
          !delivery ||
          delivery.taskId !== taskId ||
          delivery.taskTurn !== turn?.taskTurn
        )
          throw new AppError(410, "领取事件已过期");
      } else if (turn && turn.taskTurn > 1)
        throw new AppError(410, "追加轮需要对应领取事件");
      const identity = this.registry.claimIdentity(
        t,
        owner.ownerId,
        generation,
      );
      if (t.currentRunId) {
        const old = this.store.run(t.currentRunId)!;
        const lease = this.store.lease(old.id);
        if (
          !old.endedAt &&
          lease?.ownerId === owner.ownerId &&
          lease.claimId === owner.claimId
        )
          return {
            task: turn ? { ...t, description: turn.description } : t,
            run: old,
            ...owner,
            leaseMs: LIMITS.leaseMs,
            workspace: this.workspace,
            mode: this.mode,
          };
      }
      if (t.status !== "queued") throw new AppError(410, "任务已领取或已结束");
      if (this.store.unfinished().length)
        throw new AppError(409, "执行器忙；任务仍保留在队列");
      const run: Run = {
        id: randomUUID(),
        taskId,
        ...(turn ? { taskTurn: turn.taskTurn } : {}),
        status: "running",
        sessionId: null,
        createdAt: now(),
        endedAt: null,
        output: "",
        reasoning: "",
        tools: [],
        error: null,
        stopReason: null,
        discovery: null,
        ownerId: owner.ownerId,
        harnessName: identity?.harnessName ?? null,
      };
      t.status = "running";
      t.currentRunId = run.id;
      this.store.saveRun(run);
      this.store.saveTask(t);
      this.store.saveLease(
        run.id,
        owner.ownerId,
        owner.claimId,
        Date.now() + LIMITS.leaseMs,
      );
      return {
        task: turn ? { ...t, description: turn.description } : t,
        run,
        ...owner,
        leaseMs: LIMITS.leaseMs,
        workspace: this.workspace,
        mode: this.mode,
      };
    });
  }
  /** 读取仍有效且属于当前连接器认领的运行及租约。 */
  requireOwnedRun(runId: string, owner: Owner) {
    const r = this.store.run(runId),
      lease = this.store.lease(runId);
    if (
      this.isClosed() ||
      !r ||
      r.endedAt ||
      !lease ||
      lease.deadline <= Date.now() ||
      lease.ownerId !== owner.ownerId ||
      lease.claimId !== owner.claimId ||
      this.store.task(r.taskId)?.currentRunId !== runId
    )
      throw new AppError(410, "领取已失效，请停止原执行");
    return { run: r, lease };
  }
  /** 为有效认领续租，并返回任务运行状态供连接器识别取消。 */
  heartbeat(runId: string, owner: Owner) {
    const { run, lease } = this.requireOwnedRun(runId, owner);
    this.store.saveLease(
      runId,
      lease.ownerId,
      lease.claimId,
      Date.now() + LIMITS.leaseMs,
      lease.seq,
    );
    return {
      status: run.status,
      cancelRequested: run.status === "cancelled",
      leaseMs: LIMITS.leaseMs,
      workspace: this.workspace,
      mode: this.mode,
    };
  }
  /** 按连续序号接收执行器回报，对已处理的上报返回幂等响应。 */
  report(runId: string, owner: Owner, seq: number, update: ConnectorUpdate) {
    const previous = this.store.lease(runId);
    if (
      !this.isClosed() &&
      previous?.ownerId === owner.ownerId &&
      previous.claimId === owner.claimId &&
      seq <= previous.seq
    )
      return { duplicate: true };
    const { run: r, lease } = this.requireOwnedRun(runId, owner);
    if (seq <= lease.seq) return { duplicate: true };
    if (seq !== lease.seq + 1) throw new AppError(409, "状态回传序号有缺口");
    const t = this.store.task(r.taskId)!;
    this.store.transaction(() => {
      // 校验并落盘进度、设置、上下文或结束结果，同步推进租约序号。
      if (update.type === "session") {
        if (r.sessionId && r.sessionId !== update.sessionId)
          throw new AppError(409, "不能切换运行会话");
        r.sessionId = update.sessionId;
      } else if (update.type === "settings") {
        const requested = t.requestedSettings;
        const { receipt } = update;
        if (
          !isAuditedHarness(r.harnessName) ||
          r.status === "cancelled" ||
          r.sessionId !== update.sessionId ||
          r.settingsReceipt ||
          (receipt.status !== "rejected" && !r.sessionId) ||
          (receipt.status === "default" && requested) ||
          (receipt.status === "rejected" && (!requested || !receipt.reason)) ||
          (receipt.status === "applied" &&
            (!requested ||
              (requested.modelId && requested.modelId !== receipt.modelId) ||
              (requested.reasoningEffort &&
                requested.reasoningEffort !== receipt.reasoningEffort)))
        )
          throw new AppError(409, "设置回执与当前运行不匹配");
        r.settingsReceipt = receipt;
      } else if (update.type === "discovery") {
        if (!validateAcp("InitializeResponse", update.discovery))
          throw new AppError(400, "ACP 初始化结构无效");
        r.discovery = update.discovery;
      } else if (update.type === "context") {
        if (
          !isAuditedHarness(r.harnessName) ||
          update.sessionId !== r.sessionId ||
          !r.settingsReceipt ||
          r.settingsReceipt.status === "rejected"
        )
          throw new AppError(400, "上下文观测不属于当前执行会话");
        if (r.status !== "cancelled")
          this.store.appendRunAudit({
            kind: "context",
            runId,
            seq,
            sessionId: update.sessionId,
            createdAt: now(),
            observation: update.observation,
          });
      } else if (update.type === "notification") {
        if (
          !validateAcp("SessionNotification", update.notification) ||
          update.notification.sessionId !== r.sessionId
        )
          throw new AppError(400, "ACP 通知无效或会话不匹配");
        if (r.status !== "cancelled") {
          this.store.appendEvent(runId, update.notification);
          const tool = applyProgress(r, update.notification);
          if (tool && isAuditedHarness(r.harnessName))
            this.store.appendRunAudit({
              kind: "tool",
              runId,
              seq,
              sessionId: update.notification.sessionId,
              createdAt: now(),
              ...tool,
            });
        }
      } else if (update.type === "finished") {
        if (update.status === "succeeded" && update.stopReason !== "end_turn")
          throw new AppError(400, "完成状态必须来自 ACP end_turn");
        if (
          update.status === "succeeded" &&
          t.requestedSettings &&
          r.settingsReceipt?.status !== "applied"
        )
          throw new AppError(409, "显式设置任务缺少生效回执");
        if (update.usage) {
          if (
            !isAuditedHarness(r.harnessName) ||
            update.usage.source.sessionId !== r.sessionId ||
            !r.settingsReceipt ||
            r.settingsReceipt.status === "rejected"
          )
            throw new AppError(400, "用量不属于当前执行回合");
          r.usage = update.usage;
        }
        if (r.status !== "cancelled") {
          r.status = update.status;
          r.error = update.error ?? r.error;
        }
        r.stopReason = update.stopReason;
        r.endedAt = now();
        t.status = r.status;
        expireRunApprovals(this.store, runId);
      }
      this.store.saveRun(r);
      this.store.saveTask(t);
      this.store.saveLease(
        runId,
        lease.ownerId,
        lease.claimId,
        Date.now() + LIMITS.leaseMs,
        seq,
      );
    });
    return { duplicate: false };
  }

  /** 取消可处理状态的任务，并使当前运行的待处理审批过期。 */
  cancel(id: string, reason = "用户取消") {
    const t = this.store.task(id);
    if (!t) throw new AppError(404, "任务不存在");
    if (!["queued", "running", "awaiting_approval"].includes(t.status))
      throw new AppError(409, "任务已结束");
    this.store.transaction(() => {
      // 原子标记任务和当前运行为取消，保留执行器后续收尾。
      t.status = "cancelled";
      this.store.saveTask(t);
      const r = t.currentRunId ? this.store.run(t.currentRunId) : undefined;
      if (r && !r.endedAt) {
        r.status = "cancelled";
        r.error = reason;
        expireRunApprovals(this.store, r.id);
        this.store.saveRun(r);
      }
    });
  }
  /** 在原执行释放并满足上限后，将当前任务轮次重新排队。 */
  retry(id: string) {
    if (this.isClosed()) throw new AppError(503, "服务正在停止");
    const d = this.store.detail(id);
    if (!d) throw new AppError(404, "任务不存在");
    if (
      !["failed", "cancelled", "interrupted"].includes(d.task.status) ||
      d.runs.some(/* 检查是否仍有尚未收尾的旧运行。 */ (r) => !r.endedAt)
    )
      throw new AppError(409, "原执行尚未释放；请稍后重试");
    if (
      d.runs.filter(
        /* 只统计当前任务轮次的运行次数。 */ (run) =>
          run.taskTurn === d.turns?.at(-1)?.taskTurn,
      ).length >= LIMITS.runsPerTask ||
      this.store.countActive() >= LIMITS.queue
    )
      throw new AppError(429, "已达到队列或重试上限");
    const event = this.store.transaction(() => {
      // 原子更新排队状态并创建新的投递事件。
      d.task.status = "queued";
      this.store.saveTask(d.task);
      return this.store.deliver(id);
    });
    this.available(event);
    return { taskId: id };
  }

  /** 结算失联运行和过期审批，并同步任务状态。 */
  interrupt(run: Run, reason: string) {
    this.store.transaction(() => this.finishInterruptedRun(run, reason));
  }

  /** 原子中断未完成的运行与审批，并记录旧认领的隔离截止时间。 */
  shutdown() {
    this.store.transaction(() => {
      const unfinished = this.store.unfinished();
      if (unfinished.length)
        this.store.setQuarantine(Date.now() + LIMITS.leaseMs);
      for (const run of unfinished) {
        this.finishInterruptedRun(run, run.error ?? "服务停止，原领取已失效");
      }
    });
  }

  private finishInterruptedRun(run: Run, reason: string) {
    if (run.status !== "cancelled") run.status = "interrupted";
    run.error = reason;
    run.endedAt = now();
    expireRunApprovals(this.store, run.id);
    const task = this.store.task(run.taskId)!;
    task.status = run.status;
    this.store.saveRun(run);
    this.store.saveTask(task);
  }
}
