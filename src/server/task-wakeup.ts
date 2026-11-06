import type {
  WakeupEvent,
  WakeupHostStatus,
  WakeupTarget,
} from "../shared/task-wakeup.js";
import type { Store } from "./store.js";

export type WakeupDelivery = {
  status(): WakeupHostStatus;
  accepts(target: WakeupTarget): boolean;
  send(event: WakeupEvent): Promise<unknown>;
  close?(): Promise<void>;
};

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
  kick() {
    if (this.stopped) return;
    this.dirty = true;
    this.running = this.running
      .then(() => this.drain())
      .catch((error) => {
        console.error(
          "聊天唤醒投递异常",
          error instanceof Error ? error.message : "未知错误",
        );
      });
  }
  async idle() {
    await this.running;
  }
  async close() {
    this.stopped = true;
    await this.delivery.close?.();
    await this.running;
  }
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
        const receipt = await this.delivery.send(sending);
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
