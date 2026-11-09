import type { HostAck } from "../../shared/host-wakeup.js";
import {
  wakeupAcknowledgementSchema,
  type WakeupAcknowledgement,
} from "../../shared/task-wakeup.js";
import type { Store } from "../storage/store.js";
import { AppError } from "../tasks/app-error.js";
import type { WakeupDelivery } from "./task-wakeup.js";

/** 接收宿主对完成唤醒的处理结果。 */
export function acknowledgeHostWakeup(
  store: Store,
  hostId: string,
  ack: HostAck,
) {
  store.transaction(() => {
    // 校验事件归属并幂等保存确认，拒绝覆盖已有的不同结果。
    const event = store.hostWakeup(ack.eventId, hostId);
    if (!event || event.target.sessionId !== ack.sessionId)
      throw new AppError(404, "当前宿主和会话没有这条完成事件");
    const status = ack.outcome === "accepted" ? "delivered" : "failed";
    if (event.status === status) return;
    if (event.status !== "pending")
      throw new AppError(409, "该事件已有其他投递结果");
    store.saveHostWakeup({
      ...event,
      status,
      attempts: event.attempts + 1,
      deliveredAt: status === "delivered" ? new Date().toISOString() : null,
      receipt:
        ack.outcome === "accepted"
          ? {
              source: "wakeup-host",
              hostId,
              sessionId: ack.sessionId,
              accepted: true,
            }
          : null,
      error: ack.outcome === "rejected" ? ack.reason : null,
    });
  });
  return { ok: true };
}

/** 读取已配置唤醒宿主的状态，缺省时报告未配置。 */
export function wakeupStatus(delivery?: WakeupDelivery) {
  return (
    delivery?.status() ?? {
      available: false,
      transport: "unconfigured",
      error: "聊天唤醒宿主尚未配置",
    }
  );
}
/** 读取已授权任务的 Codex 唤醒目标和事件。 */
export function taskWakeups(store: Store, taskId: string) {
  return {
    target: store.wakeupTarget(taskId) ?? null,
    events: store.taskWakeups(taskId),
  };
}
/** 用原聊天中新开的回合确认已投递事件，并确保一轮只确认一个事件。 */
export function acknowledgeWakeup(
  store: Store,
  taskId: string,
  raw: WakeupAcknowledgement,
) {
  const input = wakeupAcknowledgementSchema.parse(raw);
  const event = store
    .taskWakeups(taskId)
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
    store
      .taskWakeups(taskId)
      .some(
        /* 检查该聊天回合是否已用于确认其他唤醒事件。 */ (item) =>
          item.resumedTurnId === input.turnId,
      )
  )
    throw new AppError(409, "审批与完成需要分别恢复独立回合");
  store.saveWakeup({
    ...event,
    status: "acknowledged",
    resumedTurnId: input.turnId,
    acknowledgedAt: new Date().toISOString(),
  });
  return { ok: true };
}
