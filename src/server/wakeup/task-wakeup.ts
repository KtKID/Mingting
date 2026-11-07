import type {
  WakeupEvent,
  WakeupHostStatus,
  WakeupTarget,
} from "../../shared/task-wakeup.js";
import type { Store } from "../storage/store.js";

export type WakeupDelivery = {
  status(): WakeupHostStatus;
  accepts(target: WakeupTarget): boolean;
  send(event: WakeupEvent): Promise<unknown>;
  close?(): Promise<void>;
};

/** 将唤醒事件编码为带事件标记、任务标识和原会话信息的聊天消息。 */
export function wakeupMessage(event: WakeupEvent) {
  return (
    `[MINGTING_EVENT ${event.id}]\n明庭任务事件：${event.type}\n` +
    JSON.stringify(
      {
        eventId: event.id,
        taskId: event.taskId,
        runId: event.runId,
        approvalId: event.approvalId,
        threadId: event.target.threadId,
        originTurnId: event.target.originTurnId,
        createdAt: event.createdAt,
      },
      null,
      2,
    )
  );
}

export class WakeupDispatcher {
  private running: Promise<void> = Promise.resolve();
  private dirty = false;
  private stopped = false;
  /** 初始化唤醒调度器，把重启前仍在发送的事件标记为待核对的失败。 */
  constructor(
    private store: Store,
    readonly delivery: WakeupDelivery,
  ) {
    // An interrupted external call has an unknown outcome and needs review.
    for (const event of store.taskWakeups())
      if (event.status === "sending") {
        store.saveWakeup({
          ...event,
          status: "failed",
          error: "宿主投递结果待确认；先核对聊天记录，再决定重试。",
        });
      }
  }
  /** 标记有待投递事件，并串行安排下一次队列处理。 */
  kick() {
    if (this.stopped) return;
    this.dirty = true;
    this.running = this.running
      .then(/* 等待前一轮投递结束后处理待发送队列。 */ () => this.drain())
      .catch((error) => {
        // 记录队列异常，并保留后续调度能力。
        console.error(
          "聊天唤醒投递异常",
          error instanceof Error ? error.message : "未知错误",
        );
      });
  }
  /** 等待当前已安排的唤醒投递工作结束。 */
  async idle() {
    await this.running;
  }
  /** 停止接收新的投递调度，关闭宿主并等待队列收尾。 */
  async close() {
    this.stopped = true;
    await this.delivery.close?.();
    await this.running;
  }
  /** 逐个投递仍有效的唤醒事件，并持久化状态、回执或错误。 */
  private async drain() {
    if (!this.dirty || this.stopped) return;
    this.dirty = false;
    for (const event of this.store.pendingWakeups()) {
      if (this.stopped) return;
      if (event.type === "approval.requested") {
        const approval = event.approvalId
          ? this.store.approval(event.approvalId)
          : undefined;
        const run = this.store.run(event.runId);
        if (
          approval?.status !== "pending" ||
          run?.endedAt ||
          this.store.task(event.taskId)?.currentRunId !== event.runId
        ) {
          this.store.saveWakeup({ ...event, status: "superseded" });
          continue;
        }
      }
      const sending: WakeupEvent = {
        ...event,
        status: "sending",
        attempts: event.attempts + 1,
      };
      this.store.saveWakeup(sending);
      try {
        const status = this.delivery.status();
        if (!status.available)
          throw new Error(status.error ?? "聊天唤醒宿主不可用");
        const scope = this.store.runMessageScope(event.runId);
        if (scope)
          this.store.communication(
            scope.taskId,
            scope.taskTurn,
            "mingting",
            "publisher",
            "wakeup",
            {
              eventId: sending.id,
              type: sending.type,
              runId: sending.runId,
              approvalId: sending.approvalId,
            },
          );
        const receipt = await this.delivery.send(sending);
        if (scope)
          this.store.communication(
            scope.taskId,
            scope.taskTurn,
            "publisher",
            "mingting",
            "wakeup.receipt",
            receipt ?? null,
          );
        this.store.saveWakeup({
          ...sending,
          status: "delivered",
          deliveredAt: new Date().toISOString(),
          receipt: receipt ?? null,
          error: null,
        });
      } catch (error) {
        this.store.saveWakeup({
          ...sending,
          status: "failed",
          error: error instanceof Error ? error.message : "聊天唤醒投递失败",
        });
      }
    }
  }
}
