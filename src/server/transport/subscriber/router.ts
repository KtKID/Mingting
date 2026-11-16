import { Router } from "express";
import { z } from "zod";
import {
  approvalSubscriptionSchema,
  LIMITS,
  subscriberDecisionSchema,
} from "../../../shared/protocol.js";
import { AppError, type TaskService } from "../../tasks/service.js";
import { releaseShortRequestSlot } from "../http-middleware.js";
import { taskMessage } from "../task-communication.js";
import { subscriberDecision } from "./decision.js";

/** 提供发起方的审批和结果订阅，以及 HTTP 审批决定入口。 */
export function subscriberRouter(service: TaskService) {
  const router = Router();
  const { store } = service;
  router.use("/subscriber", (req, res, next) => {
    // 拦截带浏览器来源标记的任务订阅请求。
    if (
      req.headers.origin !== undefined ||
      req.headers["sec-fetch-site"] !== undefined
    )
      return res.status(403).json({ error: "任务订阅接口仅供本机客户端使用" });
    next();
  });
  let taskSubscriberCount = 0;
  router.get("/subscriber/events", (req, res) => {
    // 鉴权后建立审批或结果 SSE 订阅，并推送状态和可重放事件。
    const view = z
      .enum(["approval", "result"])
      .default("approval")
      .parse(req.query.view);
    const subscription = approvalSubscriptionSchema.parse({
      taskId: req.query.taskId,
      subscriptionToken: z
        .string()
        .regex(/^Bearer [a-f0-9]{64}$/)
        .parse(req.headers.authorization)
        .slice(7),
    });
    const snapshot =
      view === "result"
        ? /* 读取结果订阅当前的任务状态。 */ () =>
            service.resultStatus(subscription)
        : /* 读取审批订阅当前的待处理审批快照。 */ () =>
            service.approvalSnapshot(subscription);
    snapshot();
    const taskId = subscription.taskId;
    taskMessage(
      store,
      store.taskMessageScope(taskId),
      "publisher",
      "receive",
      "subscribe",
      { view },
    );
    if (taskSubscriberCount >= LIMITS.subscribers)
      throw new AppError(429, "任务订阅数量超限");
    taskSubscriberCount++;
    let previous = "";
    let blocked = false;
    const sent = new Set<string>();
    res.status(200).set({
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.setTimeout(0);
    res.flushHeaders();
    /** 结束发起方的任务订阅响应。 */
    const stop = () => res.end();
    /** 写入订阅帧并记住输出是否出现背压。 */
    const write = (frame: string) => {
      blocked = !res.write(frame);
    };
    /** 发送有变化的快照，并为结果订阅补发尚未发送的完成事件。 */
    const sendSnapshot = () => {
      if (res.writableEnded || res.destroyed || blocked) return;
      const current = snapshot();
      const data = JSON.stringify(current);
      if (data !== previous) {
        previous = data;
        const event = view === "result" ? "task.status" : "approval.snapshot";
        taskMessage(
          store,
          store.taskMessageScope(taskId),
          "publisher",
          "send",
          event,
          current,
        );
        write(`event: ${event}\ndata: ${data}\n\n`);
      }
      if (view !== "result" || blocked) return;
      for (const event of service.resultEvents(subscription.taskId)) {
        if (sent.has(event.eventId)) continue;
        sent.add(event.eventId);
        taskMessage(
          store,
          store.runMessageScope(event.runId),
          "publisher",
          "send",
          "task.completed",
          event,
        );
        write(
          `id: ${event.eventId}\nevent: task.completed\ndata: ${JSON.stringify(event)}\n\n`,
        );
        if (blocked) break;
      }
    };
    /** 尝试更新订阅，读取或写入失败时关闭连接。 */
    const send = () => {
      try {
        sendSnapshot();
      } catch {
        stop();
      }
    };
    /** 缓冲排空后恢复推送。 */
    const drain = () => {
      blocked = false;
      send();
    };
    res.on("drain", drain);
    const heartbeat = setInterval(() => {
      // 只向仍可写的订阅响应发送心跳。
      if (!res.writableEnded && !blocked) write(": heartbeat\n\n");
    }, LIMITS.subscriptionHeartbeatMs);
    service.events.on("changed", send);
    service.events.once("close", stop);
    res.once("close", () => {
      // 释放任务订阅名额、心跳和监听器。
      taskSubscriberCount--;
      res.off("drain", drain);
      clearInterval(heartbeat);
      service.events.off("changed", send);
      service.events.off("close", stop);
    });
    // Subscribe before reading the persisted snapshot and finished runs.
    send();
    releaseShortRequestSlot(res);
  });
  router.post("/subscriber/decision", (req, res) => {
    // 接收本机客户端通过 HTTP 提交的订阅审批决定。
    res.json(
      subscriberDecision(service, subscriberDecisionSchema.parse(req.body)),
    );
  });
  router.use(
    "/subscriber",
    /* 为未匹配的任务订阅路径返回 404。 */ (_req, res) =>
      res.status(404).json({ error: "审批订阅接口不存在" }),
  );
  return router;
}
