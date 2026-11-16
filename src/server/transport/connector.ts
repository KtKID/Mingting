import { json, Router } from "express";
import { z } from "zod";
import {
  capabilityReportSchema,
  claimTaskSchema,
  harnessSubscriptionSchema,
  LIMITS,
  ownerSchema,
  permissionSubmissionSchema,
  reportSchema,
  type DeliveryEvent,
} from "../../shared/protocol.js";
import { AppError, type TaskService } from "../tasks/service.js";
import { releaseShortRequestSlot } from "./http-middleware.js";
import { taskExchange, taskMessage } from "./task-communication.js";

/** 提供执行器的任务投递、认领、租约和运行回报接口。 */
export function connectorRouter(
  service: TaskService,
  runReportBodyBytes: number,
) {
  const router = Router();
  const { store } = service;
  // Connector transport is separate from MCP and browser sessions; trusted local CLI only.
  router.use("/connector", (req, res, next) => {
    // 拦截带浏览器来源标记的连接器请求。
    if (
      req.headers.origin !== undefined ||
      req.headers["sec-fetch-site"] !== undefined
    )
      return res.status(403).json({ error: "订阅接口仅供本机连接器使用" });
    next();
  });
  router.post(
    "/connector/runs/:id/report",
    json({ limit: runReportBodyBytes }),
    (req, res) => {
      // 解析执行器按序提交的运行进度或结果，并记录通信。
      const runId = req.params.id;
      const body = reportSchema.parse(req.body);
      res.json(
        taskExchange(
          store,
          service.runMessageScope(runId, body),
          "executor",
          "report",
          { runId, reportSeq: body.seq, update: body.update },
          /* 按上报序号提交更新，返回是否重复处理。 */ () =>
            service.report(runId, body, body.seq, body.update),
        ),
      );
    },
  );
  router.use("/connector", json({ limit: LIMITS.httpBytes }));
  let subscriberCount = 0;
  router.get("/connector/events", (req, res) => {
    // 登记执行器订阅，先从游标重放历史投递，再继续接收实时事件。
    const raw = req.headers["last-event-id"] ?? req.query.after ?? "0";
    const after = Number(raw);
    if (
      typeof raw !== "string" ||
      !/^\d+$/.test(raw) ||
      !Number.isSafeInteger(after) ||
      after > store.latestDelivery()
    )
      throw new AppError(400, "事件游标无效");
    if (subscriberCount >= LIMITS.subscribers)
      throw new AppError(429, "订阅连接数量超限");
    const identity =
      req.headers["x-harness-name"] !== undefined ||
      req.headers["x-owner-id"] !== undefined
        ? harnessSubscriptionSchema.parse({
            harnessName: req.headers["x-harness-name"],
            ownerId: req.headers["x-owner-id"],
          })
        : undefined;
    const generation = z
      .uuid()
      .optional()
      .parse(req.headers["x-connector-generation"]);
    const unregister = identity
      ? service.registerHarness(identity, generation)
      : /* 没有执行器身份时使用空注销回调。 */ () => {};
    subscriberCount++;
    let cursor = after,
      closed = false;
    res.status(200).set({
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.setTimeout(0);
    res.flushHeaders();
    /** 按游标推进投递，为已登记身份的执行器过滤任务并记录通信。 */
    const send = (event: DeliveryEvent) => {
      if (closed || res.destroyed || res.writableEnded || event.id <= cursor)
        return;
      cursor = event.id;
      const target = store.task(event.taskId)?.targetHarness;
      if (
        identity &&
        target &&
        target.toLowerCase() !== identity.harnessName.toLowerCase()
      )
        return;
      try {
        const delivery = store.deliveryTurn(event.id);
        if (delivery?.taskTurn !== undefined)
          taskMessage(
            store,
            { taskId: event.taskId, taskTurn: delivery.taskTurn },
            "executor",
            "send",
            "task.available",
            event,
          );
        const writable = res.write(
          `id: ${event.id}\nevent: task.available\ndata: ${JSON.stringify(event)}\n\n`,
        );
        if (!writable) res.end();
      } catch {
        res.end();
      }
    };
    /** 关闭连接器订阅响应。 */
    const stop = () => res.end();
    const heartbeat = setInterval(() => {
      // 定期发送连接器心跳，写入出现背压时断开。
      if (!res.write(": heartbeat\n\n")) res.end();
    }, LIMITS.subscriptionHeartbeatMs);
    service.events.on("available", send);
    service.events.on("close", stop);
    res.once("close", () => {
      // 注销执行器并回收订阅名额、心跳和监听器。
      closed = true;
      subscriberCount--;
      unregister();
      clearInterval(heartbeat);
      service.events.off("available", send);
      service.events.off("close", stop);
    });
    // No await between attaching and replay: a publication cannot fall into a replay/live gap.
    let page;
    do {
      page = store.deliveries(cursor);
      for (const event of page) {
        send(event);
        if (res.writableEnded) break;
      }
    } while (page.length === 200 && !res.writableEnded);
    if (!res.writableEnded) res.write(": subscribed\n\n");
    releaseShortRequestSlot(res);
  });
  router.post("/connector/capabilities", (req, res) => {
    // 更新当前连接器代次的能力快照。
    service.reportCapabilities(capabilityReportSchema.parse(req.body));
    res.json({ accepted: true });
  });
  router.post("/connector/claim", (req, res) => {
    // 校验任务、连接代次和投递信息，受理连接器的任务认领请求。
    const { taskId, generation, deliveryId, ...owner } = claimTaskSchema
      .extend({ generation: z.uuid().optional() })
      .parse(req.body);
    const scope = service.claimMessageScope(
      taskId,
      owner,
      generation,
      deliveryId,
    );
    res.json(
      taskExchange(
        store,
        scope,
        "executor",
        "claim",
        { taskId, deliveryId },
        /* 尝试认领对应投递与轮次，返回运行信息和租约。 */ () =>
          service.claim(taskId, owner, generation, deliveryId),
      ),
    );
  });
  router.post("/connector/runs/:id/heartbeat", (req, res) => {
    // 校验认领身份，处理运行租约续期并记录通信。
    const runId = req.params.id;
    const owner = ownerSchema.parse(req.body);
    res.json(
      taskExchange(
        store,
        service.runMessageScope(runId, owner),
        "executor",
        "heartbeat",
        { runId },
        /* 延长认领租约并返回当前运行状态。 */ () =>
          service.heartbeat(runId, owner),
      ),
    );
  });
  router.post("/connector/runs/:id/permissions", (req, res) => {
    // 接收执行器的 ACP 审批请求，并记录所属运行的任务通信。
    const runId = req.params.id;
    const body = permissionSubmissionSchema.parse(req.body);
    res.json(
      taskExchange(
        store,
        service.runMessageScope(runId, body),
        "executor",
        "permission",
        { runId, requestId: body.requestId, request: body.request },
        /* 提交会话审批请求并取得审批 ID。 */ () =>
          service.permission(runId, body, body.requestId, body.request),
      ),
    );
  });
  router.post(
    "/connector/runs/:id/permissions/:approvalId/result",
    (req, res) => {
      // 查询指定运行的审批状态与最终决定，并记录通信。
      const { id: runId, approvalId } = req.params;
      const owner = ownerSchema.parse(req.body);
      res.json(
        taskExchange(
          store,
          service.runMessageScope(runId, owner),
          "executor",
          "permission.result",
          { runId, approvalId },
          /* 为认领者读取审批的待处理状态或 ACP 结果。 */ () =>
            service.permissionResult(runId, owner, approvalId),
        ),
      );
    },
  );
  router.use(
    "/connector",
    /* 为未匹配的连接器路径返回 404。 */ (_req, res) =>
      res.status(404).json({ error: "连接器接口不存在" }),
  );
  return router;
}
