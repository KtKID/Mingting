import { createHash } from "node:crypto";
import type { EventEmitter } from "node:events";
import { LIMITS, type ApprovalSubscription } from "../../shared/protocol.js";
import { taskResultEventSchema } from "../../shared/host-wakeup.js";
import type { Store } from "../storage/store.js";
import { AppError } from "./app-error.js";

/** 生成存储与校验订阅凭据使用的摘要。 */
export function hashSubscriptionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export class PublisherSubscriptions {
  constructor(
    private store: Store,
    private events: EventEmitter,
    private isClosed: () => boolean,
  ) {}

  /** 核对结果订阅凭据，并返回任务的当前状态。 */
  resultStatus(subscription: ApprovalSubscription) {
    if (
      !this.store.resultSubscriber(
        subscription.taskId,
        hashSubscriptionToken(subscription.subscriptionToken),
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

  /** 校验任务的审批订阅凭据，并返回该任务。 */
  requireSubscriber(subscription: ApprovalSubscription) {
    if (
      !this.store.approvalSubscriber(
        subscription.taskId,
        hashSubscriptionToken(subscription.subscriptionToken),
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
    if (this.isClosed()) throw new AppError(503, "服务正在停止");
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
}
