import express from "express";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { z, ZodError } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  LIMITS,
  publishTaskSchema,
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
} from "../shared/protocol.js";
import { Store } from "./store.js";
import { TaskService, AppError } from "./service.js";
import { readApprovalHistory } from "./approval-history.js";
import type { WakeupDelivery } from "./task-wakeup.js";
import { dshWakeupRouter, type DshWakeupHost } from "./dsh-wakeup.js";
import { wakeupAcknowledgementSchema } from "../shared/task-wakeup.js";

type Config = {
  dbPath: string;
  workspace: string;

  mode?: "fake" | "codex";
  wakeupDelivery?: WakeupDelivery;
  dshWakeupHost?: DshWakeupHost;
};
export function createPlatform(config: Config) {
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
  if (config.dshWakeupHost)
    app.use("/wakeup-host", dshWakeupRouter(service, config.dshWakeupHost));
  app.get("/api/bootstrap", (req, res) => {
    for (const [key, value] of sessions)
      if (value.expires < Date.now()) sessions.delete(key);
    const id = req.headers.cookie
      ?.split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("task_session="))
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
    const id = req.headers.cookie
      ?.split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("task_session="))
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
  app.get("/api/tasks", (_req, res) => res.json(store.list()));
  app.get("/api/harnesses", (_req, res) => res.json(service.harnesses()));
  let browserCount = 0;
  app.get("/api/events", (req, res) => {
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
    const stop = () => res.end();
    const write = (text: string) => {
      if (!res.write(text)) {
        blocked = true;
        slow = setTimeout(stop, LIMITS.initMs);
      }
    };
    const send = () => {
      flush = undefined;
      if (closed || blocked) return;
      dirty = false;
      const detail = taskId ? store.detail(taskId) : undefined;
      const target = detail && store.wakeupTarget(detail.task.id);
      const wakeup =
        target && detail
          ? {
              target,
              events: store
                .taskWakeups(detail.task.id)
                .map(({ id, type, status }) => ({ id, type, status })),
            }
          : undefined;
      const snapshot = {
        tasks: store.list(),
        harnesses: service.harnesses(),
        detail: detail ? { ...detail, wakeup } : null,
        pendingApprovals: store.pendingApprovals(),
        serverTime: Date.now(),
      };
      write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    };
    const schedule = () => {
      dirty = true;
      if (!closed && !blocked && !flush)
        flush = setTimeout(send, LIMITS.browserFlushMs);
    };
    res.on("drain", () => {
      blocked = false;
      clearTimeout(slow);
      if (dirty) schedule();
    });
    const heartbeat = setInterval(() => {
      const id = req.headers.cookie
        ?.split(";")
        .map((c) => c.trim())
        .find((c) => c.startsWith("task_session="))
        ?.slice(13);
      if (!id || (sessions.get(id)?.expires ?? 0) < Date.now()) return stop();
      if (!closed && !blocked) write(": heartbeat\n\n");
    }, LIMITS.subscriptionHeartbeatMs);
    service.events.on("changed", schedule);
    service.events.on("close", stop);
    res.once("close", () => {
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
  app.post("/api/tasks", (req, res) =>
    res.status(201).json(service.publish(publishTaskSchema.parse(req.body))),
  );
  app.get("/api/tasks/:id", (req, res) => {
    const d = store.detail(req.params.id);
    if (!d) throw new AppError(404, "任务不存在");
    res.json(d);
  });
  app.get("/api/tasks/:id/runs/:runId/audit", (req, res) => {
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
        .filter((approval) => approval.sessionId === run.sessionId),
      nextCursor: rows.length > limit && last ? `${run.id}:${last.seq}` : null,
    });
  });
  app.post("/api/tasks/:id/cancel", (req, res) => {
    service.cancel(req.params.id);
    res.json({ ok: true });
  });
  app.post("/api/tasks/:id/retry", (req, res) =>
    res.json(service.retry(req.params.id)),
  );
  app.post("/api/approvals/:id/decision", (req, res) => {
    service.decide(req.params.id, decisionSchema.parse(req.body));
    res.json({ ok: true });
  });
  app.use("/subscriber", (req, res, next) => {
    if (
      req.headers.origin !== undefined ||
      req.headers["sec-fetch-site"] !== undefined
    )
      return res.status(403).json({ error: "审批订阅接口仅供本机客户端使用" });
    next();
  });
  let approvalSubscriberCount = 0;
  app.get("/subscriber/events", (req, res) => {
    const subscription = approvalSubscriptionSchema.parse({
      taskId: req.query.taskId,
      subscriptionToken: z
        .string()
        .regex(/^Bearer [a-f0-9]{64}$/)
        .parse(req.headers.authorization)
        .slice(7),
    });
    service.approvalSnapshot(subscription);
    if (approvalSubscriberCount >= LIMITS.subscribers)
      throw new AppError(429, "审批订阅数量超限");
    approvalSubscriberCount++;
    let previous = "";
    res.status(200).set({
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.setTimeout(0);
    res.flushHeaders();
    const stop = () => res.end();
    const send = () => {
      if (res.writableEnded) return;
      const data = JSON.stringify(service.approvalSnapshot(subscription));
      if (data === previous) return;
      previous = data;
      if (!res.write(`event: approval.snapshot\ndata: ${data}\n\n`)) stop();
    };
    const heartbeat = setInterval(() => {
      if (!res.write(": heartbeat\n\n")) stop();
    }, LIMITS.subscriptionHeartbeatMs);
    service.events.on("changed", send);
    service.events.once("close", stop);
    res.once("close", () => {
      approvalSubscriberCount--;
      clearInterval(heartbeat);
      service.events.off("changed", send);
      service.events.off("close", stop);
    });
    // Pending approvals are durable; a reconnect starts with the current task snapshot.
    send();
  });
  app.post("/subscriber/decision", (req, res) => {
    service.decideSubscriber(subscriberDecisionSchema.parse(req.body));
    res.json({ ok: true });
  });
  app.use("/subscriber", (_req, res) =>
    res.status(404).json({ error: "审批订阅接口不存在" }),
  );
  // Connector transport is separate from MCP and browser sessions; trusted local CLI only.
  app.use("/connector", (req, res, next) => {
    if (
      req.headers.origin !== undefined ||
      req.headers["sec-fetch-site"] !== undefined
    )
      return res.status(403).json({ error: "订阅接口仅供本机连接器使用" });
    next();
  });
  let subscriberCount = 0;
  app.get("/connector/events", (req, res) => {
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
      : () => {};
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
    const send = (event: DeliveryEvent) => {
      if (closed || event.id <= cursor) return;
      cursor = event.id;
      const target = store.task(event.taskId)?.targetHarness;
      if (
        identity &&
        target &&
        target.toLowerCase() !== identity.harnessName.toLowerCase()
      )
        return;
      const writable = res.write(
        `id: ${event.id}\nevent: task.available\ndata: ${JSON.stringify(event)}\n\n`,
      );
      if (!writable) res.end();
    };
    const stop = () => res.end();
    const heartbeat = setInterval(() => {
      if (!res.write(": heartbeat\n\n")) res.end();
    }, LIMITS.subscriptionHeartbeatMs);
    service.events.on("available", send);
    service.events.on("close", stop);
    res.once("close", () => {
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
    service.reportCapabilities(capabilityReportSchema.parse(req.body));
    res.json({ accepted: true });
  });
  app.post("/connector/claim", (req, res) => {
    const { taskId, generation, ...owner } = claimTaskSchema
      .extend({ generation: z.uuid().optional() })
      .parse(req.body);
    res.json(service.claim(taskId, owner, generation));
  });
  app.post("/connector/runs/:id/heartbeat", (req, res) =>
    res.json(service.heartbeat(req.params.id, ownerSchema.parse(req.body))),
  );
  app.post("/connector/runs/:id/report", (req, res) => {
    const body = reportSchema.parse(req.body);
    res.json(service.report(req.params.id, body, body.seq, body.update));
  });
  app.post("/connector/runs/:id/permissions", (req, res) => {
    const body = permissionSubmissionSchema.parse(req.body);
    res.json(
      service.permission(req.params.id, body, body.requestId, body.request),
    );
  });
  app.post("/connector/runs/:id/permissions/:approvalId/result", (req, res) =>
    res.json(
      service.permissionResult(
        req.params.id,
        ownerSchema.parse(req.body),
        req.params.approvalId,
      ),
    ),
  );
  app.use("/connector", (_req, res) =>
    res.status(404).json({ error: "连接器接口不存在" }),
  );
  app.post("/mcp", async (req, res) => {
    const mcp = new McpServer({ name: "task-platform-mvp", version: "0.2.0" });
    mcp.registerTool(
      "publish_task",
      {
        title: "发布任务",
        description:
          "发布任务；targetHarness 指定执行者。approvalTargets 默认 [subscriber]，也可 [] 仅由用户审批；third_party 尚在开发。返回的 approvalSubscription 仅供发起方保存，调用 wait_for_approval 接收审批、submit_approval_decision 提交意见。publisherName 为展示名。",
        inputSchema: publishTaskSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (input) => {
        try {
          const result = service.publish(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (e) {
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
        const result = { harnesses: service.harnesses() };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      },
    );
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
        description:
          "使用 publish_task 返回的 approvalSubscription 等待审批（每次最多25秒）。检查完整工具上下文并调用 submit_approval_decision；任务仍活动时持续等待。已提交意见的审批会保留在快照中。",
        inputSchema: approvalWaitSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input, extra) => {
        try {
          const result = await service.waitForApproval(
            input,
            input.waitMs,
            extra.signal,
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
        try {
          service.decideSubscriber(input);
          const result = { ok: true };
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
        try {
          const { taskId, subscriptionToken, ...ack } = input;
          const result = service.acknowledgeWakeup(
            { taskId, subscriptionToken },
            ack,
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
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.all("/mcp", (_req, res) =>
    res.status(405).json({ error: "仅支持 MCP Streamable HTTP POST" }),
  );
  app.use("/api", (_req, res) => res.status(404).json({ error: "接口不存在" }));
  app.get("/approval-tests/data/history.json", async (_req, res) =>
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
