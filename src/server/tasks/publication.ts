import { createHash, randomBytes } from "node:crypto";
import type { z } from "zod";
import {
  LIMITS,
  publishTaskSchema,
  taskCommandSchema,
  type DeliveryEvent,
  type PublishTask,
} from "../../shared/protocol.js";
import {
  type HostPublisherContext,
  appendTaskSchema,
} from "../../shared/host-wakeup.js";
import type { Store } from "../storage/store.js";
import type { WakeupDelivery } from "../wakeup/task-wakeup.js";
import { wakeupStatus } from "../wakeup/receipts.js";
import { AppError } from "./app-error.js";
import { hashSubscriptionToken } from "./publisher-subscriptions.js";

/** 生成任务状态与事件使用的 UTC 时间戳。 */
const now = () => new Date().toISOString();
export type HostPublisher = {
  hostId: string;
  source: HostPublisherContext;
  connected: boolean;
  subscriptionToken: string;
};

export class TaskPublication {
  constructor(
    private store: Store,
    private isClosed: () => boolean,
    private available: (event: DeliveryEvent) => void,
    private wakeupDelivery?: WakeupDelivery,
  ) {}

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
    };
    // 沿用既有指纹的字段及顺序，切换前已受理的请求仍可幂等重试。
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          command,
          {
            ...target,
            publisherSessionId: source.sessionId,
            originTurn: source.originTurn,
          },
        ]),
      )
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
      const existing = this.store.hostPublication(publisher.hostId, requestId);
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
        throw new AppError(503, "唤醒宿主尚未连接完成事件流");
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
      this.store.recordHostPublication(
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
    if (this.isClosed()) throw new AppError(503, "服务正在停止");
    const command = taskCommandSchema.parse(raw);
    if (command.action === "append") return this.append(command, publisher);
    const { action: _action, ...fields } = command;
    return this.publish(fields, publisher);
  }
  /** 校验发单和唤醒授权，生成结果回执与可用的审批订阅凭据。 */
  publish(raw: PublishTask, publisher?: HostPublisher) {
    if (this.isClosed()) throw new AppError(503, "服务正在停止");
    const input = publishTaskSchema.parse(raw);
    if (publisher && input.wakeup)
      throw new AppError(400, "宿主唤醒目标由已认证的发布者提供");
    if (input.wakeup) {
      if (!(input.approvalTargets ?? ["subscriber"]).includes("subscriber"))
        throw new AppError(400, "聊天唤醒需要发起方审批订阅");
      if (!wakeupStatus(this.wakeupDelivery).available)
        throw new AppError(503, "聊天唤醒宿主尚未接通；请先完成宿主接入验证。");
      if (!this.wakeupDelivery?.accepts(input.wakeup))
        throw new AppError(403, "聊天目标超出宿主预检确认的授权范围");
    }
    if (input.approvalTargets?.includes("third_party"))
      throw new AppError(400, "第三方审批正在开发中");
    const subscriptionToken =
      publisher?.subscriptionToken ?? randomBytes(32).toString("hex");
    const tokenHash = hashSubscriptionToken(subscriptionToken);
    const source = publisher?.source;
    const host = publisher && {
      wakeupTarget: {
        hostId: publisher.hostId,
        sessionId:
          publisher.source.targetSessionId ?? publisher.source.sessionId,
      },
      source: {
        hostId: publisher.hostId,
        publisherSessionId: publisher.source.sessionId,
        originTurn: publisher.source.originTurn,
      },
    };
    const requestId = source && `mcp:${source.publishRequestId}`;
    // 保留首发请求的原指纹字段及顺序，存储目标只保留投递身份。
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          input,
          host && {
            ...host.wakeupTarget,
            originTurn: host.source.originTurn,
            publisherSessionId: host.source.publisherSessionId,
          },
        ]),
      )
      .digest("hex");
    const result = this.store.transaction(() => {
      // 原子保存任务、订阅和投递，并复用内容与凭据相同的宿主请求。
      if (publisher && requestId) {
        const existing = this.store.hostPublication(
          publisher.hostId,
          requestId,
        );
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
          throw new AppError(503, "唤醒宿主尚未连接完成事件流");
      }
      if (this.store.countActive() >= LIMITS.queue)
        throw new AppError(429, "队列已满");
      const task = this.store.publish(input, host);
      this.store.saveResultSubscriber(task.id, tokenHash);
      if (task.approvalTargets.includes("subscriber"))
        this.store.saveApprovalSubscriber(task.id, tokenHash);
      if (publisher && requestId)
        this.store.recordHostPublication(
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
      ...(host ? { wakeupTarget: host.wakeupTarget } : {}),
      ...(input.wakeup ? { wakeup: input.wakeup } : {}),
      ...(result.task.approvalTargets.includes("subscriber")
        ? {
            approvalSubscription: subscription,
          }
        : {}),
    };
  }
}
