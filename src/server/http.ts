import express from "express";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { ZodError } from "zod";
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
  type DeliveryEvent,
} from "../shared/protocol.js";
import { Store } from "./store.js";
import { TaskService, AppError } from "./service.js";

type Config = {
  dbPath: string;
  workspace: string;

  mode?: "fake" | "codex";
};
export function createPlatform(config: Config) {
  const store = new Store(config.dbPath);
  const service = new TaskService(
    store,
    config.workspace,
    config.mode ?? "codex",
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
  app.post("/api/tasks", (req, res) =>
    res.status(201).json(service.publish(publishTaskSchema.parse(req.body))),
  );
  app.get("/api/tasks/:id", (req, res) => {
    const d = store.detail(req.params.id);
    if (!d) throw new AppError(404, "任务不存在");
    res.json(d);
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
  app.post("/connector/claim", (req, res) => {
    const body = claimTaskSchema.parse(req.body);
    const { taskId, ...owner } = body;
    res.json(service.claim(taskId, owner));
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
          "发布任务到固定 Codex ACP 执行器。publisherName 仅供展示，不代表身份认证。",
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
