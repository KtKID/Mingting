import { EventEmitter } from "node:events";
import type {
  JsonRpcId,
  RequestPermissionRequest,
} from "@agentclientprotocol/sdk";
import {
  LIMITS,
  type ApprovalSubscription,
  type CapabilityReport,
  type Claim,
  type ConnectorUpdate,
  type Decision,
  type DeliveryEvent,
  type HarnessIdentity,
  type Owner,
  type PublishTask,
  type SubscriberDecision,
  type TaskMessageScope,
} from "../../shared/protocol.js";
import type { DshAck, DshPublish } from "../../shared/dsh-wakeup.js";
import type { WakeupAcknowledgement } from "../../shared/task-wakeup.js";
import type { Store } from "../storage/store.js";
import {
  WakeupDispatcher,
  type WakeupDelivery,
} from "../wakeup/task-wakeup.js";
import * as wakeupReceipts from "../wakeup/receipts.js";
import { AppError } from "./app-error.js";
import { TaskApprovals } from "./approvals.js";
import { HarnessRegistry } from "./harness-registry.js";
import { TaskPublication, type HostPublisher } from "./publication.js";
import { PublisherSubscriptions } from "./publisher-subscriptions.js";
import { TaskRuns } from "./runs.js";

export { AppError } from "./app-error.js";

export class TaskService {
  private readonly registry = new HarnessRegistry(() =>
    this.events.emit("changed"),
  );
  private readonly publication: TaskPublication;
  private readonly subscriptions: PublisherSubscriptions;
  private readonly runs: TaskRuns;
  private readonly approvals: TaskApprovals;
  private readonly resumeNotBefore: number;
  private closed = false;
  private readonly timer: NodeJS.Timeout;
  readonly events = new EventEmitter();
  readonly wakeups?: WakeupDispatcher;
  /** 恢复数据库状态，设置重启隔离期，并挂接唤醒调度与超时清理。 */
  constructor(
    public store: Store,
    workspace: string,
    mode: "fake" | "codex",
    wakeupDelivery?: WakeupDelivery,
  ) {
    this.resumeNotBefore = Math.max(
      store.quarantineUntil(),
      store.unfinished().length ? Date.now() + LIMITS.leaseMs : 0,
    );
    store.recover();
    if (wakeupDelivery)
      this.wakeups = new WakeupDispatcher(store, wakeupDelivery);
    const isClosed = () => this.closed;
    const available = (event: DeliveryEvent) =>
      this.events.emit("available", event);
    this.publication = new TaskPublication(
      store,
      isClosed,
      available,
      wakeupDelivery,
    );
    this.subscriptions = new PublisherSubscriptions(
      store,
      this.events,
      isClosed,
    );
    this.runs = new TaskRuns(
      store,
      workspace,
      mode,
      this.registry,
      isClosed,
      available,
    );
    this.approvals = new TaskApprovals(store, (taskId, reason) =>
      this.cancel(taskId, reason),
    );
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

  registerHarness(identity: HarnessIdentity, generation?: string) {
    return this.registry.registerHarness(identity, generation);
  }

  reportCapabilities(report: CapabilityReport) {
    return this.registry.reportCapabilities(report);
  }

  harnesses() {
    return this.registry.harnesses();
  }

  publishFromDsh(hostId: string, input: DshPublish, connected: boolean) {
    return this.publication.publishFromDsh(hostId, input, connected);
  }

  isOriginalPublisher(taskId: string, publisher: HostPublisher) {
    return this.publication.isOriginalPublisher(taskId, publisher);
  }

  publishCommand(raw: unknown, publisher?: HostPublisher) {
    return this.publication.publishCommand(raw, publisher);
  }

  publish(raw: PublishTask, publisher?: HostPublisher) {
    return this.publication.publish(raw, publisher);
  }

  acknowledgeDshWakeup(hostId: string, ack: DshAck) {
    return wakeupReceipts.acknowledgeDshWakeup(this.store, hostId, ack);
  }

  wakeupStatus() {
    return wakeupReceipts.wakeupStatus(this.wakeups?.delivery);
  }

  taskWakeups(subscription: ApprovalSubscription) {
    this.requireSubscriber(subscription);
    return wakeupReceipts.taskWakeups(this.store, subscription.taskId);
  }

  acknowledgeWakeup(
    subscription: ApprovalSubscription,
    raw: WakeupAcknowledgement,
  ) {
    this.requireSubscriber(subscription);
    return wakeupReceipts.acknowledgeWakeup(
      this.store,
      subscription.taskId,
      raw,
    );
  }

  resultStatus(subscription: ApprovalSubscription) {
    return this.subscriptions.resultStatus(subscription);
  }

  resultEvents(taskId: string) {
    return this.subscriptions.resultEvents(taskId);
  }

  requireSubscriber(subscription: ApprovalSubscription) {
    return this.subscriptions.requireSubscriber(subscription);
  }

  approvalSnapshot(subscription: ApprovalSubscription) {
    return this.subscriptions.approvalSnapshot(subscription);
  }

  waitForApproval(
    subscription: ApprovalSubscription,
    waitMs: number,
    signal?: AbortSignal,
  ) {
    return this.subscriptions.waitForApproval(subscription, waitMs, signal);
  }

  claimMessageScope(
    taskId: string,
    owner: Owner,
    generation?: string,
    deliveryId?: number,
  ): TaskMessageScope | undefined {
    return this.runs.claimMessageScope(taskId, owner, generation, deliveryId);
  }

  runMessageScope(runId: string, owner: Owner) {
    return this.runs.runMessageScope(runId, owner);
  }

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
    return this.runs.claim(taskId, owner, generation, deliveryId);
  }

  heartbeat(runId: string, owner: Owner) {
    this.sweep();
    return this.runs.heartbeat(runId, owner);
  }

  report(runId: string, owner: Owner, seq: number, update: ConnectorUpdate) {
    return this.runs.report(runId, owner, seq, update);
  }

  permission(
    runId: string,
    owner: Owner,
    requestId: JsonRpcId,
    request: RequestPermissionRequest,
  ) {
    const { run } = this.runs.requireOwnedRun(runId, owner);
    return this.approvals.permission(run, requestId, request);
  }

  permissionResult(runId: string, owner: Owner, approvalId: string) {
    this.sweep();
    this.runs.requireOwnedRun(runId, owner);
    return this.approvals.permissionResult(runId, approvalId);
  }

  decide(id: string, decision: Decision) {
    this.sweep();
    this.approvals.decide(id, decision);
  }

  decideSubscriber(decision: SubscriberDecision) {
    this.requireSubscriber(decision);
    this.sweep();
    this.approvals.decideSubscriber(decision);
  }

  cancel(id: string, reason?: string) {
    this.runs.cancel(id, reason);
  }

  retry(id: string) {
    return this.runs.retry(id);
  }

  /** 按租约、执行时限、审批时限和用户优先窗口的顺序处理未结束运行。 */
  sweep(time = Date.now()) {
    if (this.closed) return;
    for (const run of this.store.unfinished()) {
      const lease = this.store.lease(run.id);
      if (!lease || lease.deadline <= time) {
        this.runs.interrupt(run, "订阅连接器失联，原领取已失效；请显式重试");
      } else if (time - Date.parse(run.createdAt) >= LIMITS.runMs) {
        if (run.status !== "cancelled") this.cancel(run.taskId, "执行超时");
      } else if (this.approvals.hasTimedOut(run.id, time)) {
        if (run.status !== "cancelled") this.cancel(run.taskId, "审批超时");
      } else {
        this.approvals.resolveDue(run.id, time);
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
    this.runs.shutdown();
  }
}
