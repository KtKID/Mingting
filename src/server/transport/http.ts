import express, { type Request } from "express";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { z, ZodError } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  LIMITS,
  publishTaskSchema,
  mcpTaskCommandSchema,
  decisionSchema,
  claimTaskSchema,
  ownerSchema,
  reportSchema,
  permissionSubmissionSchema,
  harnessSubscriptionSchema,
  capabilityReportSchema,
  approvalSubscriptionSchema,
  subscriberDecisionSchema,
  approvalWaitSchema,
  type DeliveryEvent,
  type TaskMessageScope,
} from "../../shared/protocol.js";
import { Store } from "../storage/store.js";
import { TaskService, AppError } from "../tasks/service.js";
import { readApprovalHistory } from "../storage/approval-history.js";
import { loadConfig } from "../config.js";
import type { WakeupDelivery } from "../wakeup/task-wakeup.js";
import { dshWakeupRouter, type DshWakeupHost } from "./dsh-wakeup.js";
import { wakeupAcknowledgementSchema } from "../../shared/task-wakeup.js";
import {
  publisherContextKey,
  taskCommandDescription,
  publishTaskToolName,
} from "../../shared/dsh-wakeup.js";
import { taskExchange, taskMessage } from "./task-communication.js";

/** 为发单回执附上当前本机服务的任务详情地址。 */
function withTaskUrl<T extends { taskId: string }>(req: Request, receipt: T) {
  return {
    ...receipt,
    taskUrl: `http://${req.headers.host}/?task=${receipt.taskId}`,
  };
}

