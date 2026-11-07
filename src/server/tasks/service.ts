import { randomUUID, randomBytes, createHash } from "node:crypto";
import type { z } from "zod";
import { EventEmitter } from "node:events";
import type {
  RequestPermissionRequest,
  JsonRpcId,
  InitializeResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  LIMITS,
  isAuditedHarness,
  publishTaskSchema,
  taskCommandSchema,
  type PublishTask,
  type Task,
  type TaskMessageScope,
  type Decision,
  type Run,
  type Owner,
  type Claim,
  type ConnectorUpdate,
  type DeliveryEvent,
  type HarnessSubscription,
  type HarnessIdentity,
  type CapabilityReport,
  type CapabilitySnapshot,
  type Approval,
  type SubscriberDecision,
  type ApprovalSubscription,
} from "../../shared/protocol.js";
import { Store } from "../storage/store.js";
import { validateAcp } from "../harness/acp/acp-validation.js";
import { applyProgress } from "./progress.js";
import { approvalPrompt } from "../../shared/approval.js";
import {
  appendTaskSchema,
  taskResultEventSchema,
  type DshAck,
  type DshPublish,
  type DshPublisherContext,
} from "../../shared/dsh-wakeup.js";
import {
  WakeupDispatcher,
  type WakeupDelivery,
} from "../wakeup/task-wakeup.js";
import {
  wakeupAcknowledgementSchema,
  type WakeupAcknowledgement,
  type DshWakeupTarget,
} from "../../shared/task-wakeup.js";
export class AppError extends Error {
  /** 创建携带 HTTP 状态码的业务错误，供传输层统一返回。 */
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
/** 生成任务状态与事件使用的 UTC 时间戳。 */
const now = () => new Date().toISOString();
type HostPublisher = {
  hostId: string;
  source: DshPublisherContext;
  connected: boolean;
  subscriptionToken: string;
};
export class TaskService {
  private subscriptions = new Map<
    string,
    {
      identity: HarnessIdentity;
      connections: number;
      generation?: string;
      capabilities?: CapabilitySnapshot;
    }
  >();
  /** 登记执行器连接，校验身份绑定并更新当前连接代次。 */
  registerHarness(identity: HarnessIdentity, generation?: string) {
    const current = this.subscriptions.get(identity.ownerId);
    if (
      current &&
      current.identity.harnessName.toLowerCase() !==
        identity.harnessName.toLowerCase()
    )
      throw new AppError(409, "ownerId 已绑定其他 harness");
    const entry = current ?? { identity, connections: 0 };
    entry.connections++;
    if (generation) {
      entry.generation = generation;
      entry.capabilities = undefined;
    }
    this.subscriptions.set(identity.ownerId, entry);
    this.events.emit("changed");
    let closed = false;
    return () => {
      // 幂等注销当前连接，只清理属于该代次的能力快照。
      if (closed) return;
      closed = true;
      if (--entry.connections === 0)
        this.subscriptions.delete(identity.ownerId);
      if (generation && entry.generation === generation) {
        entry.generation = undefined;
        entry.capabilities = undefined;
      }
      this.events.emit("changed");
    };
  }
  /** 只接收当前受审计连接代次的能力上报，并通知订阅者。 */
  reportCapabilities(report: CapabilityReport) {
    const entry = this.subscriptions.get(report.ownerId);
    if (
      !entry ||
      !isAuditedHarness(entry.identity.harnessName) ||
      entry.generation !== report.generation
    )
      throw new AppError(409, "能力快照不属于当前执行器连接");
    entry.capabilities = report.capabilities;
    this.events.emit("changed");
  }
  /** 列出在线执行器及已收到的能力快照。 */
  harnesses(): HarnessSubscription[] {
    return [...this.subscriptions.values()].map(
      /* 展开连接身份，存在能力快照时附到结果。 */ (s) => ({
        ...s.identity,
        ...(s.capabilities ? { capabilities: s.capabilities } : {}),
      }),
    );
  }
  private resumeNotBefore = 0;
  private closed = false;
  private timer: NodeJS.Timeout;
  readonly events = new EventEmitter();
  readonly wakeups?: WakeupDispatcher;
  /** 恢复数据库状态，设置重启隔离期，并挂接唤醒调度与超时清理。 */
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
      // 存储变更后通知订阅者，并触发待处理唤醒。
      this.events.emit("changed");
      this.wakeups?.kick();
    };
    this.timer = setInterval(
      /* 定时检查认领租约、运行和审批时限。 */ () => this.sweep(),
      LIMITS.sweepMs,
    );
    this.timer.unref();
    this.wakeups?.kick();
  }
  /** 向在线连接器广播任务可认领事件。 */
  private available(event: DeliveryEvent) {
    this.events.emit("available", event);
  }
  /** 处理旧版 DSH 发单，按宿主请求 ID 去重，并广播新任务。 */
  publishFromDsh(hostId: string, input: DshPublish, connected: boolean) {
    const { publishRequestId, sessionId, originTurn, ...taskInput } = input;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const result = this.store.transaction(() => {
      // 在事务内复用相同发单请求，或原子写入新任务、原会话绑定和投递。
      const existing = this.store.dshPublication(hostId, publishRequestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new AppError(409, "原发布请求的内容已变化");
        if (existing.taskTurn !== undefined)
          this.store.communication(
            existing.taskId,
            existing.taskTurn,
            "publisher",
            "mingting",
            "new",
            taskInput,
          );
        return {
          taskId: existing.taskId,
          taskTurn: existing.taskTurn,
          event: undefined,
        };
      }
      if (this.closed || !connected)
        throw new AppError(503, "DSH 宿主尚未连接完成事件流");
      if (this.store.countActive() >= LIMITS.queue)
        throw new AppError(429, "队列已满");
      const task = this.store.publish(
        publishTaskSchema.parse({ ...taskInput, approvalTargets: [] }),
        { hostId, sessionId, originTurn },
      );
      this.store.recordDshPublication(
        hostId,
        publishRequestId,
        fingerprint,
        task.id,
      );
      return {
        taskId: task.id,
        taskTurn: 1,
        event: this.store.deliver(task.id),
      };
    });
    if (result.event) this.available(result.event);
    return {
      taskId: result.taskId,
      taskTurn: result.taskTurn,
      created: result.event !== undefined,
    };
  }
  /** 接收 DSH 宿主对完成唤醒的处理结果。 */
  acknowledgeDshWakeup(hostId: string, ack: DshAck) {
    this.store.transaction(() => {
      // 校验事件归属并幂等保存确认，拒绝覆盖已有的不同结果。
      const event = this.store.dshWakeup(ack.eventId, hostId);
      if (!event || event.target.sessionId !== ack.sessionId)
        throw new AppError(404, "当前宿主和会话没有这条完成事件");
      const status = ack.outcome === "accepted" ? "delivered" : "failed";
      if (event.status === status) return;
      if (event.status !== "pending")
        throw new AppError(409, "该事件已有其他投递结果");
      this.store.saveDshWakeup({
        ...event,
        status,
        attempts: event.attempts + 1,
        deliveredAt: status === "delivered" ? now() : null,
        receipt:
          ack.outcome === "accepted"
            ? { source: "dsh-web", sessionId: ack.sessionId, accepted: true }
            : null,
        error: ack.outcome === "rejected" ? ack.reason : null,
      });
    });
    return { ok: true };
  }
  /** 核对追加者是否与任务首轮的宿主和原发布会话匹配。 */
  isOriginalPublisher(taskId: string, publisher: HostPublisher) {
    const source = this.store.turn(taskId, 1)?.source;
    return (
      source?.hostId === publisher.hostId &&
      source.publisherSessionId === publisher.source.sessionId
    );
  }
  /** 允许原发布会话在执行释放后追加一轮，并保留独立唤醒绑定。 */
  private append(
    command: z.infer<typeof appendTaskSchema>,
    publisher?: HostPublisher,
  ) {
    if (!publisher) throw new AppError(403, "追加需要已认证的原发布会话");
    const source = publisher.source;
    const target = {
      hostId: publisher.hostId,
      sessionId: source.targetSessionId ?? source.sessionId,
      publisherSessionId: source.sessionId,
      originTurn: source.originTurn,
    };
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([command, target]))
      .digest("hex");
    const requestId = `mcp:${source.publishRequestId}`;
    const result = this.store.transaction(() => {
      // 原子校验发布者和幂等记录，创建新一轮并重新排队。
      const task = this.store.task(command.taskId);
      if (!task) throw new AppError(404, "任务不存在");
      const latest = this.store.turn(task.id);
      if (!latest) throw new AppError(409, "历史任务不支持追加");
      if (!this.isOriginalPublisher(task.id, publisher))
        throw new AppError(403, "只有原发布会话可以追加");
      const existing = this.store.dshPublication(publisher.hostId, requestId);
      if (existing) {
        if (
          existing.taskId !== task.id ||
          existing.taskTurn === undefined ||
          existing.fingerprint !== fingerprint
        )
          throw new AppError(409, "原发布请求的内容已变化");
        this.store.communication(
          task.id,
          existing.taskTurn,
          "publisher",
          "mingting",
          "append",
          command,
        );
        return {
          taskId: task.id,
          taskTurn: existing.taskTurn,
          event: undefined,
        };
      }
      if (!publisher.connected)
        throw new AppError(503, "KMH 宿主尚未连接完成事件流");
      if (
        ["queued", "running", "awaiting_approval"].includes(task.status) ||
        this.store
          .unfinished()
          .some(
            /* 检查该任务是否仍有尚未结束的运行。 */ (run) =>
              run.taskId === task.id,
          )
      )
        throw new AppError(409, "原执行尚未释放；请稍后追加");
      if (this.store.countActive() >= LIMITS.queue)
        throw new AppError(429, "队列已满");
      const taskTurn = latest.taskTurn + 1;
      this.store.saveTurn({
        taskId: task.id,
        taskTurn,
        description: command.description,
        status: "queued",
        createdAt: now(),
        source: {
          hostId: target.hostId,
          publisherSessionId: source.sessionId,
          originTurn: source.originTurn,
        },
        wakeupTarget: target,
      });
      task.status = "queued";
      task.currentRunId = null;
      this.store.saveTask(task);
      this.store.communication(
        task.id,
        taskTurn,
        "publisher",
        "mingting",
        "append",
        command,
      );
      this.store.recordDshPublication(
        publisher.hostId,
        requestId,
        fingerprint,
        task.id,
        taskTurn,
      );
      return { taskId: task.id, taskTurn, event: this.store.deliver(task.id) };
    });
    if (result.event) this.available(result.event);
    return { taskId: result.taskId, taskTurn: result.taskTurn };
  }
  /** 校验统一发单命令，并按动作创建任务或追加一轮。 */
  publishCommand(raw: unknown, publisher?: HostPublisher) {
    if (this.closed) throw new AppError(503, "服务正在停止");
    const command = taskCommandSchema.parse(raw);
    if (command.action === "append") return this.append(command, publisher);
    const { action: _action, ...fields } = command;
    return this.publish(fields, publisher);
  }
  /** 校验发单和唤醒授权，生成结果回执与可用的审批订阅凭据。 */
  publish(raw: PublishTask, publisher?: HostPublisher) {
    if (this.closed) throw new AppError(503, "服务正在停止");
    const input = publishTaskSchema.parse(raw);
    if (publisher && input.wakeup)
      throw new AppError(400, "KMH 唤醒目标由宿主配置提供");
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
    const subscriptionToken =
      publisher?.subscriptionToken ?? randomBytes(32).toString("hex");
    const tokenHash = this.tokenHash(subscriptionToken);
    const source = publisher?.source;
    const wakeupTarget: DshWakeupTarget | undefined = publisher && {
      hostId: publisher.hostId,
      sessionId: publisher.source.targetSessionId ?? publisher.source.sessionId,
      originTurn: publisher.source.originTurn,
      publisherSessionId: publisher.source.sessionId,
    };
    const requestId = source && `mcp:${source.publishRequestId}`;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([input, wakeupTarget]))
      .digest("hex");
    const result = this.store.transaction(() => {
      // 原子保存任务、订阅和投递，并复用内容与凭据相同的宿主请求。
      if (publisher && requestId) {
        const existing = this.store.dshPublication(publisher.hostId, requestId);
        if (existing) {
          const task = this.store.task(existing.taskId);
          if (
            !task ||
            existing.fingerprint !== fingerprint ||
            !this.store.resultSubscriber(existing.taskId, tokenHash)
          )
            throw new AppError(409, "原发布请求的内容或凭据已变化");
          if (existing.taskTurn !== undefined)
            this.store.communication(
              task.id,
              existing.taskTurn,
              "publisher",
              "mingting",
              "new",
              input,
            );
          return { task, taskTurn: existing.taskTurn, event: undefined };
        }
        if (!publisher.connected)
          throw new AppError(503, "KMH 宿主尚未连接完成事件流");
      }
      if (this.store.countActive() >= LIMITS.queue)
        throw new AppError(429, "队列已满");
      const task = this.store.publish(input, wakeupTarget);
      this.store.saveResultSubscriber(task.id, tokenHash);
      if (task.approvalTargets.includes("subscriber"))
        this.store.saveApprovalSubscriber(task.id, tokenHash);
      if (publisher && requestId)
        this.store.recordDshPublication(
          publisher.hostId,
          requestId,
          fingerprint,
          task.id,
        );
      return { task, taskTurn: 1, event: this.store.deliver(task.id) };
    });
    if (result.event) this.available(result.event);
    const subscription = { taskId: result.task.id, subscriptionToken };
    return {
      taskId: result.task.id,
      taskTurn: result.taskTurn,
      resultSubscription: subscription,
      ...(wakeupTarget ? { wakeupTarget } : {}),
      ...(input.wakeup ? { wakeup: input.wakeup } : {}),
      ...(result.task.approvalTargets.includes("subscriber")
        ? {
            approvalSubscription: subscription,
          }
        : {}),
    };
  }
  /** 核对结果订阅凭据，并返回任务的当前状态。 */
  resultStatus(subscription: ApprovalSubscription) {
    if (
      !this.store.resultSubscriber(
        subscription.taskId,
        this.tokenHash(subscription.subscriptionToken),
      )
    )
      throw new AppError(403, "结果订阅凭据无效");
    const task = this.store.task(subscription.taskId);
    if (!task) throw new AppError(404, "任务不存在");
    return { taskId: task.id, taskStatus: task.status };
  }
  /** 按运行顺序产出稳定 ID 的完成事件，供结果订阅重放。 */
  *resultEvents(taskId: string) {
    for (const run of this.store.finishedRuns(taskId))
      yield taskResultEventSchema.parse({
        eventId: `task.completed:${run.id}`,
        taskId,
        runId: run.id,
        status: run.status,
        output: run.output,
        error: run.error,
        endedAt: run.endedAt,
      });
  }
  /** 读取已配置唤醒宿主的状态，缺省时报告未配置。 */
  wakeupStatus() {
    return (
      this.wakeups?.delivery.status() ?? {
        available: false,
        transport: "unconfigured",
        error: "聊天唤醒宿主尚未配置",
      }
    );
  }
  /** 校验审批订阅后返回任务的 Codex 唤醒目标和事件。 */
  taskWakeups(subscription: ApprovalSubscription) {
    this.requireSubscriber(subscription);
    return {
      target: this.store.wakeupTarget(subscription.taskId) ?? null,
      events: this.store.taskWakeups(subscription.taskId),
    };
  }
  /** 用原聊天中新开的回合确认已投递事件，并确保一轮只确认一个事件。 */
  acknowledgeWakeup(
    subscription: ApprovalSubscription,
    raw: WakeupAcknowledgement,
  ) {
    this.requireSubscriber(subscription);
    const input = wakeupAcknowledgementSchema.parse(raw);
    const event = this.store
      .taskWakeups(subscription.taskId)
      .find(
        /* 在订阅任务的事件里定位本次回执。 */ (item) =>
          item.id === input.eventId,
      );
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
        .some(
          /* 检查该聊天回合是否已用于确认其他唤醒事件。 */ (item) =>
            item.resumedTurnId === input.turnId,
        )
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
  /** 将订阅令牌转换为数据库校验使用的 SHA-256 摘要。 */
  private tokenHash(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }
  /** 校验任务的审批订阅凭据，并返回该任务。 */
  requireSubscriber(subscription: ApprovalSubscription) {
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
  /** 返回当前运行仍待处理的审批与任务状态。 */
  approvalSnapshot(subscription: ApprovalSubscription) {
    const task = this.requireSubscriber(subscription);
    return {
      type: "approval.snapshot" as const,
      taskId: task.id,
      taskStatus: task.status,
      approvals: task.currentRunId
        ? this.store
            .approvals(task.currentRunId)
            .filter(
              /* 只把待处理审批放入订阅快照。 */ (approval) =>
                approval.status === "pending",
            )
        : [],
    };
  }
  private approvalWaiters = 0;
  /** 限量等待审批可处理或任务结束，支持超时与取消并清理监听器。 */
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
    /** 在安装变更监听器前提供可安全清理的默认回调。 */
    let changed: () => void = () => {};
    /** 在安装停止监听器前提供可安全清理的默认回调。 */
    let stop: () => void = () => {};
    try {
      await new Promise<void>((resolve, reject) => {
        // 订阅变更、停止和取消信号，并安排本次等待的截止时间。
        stop = /* 服务停止或请求取消时结束等待并返回错误。 */ () =>
          reject(new AppError(503, "审批等待已结束"));
        changed = () => {
          // 任务结束或出现订阅者尚未决定的审批时唤醒等待方。
          const snapshot = this.approvalSnapshot(subscription);
          if (
            snapshot.approvals.some(
              /* 检查是否有订阅者尚未决定的待处理审批。 */ (a) =>
                !a.reviewerDecisions.some(
                  /* 定位订阅者已经提交的决定。 */ (d) =>
                    d.target === "subscriber",
                ),
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
  /** 校验认领者当前的连接代次与任务指定的执行器。 */
  private claimIdentity(task: Task, ownerId: string, generation?: string) {
    const subscription = this.subscriptions.get(ownerId);
    if (generation && subscription?.generation !== generation)
      throw new AppError(409, "领取请求不属于当前订阅连接");
    const identity = subscription?.identity;
    if (
      task.targetHarness &&
      identity?.harnessName.toLowerCase() !== task.targetHarness.toLowerCase()
    )
      throw new AppError(403, "请以目标 harness 身份保持在线订阅后领取");
    return identity;
  }
  /** 校验认领身份和投递归属，取得通信应关联的任务轮次。 */
  claimMessageScope(
    taskId: string,
    owner: Owner,
    generation?: string,
    deliveryId?: number,
  ): TaskMessageScope | undefined {
    const task = this.store.task(taskId);
    if (!task) return;
    this.claimIdentity(task, owner.ownerId, generation);
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
  /** 检查重启隔离期并认领排队任务，允许相同认领请求幂等重放。 */
  claim(
    taskId: string,
    owner: Owner,
    generation?: string,
    deliveryId?: number,
  ): Claim {
    if (this.closed) throw new AppError(503, "服务正在停止");
    if (Date.now() < this.resumeNotBefore)
      throw new AppError(409, "重启后等待旧连接器停止");
    this.sweep();
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
      const identity = this.claimIdentity(t, owner.ownerId, generation);
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
  /** 为有效认领续租，并返回任务运行状态供连接器识别取消。 */
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
  /** 按连续序号接收执行器回报，对已处理的上报返回幂等响应。 */
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
  /** 验证 ACP 审批请求，复用相同请求 ID，并限制单次运行的审批数量。 */
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
    const existing = previous.find(
      /* 按 ACP 请求 ID 查找已登记的审批。 */ (a) => a.requestId === requestId,
    );
    if (existing) {
      if (JSON.stringify(existing.request) !== JSON.stringify(request))
        throw new AppError(409, "重复审批 ID 的内容不同");
      return { approvalId: existing.id };
    }
    if (
      previous.length >= LIMITS.approvalsPerRun ||
      previous.filter(
        /* 只统计仍待处理的审批，检查并行积压上限。 */ (a) =>
          a.status === "pending",
      ).length >= LIMITS.pendingApprovals
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
        r.tools.find(
          /* 定位对应工具的进度记录，用于生成审批提示。 */ (tool) =>
            tool.id === request.toolCall.toolCallId,
        ),
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
      // 在同一事务保存新审批和任务、运行的等待状态。
      this.store.saveApproval(a);
      this.store.saveRun(r);
      this.store.saveTask(t);
    });
    return { approvalId: a.id };
  }
  /** 向持有有效认领的连接器返回审批状态或 ACP 决定。 */
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
  /** 校验审批仍可处理、运行租约有效且所选选项存在。 */
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
    if (
      !a.request.options.some(
        /* 确认决定引用了审批请求实际提供的选项。 */ (o) =>
          o.optionId === decision.optionId,
      )
    )
      throw new AppError(409, "审批选项无效");
    return { approval: a, run: r };
  }
  /** 保存网页用户的决定，并立即完成该审批。 */
  decide(id: string, decision: Decision) {
    this.sweep();
    const { approval } = this.pendingApproval(id, decision);
    approval.userDecision = { optionId: decision.optionId, decidedAt: now() };
    this.resolveApproval(approval, decision.optionId, "user");
  }
  /** 保存订阅者的审批意见，并设置网页用户可优先处理的宽限期。 */
  decideSubscriber(decision: SubscriberDecision) {
    this.requireSubscriber(decision);
    this.sweep();
    const { approval } = this.pendingApproval(decision.approvalId, decision);
    if (approval.taskId !== decision.taskId)
      throw new AppError(409, "审批不属于订阅任务");
    const existing = approval.reviewerDecisions.find(
      /* 找出订阅者已提交的意见，用于幂等和冲突检查。 */ (d) =>
        d.target === "subscriber",
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
  /** 记录最终审批决定，并按剩余审批更新任务与运行状态。 */
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
      // 原子写入审批结果、运行状态与任务状态。
      a.resolvedAt = now();
      this.store.saveApproval(a);
      r.status = this.store
        .approvals(r.id)
        .some(
          /* 检查同一次运行是否还有待处理审批。 */ (x) =>
            x.status === "pending",
        )
        ? "awaiting_approval"
        : "running";
      const t = this.store.task(r.taskId)!;
      t.status = r.status;
      this.store.saveRun(r);
      this.store.saveTask(t);
    });
  }
  /** 将指定运行中仍待处理的审批标记为过期。 */
  private expire(runId: string) {
    for (const a of this.store.approvals(runId))
      if (a.status === "pending") {
        a.status = "expired";
        this.store.saveApproval(a);
      }
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
        this.expire(r.id);
        this.store.saveRun(r);
      }
    });
  }
  /** 在原执行释放并满足上限后，将当前任务轮次重新排队。 */
  retry(id: string) {
    if (this.closed) throw new AppError(503, "服务正在停止");
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
  /** 处理失联租约、执行及审批超时，并在宽限期后采纳订阅者意见。 */
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
            /* 识别已到时限且尚未进入意见宽限期的待处理审批。 */ (a) =>
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
          // 结算失联运行和过期审批，并同步任务状态。
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
            /* 取出可在宽限期后采纳的订阅者决定。 */ (decision) =>
              decision.target === "subscriber",
          );
          if (reviewer)
            this.resolveApproval(approval, reviewer.optionId, reviewer.target);
        }
    }
  }
  /** 幂等停止定时清理和唤醒调度，收尾尚未结束的运行。 */
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.events.emit("close");
    await this.wakeups?.close();
    this.store.transaction(() => {
      // 原子中断未完成的运行与审批，并记录旧认领的隔离截止时间。
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
