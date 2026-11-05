import { randomUUID, randomBytes, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  RequestPermissionRequest,
  JsonRpcId,
  InitializeResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  LIMITS,
  publishTaskSchema,
  type PublishTask,
  type Decision,
  type Run,
  type Owner,
  type Claim,
  type ConnectorUpdate,
  type DeliveryEvent,
  type HarnessSubscription,
  type Approval,
  type SubscriberDecision,
  type ApprovalSubscription,
} from "../shared/protocol.js";
import { Store } from "./store.js";
import { validateAcp } from "./acp-validation.js";
import { applyProgress } from "./progress.js";
import { approvalPrompt } from "../shared/approval.js";
import { WakeupDispatcher, type WakeupDelivery } from "./task-wakeup.js";
import {
  wakeupAcknowledgementSchema,
  type WakeupAcknowledgement,
} from "../shared/task-wakeup.js";
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const now = () => new Date().toISOString();
export class TaskService {
  private subscriptions = new Map<
    string,
    { identity: HarnessSubscription; connections: number }
  >();
  registerHarness(identity: HarnessSubscription) {
    const current = this.subscriptions.get(identity.ownerId);
    if (
      current &&
      current.identity.harnessName.toLowerCase() !==
        identity.harnessName.toLowerCase()
    )
      throw new AppError(409, "ownerId 已绑定其他 harness");
    const entry = current ?? { identity, connections: 0 };
    entry.connections++;
    this.subscriptions.set(identity.ownerId, entry);
    this.events.emit("changed");
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      if (--entry.connections === 0)
        this.subscriptions.delete(identity.ownerId);
      this.events.emit("changed");
    };
  }
  harnesses(): HarnessSubscription[] {
    return [...this.subscriptions.values()].map((s) => ({ ...s.identity }));
  }
  private resumeNotBefore = 0;
  private closed = false;
  private timer: NodeJS.Timeout;
  readonly events = new EventEmitter();
  readonly wakeups?: WakeupDispatcher;
  constructor(
    public store: Store,
    private workspace: string,
    private mode: "fake" | "codex",
    wakeupDelivery?: WakeupDelivery,
  ) {
    this.resumeNotBefore = Math.max(
      store.quarantineUntil(),
      store.unfinished().length ? Date.now() + LIMITS.leaseMs : 0,
    );
    store.recover();
    if (wakeupDelivery)
      this.wakeups = new WakeupDispatcher(store, wakeupDelivery);
    this.events.setMaxListeners(
      (LIMITS.subscribers + LIMITS.browserSubscribers) * 2 + 4,
    );
    store.onChange = () => {
      this.events.emit("changed");
      this.wakeups?.kick();
    };
    this.timer = setInterval(() => this.sweep(), LIMITS.sweepMs);
    this.timer.unref();
    this.wakeups?.kick();
  }
  private available(event: DeliveryEvent) {
    this.events.emit("available", event);
  }
  publish(raw: PublishTask) {
    if (this.closed) throw new AppError(503, "服务正在停止");
    const input = publishTaskSchema.parse(raw);
    if (input.wakeup) {
      if (!(input.approvalTargets ?? ["subscriber"]).includes("subscriber"))
        throw new AppError(400, "聊天唤醒需要发起方审批订阅");
      if (!this.wakeupStatus().available)
        throw new AppError(503, "聊天唤醒宿主尚未接通；请先完成宿主接入验证。");
      if (!this.wakeups?.delivery.accepts(input.wakeup))
        throw new AppError(403, "聊天目标超出宿主预检确认的授权范围");
    }
    if (input.approvalTargets?.includes("third_party"))
      throw new AppError(400, "第三方审批正在开发中");
    if (this.store.countActive() >= LIMITS.queue)
      throw new AppError(429, "队列已满");
    const subscriptionToken = randomBytes(32).toString("hex");
    const result = this.store.transaction(() => {
      const task = this.store.publish(input);
      if (task.approvalTargets.includes("subscriber"))
        this.store.saveApprovalSubscriber(
          task.id,
          this.tokenHash(subscriptionToken),
        );
      return { task, event: this.store.deliver(task.id) };
    });
    this.available(result.event);
    return {
      taskId: result.task.id,
      ...(input.wakeup ? { wakeup: input.wakeup } : {}),
      ...(result.task.approvalTargets.includes("subscriber")
        ? {
            approvalSubscription: { taskId: result.task.id, subscriptionToken },
          }
        : {}),
    };
  }
  wakeupStatus() {
    return (
      this.wakeups?.delivery.status() ?? {
        available: false,
        transport: "unconfigured",
        error: "聊天唤醒宿主尚未配置",
      }
    );
  }
  taskWakeups(subscription: ApprovalSubscription) {
    this.requireSubscriber(subscription);
    return {
      target: this.store.wakeupTarget(subscription.taskId) ?? null,
      events: this.store.taskWakeups(subscription.taskId),
    };
  }
  acknowledgeWakeup(
    subscription: ApprovalSubscription,
    raw: WakeupAcknowledgement,
  ) {
    this.requireSubscriber(subscription);
    const input = wakeupAcknowledgementSchema.parse(raw);
    const event = this.store
      .taskWakeups(subscription.taskId)
      .find((item) => item.id === input.eventId);
    if (
      !event ||
      event.target.threadId !== input.threadId ||
      event.target.originTurnId === input.turnId
    )
      throw new AppError(409, "唤醒确认需要目标聊天的独立新回合");
    if (event.status === "acknowledged" && event.resumedTurnId === input.turnId)
      return { ok: true };
    if (event.status !== "delivered")
      throw new AppError(409, "请先核对宿主投递状态与已确认回合");
    if (
      this.store
        .taskWakeups(subscription.taskId)
        .some((item) => item.resumedTurnId === input.turnId)
    )
      throw new AppError(409, "审批与完成需要分别恢复独立回合");
    this.store.saveWakeup({
      ...event,
      status: "acknowledged",
      resumedTurnId: input.turnId,
      acknowledgedAt: now(),
    });
    return { ok: true };
  }
  private tokenHash(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }
  private requireSubscriber(subscription: ApprovalSubscription) {
    if (
      !this.store.approvalSubscriber(
        subscription.taskId,
        this.tokenHash(subscription.subscriptionToken),
      )
    )
      throw new AppError(403, "审批订阅凭据无效");
    const task = this.store.task(subscription.taskId);
    if (!task?.approvalTargets.includes("subscriber"))
      throw new AppError(403, "任务未选择订阅者审批");
    return task;
  }
  approvalSnapshot(subscription: ApprovalSubscription) {
    const task = this.requireSubscriber(subscription);
    return {
      type: "approval.snapshot" as const,
      taskId: task.id,
      taskStatus: task.status,
      approvals: task.currentRunId
        ? this.store
            .approvals(task.currentRunId)
            .filter((approval) => approval.status === "pending")
        : [],
    };
  }
  private approvalWaiters = 0;
  async waitForApproval(
    subscription: ApprovalSubscription,
    waitMs: number,
    signal?: AbortSignal,
  ) {
    this.requireSubscriber(subscription);
    if (this.closed) throw new AppError(503, "服务正在停止");
    if (this.approvalWaiters >= LIMITS.subscribers)
      throw new AppError(429, "审批等待数量超限");
    this.approvalWaiters++;
    let timer: NodeJS.Timeout | undefined;
    let changed: () => void = () => {};
    let stop: () => void = () => {};
    try {
      await new Promise<void>((resolve, reject) => {
        stop = () => reject(new AppError(503, "审批等待已结束"));
        changed = () => {
          const snapshot = this.approvalSnapshot(subscription);
          if (
            snapshot.approvals.some(
              (a) =>
                !a.reviewerDecisions.some((d) => d.target === "subscriber"),
            ) ||
            !["queued", "running", "awaiting_approval"].includes(
              snapshot.taskStatus,
            )
          )
            resolve();
        };
        this.events.on("changed", changed);
        this.events.once("close", stop);
        signal?.addEventListener("abort", stop, { once: true });
        timer = setTimeout(resolve, waitMs);
        if (signal?.aborted) stop();
        else changed();
      });
      return this.approvalSnapshot(subscription);
    } finally {
      this.approvalWaiters--;
      clearTimeout(timer);
      this.events.off("changed", changed);
      this.events.off("close", stop);
      signal?.removeEventListener("abort", stop);
    }
  }
  claim(taskId: string, owner: Owner): Claim {
    if (this.closed) throw new AppError(503, "服务正在停止");
    if (Date.now() < this.resumeNotBefore)
      throw new AppError(409, "重启后等待旧连接器停止");
    this.sweep();
    return this.store.transaction(() => {
      const t = this.store.task(taskId);
      if (!t) throw new AppError(404, "任务不存在");
      const identity = this.subscriptions.get(owner.ownerId)?.identity;
      if (
        t.targetHarness &&
        identity?.harnessName.toLowerCase() !== t.targetHarness.toLowerCase()
      )
        throw new AppError(403, "请以目标 harness 身份保持在线订阅后领取");
      if (t.currentRunId) {
        const old = this.store.run(t.currentRunId)!;
        const lease = this.store.lease(old.id);
        if (
          !old.endedAt &&
          lease?.ownerId === owner.ownerId &&
          lease.claimId === owner.claimId
        )
          return {
            task: t,
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
        task: t,
        run,
        ...owner,
        leaseMs: LIMITS.leaseMs,
        workspace: this.workspace,
        mode: this.mode,
      };
    });
  }
  private owned(runId: string, owner: Owner) {
    const r = this.store.run(runId),
      lease = this.store.lease(runId);
    if (
      this.closed ||
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
  heartbeat(runId: string, owner: Owner) {
    this.sweep();
    const { run, lease } = this.owned(runId, owner);
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
  report(runId: string, owner: Owner, seq: number, update: ConnectorUpdate) {
    const previous = this.store.lease(runId);
    if (
      !this.closed &&
      previous?.ownerId === owner.ownerId &&
      previous.claimId === owner.claimId &&
      seq <= previous.seq
    )
      return { duplicate: true };
    const { run: r, lease } = this.owned(runId, owner);
    if (seq <= lease.seq) return { duplicate: true };
    if (seq !== lease.seq + 1) throw new AppError(409, "状态回传序号有缺口");
    const t = this.store.task(r.taskId)!;
    this.store.transaction(() => {
      if (update.type === "session") {
        if (r.sessionId && r.sessionId !== update.sessionId)
          throw new AppError(409, "不能切换运行会话");
        r.sessionId = update.sessionId;
      } else if (update.type === "discovery") {
        if (!validateAcp("InitializeResponse", update.discovery))
          throw new AppError(400, "ACP 初始化结构无效");
        r.discovery = update.discovery;
      } else if (update.type === "notification") {
        if (
          !validateAcp("SessionNotification", update.notification) ||
          update.notification.sessionId !== r.sessionId
        )
          throw new AppError(400, "ACP 通知无效或会话不匹配");
        if (r.status !== "cancelled") {
          this.store.appendEvent(runId, update.notification);
          applyProgress(r, update.notification);
        }
      } else if (update.type === "finished") {
        if (update.status === "succeeded" && update.stopReason !== "end_turn")
          throw new AppError(400, "完成状态必须来自 ACP end_turn");
        if (r.status !== "cancelled") {
          r.status = update.status;
          r.error = update.error ?? r.error;
        }
        r.stopReason = update.stopReason;
        r.endedAt = now();
        t.status = r.status;
        this.expire(runId);
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
  permission(
    runId: string,
    owner: Owner,
    requestId: JsonRpcId,
    request: RequestPermissionRequest,
  ) {
    const { run: r } = this.owned(runId, owner);
    if (r.status === "cancelled") throw new AppError(410, "运行已取消");
    if (
      !validateAcp("RequestPermissionRequest", request) ||
      request.sessionId !== r.sessionId
    )
      throw new AppError(400, "ACP 审批结构无效或会话不匹配");
    const previous = this.store.approvals(runId);
    const existing = previous.find((a) => a.requestId === requestId);
    if (existing) {
      if (JSON.stringify(existing.request) !== JSON.stringify(request))
        throw new AppError(409, "重复审批 ID 的内容不同");
      return { approvalId: existing.id };
    }
    if (
      previous.length >= LIMITS.approvalsPerRun ||
      previous.filter((a) => a.status === "pending").length >=
        LIMITS.pendingApprovals
    ) {
      this.cancel(r.taskId, "审批请求数量超限");
      throw new AppError(410, "审批请求数量超限");
    }
    const a: Approval = {
      id: randomUUID(),
      taskId: r.taskId,
      runId,
      sessionId: request.sessionId,
      requestId,
      request,
      prompt: approvalPrompt(
        request,
        r.tools.find((tool) => tool.id === request.toolCall.toolCallId),
      ),
      status: "pending" as const,
      optionId: null,
      createdAt: now(),
      reviewerDecisions: [],
      userDecision: null,
      fallbackAt: null,
      resolvedBy: null,
    };
    r.status = "awaiting_approval";
    const t = this.store.task(r.taskId)!;
    t.status = "awaiting_approval";
    this.store.transaction(() => {
      this.store.saveApproval(a);
      this.store.saveRun(r);
      this.store.saveTask(t);
    });
    return { approvalId: a.id };
  }
  permissionResult(runId: string, owner: Owner, approvalId: string) {
    this.sweep();
    this.owned(runId, owner);
    const a = this.store.approval(approvalId);
    if (!a || a.runId !== runId) throw new AppError(404, "审批不存在");
    return a.status === "pending"
      ? { status: "pending" as const }
      : a.status === "decided"
        ? {
            status: "resolved" as const,
            response: {
              outcome: { outcome: "selected" as const, optionId: a.optionId! },
            },
          }
        : {
            status: "resolved" as const,
            response: { outcome: { outcome: "cancelled" as const } },
          };
  }
  private pendingApproval(id: string, decision: Decision) {
    const a = this.store.approval(id);
    const r = a ? this.store.run(a.runId) : undefined;
    const lease = r ? this.store.lease(r.id) : undefined;
    if (
      !a ||
      a.status !== "pending" ||
      !r ||
      r.endedAt ||
      r.status === "cancelled" ||
      !lease ||
      lease.deadline <= Date.now() ||
      a.runId !== decision.runId ||
      a.sessionId !== decision.sessionId ||
      r.sessionId !== a.sessionId ||
      this.store.task(a.taskId)?.currentRunId !== r.id
    )
      throw new AppError(409, "审批已失效或不属于当前执行");
    if (!a.request.options.some((o) => o.optionId === decision.optionId))
      throw new AppError(409, "审批选项无效");
    return { approval: a, run: r };
  }
  decide(id: string, decision: Decision) {
    this.sweep();
    const { approval } = this.pendingApproval(id, decision);
    approval.userDecision = { optionId: decision.optionId, decidedAt: now() };
    this.resolveApproval(approval, decision.optionId, "user");
  }
  decideSubscriber(decision: SubscriberDecision) {
    this.requireSubscriber(decision);
    this.sweep();
    const { approval } = this.pendingApproval(decision.approvalId, decision);
    if (approval.taskId !== decision.taskId)
      throw new AppError(409, "审批不属于订阅任务");
    const existing = approval.reviewerDecisions.find(
      (d) => d.target === "subscriber",
    );
    if (existing) {
      if (existing.optionId !== decision.optionId)
        throw new AppError(409, "订阅者已提交审批意见");
      return;
    }
    const decidedAt = Date.now();
    approval.reviewerDecisions.push({
      target: "subscriber",
      optionId: decision.optionId,
      decidedAt: new Date(decidedAt).toISOString(),
    });
    approval.fallbackAt = new Date(
      decidedAt + LIMITS.approvalGraceMs,
    ).toISOString();
    this.store.saveApproval(approval);
  }
  private resolveApproval(
    a: Approval,
    optionId: string,
    source: NonNullable<Approval["resolvedBy"]>,
  ) {
    const r = this.store.run(a.runId);
    if (!r) throw new AppError(409, "审批执行已结束");
    a.status = "decided";
    a.optionId = optionId;
    a.resolvedBy = source;
    this.store.transaction(() => {
      this.store.saveApproval(a);
      r.status = this.store.approvals(r.id).some((x) => x.status === "pending")
        ? "awaiting_approval"
        : "running";
      const t = this.store.task(r.taskId)!;
      t.status = r.status;
      this.store.saveRun(r);
      this.store.saveTask(t);
    });
  }
  private expire(runId: string) {
    for (const a of this.store.approvals(runId))
      if (a.status === "pending") {
        a.status = "expired";
        this.store.saveApproval(a);
      }
  }
  cancel(id: string, reason = "用户取消") {
    const t = this.store.task(id);
    if (!t) throw new AppError(404, "任务不存在");
    if (!["queued", "running", "awaiting_approval"].includes(t.status))
      throw new AppError(409, "任务已结束");
    this.store.transaction(() => {
      t.status = "cancelled";
      this.store.saveTask(t);
      const r = t.currentRunId ? this.store.run(t.currentRunId) : undefined;
      if (r && !r.endedAt) {
        r.status = "cancelled";
        r.error = reason;
        this.expire(r.id);
        this.store.saveRun(r);
      }
    });
  }
  retry(id: string) {
    if (this.closed) throw new AppError(503, "服务正在停止");
    const d = this.store.detail(id);
    if (!d) throw new AppError(404, "任务不存在");
    if (
      !["failed", "cancelled", "interrupted"].includes(d.task.status) ||
      d.runs.some((r) => !r.endedAt)
    )
      throw new AppError(409, "原执行尚未释放；请稍后重试");
    if (
      d.runs.length >= LIMITS.runsPerTask ||
      this.store.countActive() >= LIMITS.queue
    )
      throw new AppError(429, "已达到队列或重试上限");
    const event = this.store.transaction(() => {
      d.task.status = "queued";
      this.store.saveTask(d.task);
      return this.store.deliver(id);
    });
    this.available(event);
    return { taskId: id };
  }
  sweep(time = Date.now()) {
    if (this.closed) return;
    for (const r of this.store.unfinished()) {
      const lease = this.store.lease(r.id);
      let reason: string | undefined;
      if (!lease || lease.deadline <= time)
        reason = "订阅连接器失联，原领取已失效；请显式重试";
      else if (time - Date.parse(r.createdAt) >= LIMITS.runMs) {
        if (r.status !== "cancelled") this.cancel(r.taskId, "执行超时");
        continue;
      } else if (
        this.store
          .approvals(r.id)
          .some(
            (a) =>
              a.status === "pending" &&
              a.fallbackAt === null &&
              time - Date.parse(a.createdAt) >= LIMITS.approvalMs,
          )
      ) {
        if (r.status !== "cancelled") this.cancel(r.taskId, "审批超时");
        continue;
      }
      if (reason)
        this.store.transaction(() => {
          if (r.status !== "cancelled") r.status = "interrupted";
          r.error = reason;
          r.endedAt = now();
          this.expire(r.id);
          const t = this.store.task(r.taskId)!;
          t.status = r.status;
          this.store.saveRun(r);
          this.store.saveTask(t);
        });
      else
        for (const approval of this.store.approvals(r.id)) {
          if (
            approval.status !== "pending" ||
            !approval.fallbackAt ||
            Date.parse(approval.fallbackAt) > time
          )
            continue;
          const reviewer = approval.reviewerDecisions.find(
            (decision) => decision.target === "subscriber",
          );
          if (reviewer)
            this.resolveApproval(approval, reviewer.optionId, reviewer.target);
        }
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.events.emit("close");
    await this.wakeups?.close();
    this.store.transaction(() => {
      const unfinished = this.store.unfinished();
      if (unfinished.length)
        this.store.setQuarantine(Date.now() + LIMITS.leaseMs);
      for (const r of unfinished) {
        if (r.status !== "cancelled") r.status = "interrupted";
        r.error = r.error ?? "服务停止，原领取已失效";
        r.endedAt = now();
        this.expire(r.id);
        this.store.saveRun(r);
        const t = this.store.task(r.taskId)!;
        t.status = r.status;
        this.store.saveTask(t);
      }
    });
  }
}