type Config = {
  dbPath: string;
  workspace: string;

  mode?: "fake" | "codex";
  wakeupDelivery?: WakeupDelivery;
  dshWakeupHost?: DshWakeupHost;
  configPath?: string;
};
/** 组装任务服务、数据库及网页、订阅、连接器和 MCP 接口。 */
export function createPlatform(config: Config) {
  const { tasks } = loadConfig(config.configPath);
  const store = new Store(config.dbPath);
  const service = new TaskService(
    store,
    config.workspace,
    config.mode ?? "codex",
    config.wakeupDelivery,
  );
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  const sessions = new Map<
    string,
    { csrf: string; expires: number; host: string }
  >();
  let inflight = 0;
  app.use((req, res, next) => {
    // 限制本机来源与并发数，并给响应设置浏览器安全头。
    const address = req.socket.remoteAddress;
    const localPort = req.socket.localPort;
    const hosts = [`127.0.0.1:${localPort}`, `localhost:${localPort}`];
    const host = req.headers.host;
    if (
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address ?? "") ||
      !host ||
      !hosts.includes(host)
    )
      return res.status(403).json({ error: "仅允许可信本机 Host" });
    if (
      req.headers.origin !== undefined &&
      req.headers.origin !== `http://${host}`
    )
      return res.status(403).json({ error: "请求 Origin 无效" });
    if (req.headers["sec-fetch-site"] === "cross-site")
      return res.status(403).json({ error: "拒绝跨站请求" });
    if (inflight >= LIMITS.httpConcurrent)
      return res.status(429).json({ error: "请求过多" });
    inflight++;
    let released = false;
    /** 在请求完成或连接关闭时只归还一次并发名额。 */
    const release = () => {
      if (!released) {
        released = true;
        inflight--;
      }
    };
    res.once("finish", release);
    res.once("close", release);
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    next();
  });
  app.use(express.json({ limit: LIMITS.httpBytes }));
  const dshHost = config.dshWakeupHost
    ? dshWakeupRouter(
        service,
        config.dshWakeupHost,
        tasks.wakeupResultTextLimit,
      )
    : undefined;
  if (dshHost) app.use("/wakeup-host", dshHost.router);
  app.get("/api/bootstrap", (req, res) => {
    // 清理过期会话并为网页初始化或续用会话与 CSRF 凭据。
    for (const [key, value] of sessions)
      if (value.expires < Date.now()) sessions.delete(key);
    const id = req.headers.cookie
      ?.split(";")
      .map(/* 去除每段 Cookie 前后的空白。 */ (c) => c.trim())
      .find(
        /* 定位网页任务会话的 Cookie。 */ (c) => c.startsWith("task_session="),
      )
      ?.slice(13);
    const old = id ? sessions.get(id) : undefined;
    if (old && old.host === req.headers.host)
      return res.json({
        csrf: old.csrf,
        mode: config.mode ?? "codex",
        workspace: config.workspace,
      });
    if (sessions.size >= LIMITS.sessions)
      return res.status(429).json({ error: "本机会话过多，请稍后重试" });
    const sessionId = randomBytes(32).toString("hex");
    const csrf = randomBytes(32).toString("hex");
    sessions.set(sessionId, {
      csrf,
      expires: Date.now() + LIMITS.sessionMs,
      host: req.headers.host!,
    });
    res.setHeader(
      "Set-Cookie",
      `task_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${LIMITS.sessionMs / 1000}`,
    );
    res.json({
      csrf,
      mode: config.mode ?? "codex",
      workspace: config.workspace,
    });
  });
  app.use("/api", (req, res, next) => {
    // 校验网页会话及写请求的 CSRF 凭据，再转入 API 路由。
    const id = req.headers.cookie
      ?.split(";")
      .map(/* 去除每段 Cookie 前后的空白。 */ (c) => c.trim())
      .find(
        /* 提取用于 API 鉴权的会话 Cookie。 */ (c) =>
          c.startsWith("task_session="),
      )
      ?.slice(13);
    const s = id ? sessions.get(id) : undefined;
    if (!s || s.expires < Date.now() || s.host !== req.headers.host)
      return res.status(403).json({ error: "请刷新页面以建立本机会话" });
    if (
      req.method !== "GET" &&
      (req.headers.origin !== `http://${req.headers.host}` ||
        req.headers["x-csrf-token"] !== s.csrf)
    )
      return res.status(403).json({ error: "需要同源网页审批会话" });
    next();
  });
  app.get(
    "/api/tasks",
    /* 返回网页任务列表。 */ (_req, res) => res.json(store.list()),
  );
  app.get(
    "/api/harnesses",
    /* 返回当前在线的执行器及其能力。 */ (_req, res) =>
      res.json(service.harnesses()),
  );
  let browserCount = 0;
  app.get("/api/events", (req, res) => {
    // 建立网页 SSE 连接，合并变更通知并推送完整快照。
    const taskId = z.string().uuid().optional().parse(req.query.taskId);
    if (browserCount >= LIMITS.browserSubscribers)
      throw new AppError(429, "网页实时连接数量超限");
    browserCount++;
    let closed = false,
      blocked = false,
      dirty = false;
    let flush: NodeJS.Timeout | undefined;
    let slow: NodeJS.Timeout | undefined;
    res.status(200).set({
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.setTimeout(0);
    res.flushHeaders();
    /** 结束网页实时连接。 */
    const stop = () => res.end();
    /** 写入 SSE 帧，出现背压时暂停推送并为慢连接设置时限。 */
    const write = (text: string) => {
      if (!res.write(text)) {
        blocked = true;
        slow = setTimeout(stop, LIMITS.initMs);
      }
    };
    /** 推送任务、在线执行器、选中任务详情和待审批列表。 */
    const send = () => {
      flush = undefined;
      if (closed || blocked) return;
      dirty = false;
      const detail = taskId ? store.detail(taskId) : undefined;
      const snapshot = {
        tasks: store.list(),
        harnesses: service.harnesses(),
        detail: detail
          ? { ...detail, wakeup: store.browserWakeupSummary(detail.task.id) }
          : null,
        pendingApprovals: store.pendingApprovals(),
        serverTime: Date.now(),
      };
      write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    };
    /** 标记快照已过期，并将短时间内的变更合并为一次推送。 */
    const schedule = () => {
      dirty = true;
      if (!closed && !blocked && !flush)
        flush = setTimeout(send, LIMITS.browserFlushMs);
    };
    res.on("drain", () => {
      // 输出恢复可写后清除慢连接定时器，补发待更新快照。
      blocked = false;
      clearTimeout(slow);
      if (dirty) schedule();
    });
    const heartbeat = setInterval(() => {
      // 定期检查会话有效期，并在连接可写时发送心跳。
      const id = req.headers.cookie
        ?.split(";")
        .map(/* 清理每段 Cookie 的空白。 */ (c) => c.trim())
        .find(
          /* 找到要续查有效期的任务会话 Cookie。 */ (c) =>
            c.startsWith("task_session="),
        )
        ?.slice(13);
      if (!id || (sessions.get(id)?.expires ?? 0) < Date.now()) return stop();
      if (!closed && !blocked) write(": heartbeat\n\n");
    }, LIMITS.subscriptionHeartbeatMs);
    service.events.on("changed", schedule);
    service.events.on("close", stop);
    res.once("close", () => {
      // 释放网页连接名额、定时器与服务监听器。
      closed = true;
      browserCount--;
      clearTimeout(flush);
      clearTimeout(slow);
      clearInterval(heartbeat);
      service.events.off("changed", schedule);
      service.events.off("close", stop);
    });
    // Subscribe before the full SQLite snapshot; reconnect replaces browser state atomically.
    send();
  });
  app.post("/api/tasks", (req, res) => {
    // 从网页发布任务，记录发单回执并返回任务地址。
    const receipt = withTaskUrl(
      req,
      service.publish(publishTaskSchema.parse(req.body)),
    );
    taskMessage(
      store,
      store.taskMessageScope(receipt.taskId),
      "publisher",
      "send",
      "new.response",
      receipt,
    );
    res.status(201).json(receipt);
  });
  app.get("/api/tasks/:id", (req, res) => {
    // 读取任务详情与唤醒摘要，支持从指定序号读取通信。
    const seqAfter = z.coerce
      .number()
      .int()
      .nonnegative()
      .default(0)
      .parse(req.query.seqAfter);
    const d = store.detail(req.params.id, seqAfter);
    if (!d) throw new AppError(404, "任务不存在");
    res.json(d);
  });
  app.get("/api/tasks/:id/runs/:runId/audit", (req, res) => {
    // 校验运行归属和游标，分页返回运行审计与关联审批。
    const run = store.run(req.params.runId);
    if (!run || run.taskId !== req.params.id)
      throw new AppError(404, "任务运行不存在");
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(LIMITS.list)
      .default(LIMITS.list)
      .parse(req.query.limit);
    const cursor = z.string().optional().parse(req.query.cursor);
    let after = 0;
    if (cursor !== undefined) {
      const [runId, seq, extra] = cursor.split(":");
      if (
        runId !== run.id ||
        !seq ||
        !/^\d+$/.test(seq) ||
        !Number.isSafeInteger(Number(seq)) ||
        extra !== undefined
      )
        throw new AppError(400, "审计游标无效或不属于本次运行");
      after = Number(seq);
    }
    const rows = store.runAudit(run.id, after, limit + 1);
    const entries = rows.slice(0, limit);
    const last = entries.at(-1);
    res.json({
      runId: run.id,
      entries,
      approvals: store
        .approvals(run.id)
        .filter(
          /* 仅返回属于当前执行会话的审批记录。 */ (approval) =>
            approval.sessionId === run.sessionId,
        ),
      nextCursor: rows.length > limit && last ? `${run.id}:${last.seq}` : null,
    });
  });
  app.post("/api/tasks/:id/cancel", (req, res) => {
    // 处理网页取消请求，并记录该操作的任务通信。
    const taskId = req.params.id;
    res.json(
      taskExchange(
        store,
        store.taskMessageScope(taskId),
        "publisher",
        "cancel",
        { taskId },
        () => {
          // 取消任务并返回操作确认。
          service.cancel(taskId);
          return { ok: true };
        },
      ),
    );
  });
  app.post("/api/tasks/:id/retry", (req, res) => {
    // 处理网页重试请求，并记录该操作的任务通信。
    const taskId = req.params.id;
    res.json(
      taskExchange(
        store,
        store.taskMessageScope(taskId),
        "publisher",
        "retry",
        { taskId },
        /* 重新排队当前任务轮次并返回任务 ID。 */ () => service.retry(taskId),
      ),
    );
  });
  app.post("/api/approvals/:id/decision", (req, res) => {
    // 校验并处理网页用户的审批决定，保留对应任务轮次的记录。
    const approvalId = req.params.id;
    const decision = decisionSchema.parse(req.body);
    const approval = store.approval(approvalId);
    res.json(
      taskExchange(
        store,
        approval && store.runMessageScope(approval.runId),
        "publisher",
        "approval.decision",
        { approvalId, ...decision },
        () => {
          // 提交用户的审批选择并返回确认。
          service.decide(approvalId, decision);
          return { ok: true };
        },
      ),
    );
  });
  app.use("/subscriber", (req, res, next) => {
    // 拦截带浏览器来源标记的任务订阅请求。
    if (
      req.headers.origin !== undefined ||
      req.headers["sec-fetch-site"] !== undefined
    )
      return res.status(403).json({ error: "任务订阅接口仅供本机客户端使用" });
    next();
  });
  let taskSubscriberCount = 0;
  app.get("/subscriber/events", (req, res) => {
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
  });
  /** 校验订阅者凭据，并按审批所属运行记录发起方的审批意见。 */
  function subscriberDecision(input: z.infer<typeof subscriberDecisionSchema>) {
    service.requireSubscriber(input);
    const approval = store.approval(input.approvalId);
    const scope =
      approval?.taskId === input.taskId
        ? store.runMessageScope(approval.runId)
        : store.taskMessageScope(input.taskId);
    return taskExchange(
      store,
      scope,
      "publisher",
      "approval.decision",
      input,
      () => {
        // 保存订阅者的审批选择并返回确认。
        service.decideSubscriber(input);
        return { ok: true };
      },
    );
  }
  app.post("/subscriber/decision", (req, res) => {
    // 接收本机客户端通过 HTTP 提交的订阅审批决定。
    res.json(subscriberDecision(subscriberDecisionSchema.parse(req.body)));
  });
  app.use(
    "/subscriber",
    /* 为未匹配的任务订阅路径返回 404。 */ (_req, res) =>
      res.status(404).json({ error: "审批订阅接口不存在" }),
  );
  // Connector transport is separate from MCP and browser sessions; trusted local CLI only.
  app.use("/connector", (req, res, next) => {
    // 拦截带浏览器来源标记的连接器请求。
    if (
      req.headers.origin !== undefined ||
      req.headers["sec-fetch-site"] !== undefined
    )
      return res.status(403).json({ error: "订阅接口仅供本机连接器使用" });
    next();
  });
  let subscriberCount = 0;
  app.get("/connector/events", (req, res) => {
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
  });
  app.post("/connector/capabilities", (req, res) => {
    // 更新当前连接器代次的能力快照。
    service.reportCapabilities(capabilityReportSchema.parse(req.body));
    res.json({ accepted: true });
  });
  app.post("/connector/claim", (req, res) => {
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
  app.post("/connector/runs/:id/heartbeat", (req, res) => {
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
  app.post("/connector/runs/:id/report", (req, res) => {
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
  });
  app.post("/connector/runs/:id/permissions", (req, res) => {
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
  app.post("/connector/runs/:id/permissions/:approvalId/result", (req, res) => {
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
  });
  app.use(
    "/connector",
    /* 为未匹配的连接器路径返回 404。 */ (_req, res) =>
      res.status(404).json({ error: "连接器接口不存在" }),
  );
  app.post("/mcp", async (req, res) => {
    // 为当前请求创建无会话的 MCP 服务，注册工具并处理请求。
    const mcp = new McpServer({ name: "task-platform-mvp", version: "0.2.0" });
    mcp.registerTool(
      publishTaskToolName,
      {
        title: "发布任务",
        description:
          taskCommandDescription +
          "发布任务并立即返回回执。resultSubscription 用于订阅执行结果。approvalTargets 默认 [subscriber]，也可 [] 由用户在明庭审批。订阅者审批沿用 approvalSubscription。",
        inputSchema: mcpTaskCommandSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (input, extra) => {
        // 处理 MCP 新建或追加发单，按宿主上下文鉴权并记录回执。
        let failedAppend: TaskMessageScope | undefined;
        try {
          const raw = extra._meta?.[publisherContextKey];
          if (raw !== undefined && !dshHost)
            throw new AppError(503, "明庭尚未配置 KMH 宿主");
          const publisher =
            raw === undefined ? undefined : dshHost?.publisher(req, raw);
          if (
            input.action === "append" &&
            input.taskId &&
            publisher &&
            service.isOriginalPublisher(input.taskId, publisher)
          )
            failedAppend = store.taskMessageScope(input.taskId);
          const result = withTaskUrl(
            req,
            service.publishCommand(input, publisher),
          );
          const scope =
            result.taskTurn === undefined
              ? undefined
              : { taskId: result.taskId, taskTurn: result.taskTurn };
          taskMessage(
            store,
            scope,
            "publisher",
            "send",
            input.action === "append" ? "append.response" : "new.response",
            result,
          );
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (e) {
          if (failedAppend && e instanceof AppError) {
            taskMessage(
              store,
              failedAppend,
              "publisher",
              "receive",
              "append",
              input,
            );
            taskMessage(
              store,
              failedAppend,
              "publisher",
              "send",
              "append.response",
              { error: e.message },
            );
          }
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: e instanceof AppError ? e.message : "任务发布失败",
              },
            ],
          };
        }
      },
    );
    mcp.registerTool(
      "list_harnesses",
      {
        title: "在线 Harness",
        description: "查询通过常驻 SSE 订阅登记的在线 harness 身份。",
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        // 返回通过常驻订阅登记的在线执行器和能力。
        const result = { harnesses: service.harnesses() };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      },
    );
    /** 将审批相关错误转换成 MCP 工具结果，隐藏内部错误细节。 */
    const toolError = (error: unknown) => ({
      isError: true,
      content: [
        {
          type: "text" as const,
          text: error instanceof AppError ? error.message : "审批请求失败",
        },
      ],
    });
    mcp.registerTool(
      "wait_for_approval",
      {
        title: "订阅任务审批",
        description: `使用 ${publishTaskToolName} 返回的 approvalSubscription 等待审批（每次最多25秒）。检查完整工具上下文并调用 submit_approval_decision；任务仍活动时持续等待。已提交意见的审批会保留在快照中。`,
        inputSchema: approvalWaitSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input, extra) => {
        // 鉴权后限时等待可处理的审批或任务结束，并记录请求和响应。
        let scope: TaskMessageScope | undefined;
        try {
          service.requireSubscriber(input);
          scope = store.taskMessageScope(input.taskId);
          taskMessage(store, scope, "publisher", "receive", "approval.wait", {
            waitMs: input.waitMs,
          });
          const result = await service.waitForApproval(
            input,
            input.waitMs,
            extra.signal,
          );
          taskMessage(
            store,
            scope,
            "publisher",
            "send",
            "approval.wait.response",
            result,
          );
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (error) {
          taskMessage(
            store,
            scope,
            "publisher",
            "send",
            "approval.wait.response",
            {
              error: error instanceof AppError ? error.message : "审批请求失败",
            },
          );
          return toolError(error);
        }
      },
    );
    mcp.registerTool(
      "submit_approval_decision",
      {
        title: "提交订阅者审批意见",
        description:
          "发起方使用任务专属订阅凭据和原始 ACP optionId 提交同意或拒绝。平台保留10秒用户决定窗口；用户决定优先。相同意见重试保持原截止时间。",
        inputSchema: subscriberDecisionSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (input) => {
        // 通过 MCP 提交发起方的审批意见。
        try {
          const result = subscriberDecision(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (error) {
          return toolError(error);
        }
      },
    );
    mcp.registerTool(
      "get_wakeup_status",
      {
        description:
          "检查当前平台的聊天事件唤醒宿主是否已接通。通过后可在发布时绑定当前threadId和originTurnId，发布后结束回合。",
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        // 返回聊天唤醒宿主的可用状态。
        const result = service.wakeupStatus();
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      },
    );
    mcp.registerTool(
      "get_task_wakeups",
      {
        description:
          "使用发起方审批订阅凭据读取此任务的聊天目标、持久事件、投递及恢复确认记录。",
        inputSchema: approvalSubscriptionSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input) => {
        // 鉴权后列出订阅任务的 Codex 唤醒目标与事件。
        try {
          const result = service.taskWakeups(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (error) {
          return toolError(error);
        }
      },
    );
    mcp.registerTool(
      "acknowledge_task_wakeup",
      {
        description:
          "收到平台事件并恢复新回合后，记录当前threadId、turnId与事件ID；两类事件各自确认独立回合。真实验收还需宿主聊天记录。",
        inputSchema: approvalSubscriptionSchema
          .extend(wakeupAcknowledgementSchema.shape)
          .strict(),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input) => {
        // 通过 MCP 确认原会话新回合已接收唤醒，并记录通信。
        try {
          const { taskId, subscriptionToken, ...ack } = input;
          const subscription = { taskId, subscriptionToken };
          const event = service
            .taskWakeups(subscription)
            .events.find(
              /* 按回执的事件 ID 定位所属运行。 */ (event) =>
                event.id === ack.eventId,
            );
          const result = taskExchange(
            store,
            event && store.runMessageScope(event.runId),
            "publisher",
            "wakeup.ack",
            ack,
            /* 校验并保存唤醒回执，关联该运行的通信轮次。 */ () =>
              service.acknowledgeWakeup(subscription, ack),
          );
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (error) {
          return toolError(error);
        }
      },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.once("close", () => {
      // 响应关闭时释放本次请求的 MCP 传输和服务。
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.all(
    "/mcp",
    /* 拒绝 MCP 路径上的非 POST 请求。 */ (_req, res) =>
      res.status(405).json({ error: "仅支持 MCP Streamable HTTP POST" }),
  );
  app.use(
    "/api",
    /* 为未匹配的网页 API 返回 JSON 404。 */ (_req, res) =>
      res.status(404).json({ error: "接口不存在" }),
  );
  app.get(
    "/approval-tests/data/history.json",
    /* 读取并返回审批回归归档的历史清单。 */ async (_req, res) =>
      res.json(await readApprovalHistory(resolve("reports/approval-e2e"))),
  );
  app.use(
    "/approval-tests/data",
    express.static(resolve("reports/approval-e2e"), {
      index: "index.html",
      dotfiles: "deny",
      fallthrough: false,
    }),
  );
  app.use(
    express.static(resolve("dist/web"), {
      index: "index.html",
      dotfiles: "deny",
    }),
  );
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      // 统一映射业务、输入校验、请求体超限和内部错误。
      if (res.headersSent) return;
      const status =
        err instanceof AppError
          ? err.status
          : err instanceof ZodError
            ? 400
            : (err as { status?: number })?.status === 413
              ? 413
              : 500;
      res.status(status).json({
        error:
          err instanceof AppError
            ? err.message
            : status === 400
              ? "输入格式不正确"
              : status === 413
                ? "请求内容过大"
                : "服务错误",
      });
    },
  );
  return { app, service, store };
}
