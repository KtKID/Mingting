import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { Router, type Request } from "express";
import { z } from "zod";
import {
  dshAckSchema,
  dshCompletionSchema,
  dshPublishSchema,
  dshPublisherContextSchema,
  wakeupResultHeader,
} from "../../shared/dsh-wakeup.js";
import { LIMITS, type Run } from "../../shared/protocol.js";
import { AppError, type TaskService } from "../tasks/service.js";
import { taskExchange, taskMessage } from "./task-communication.js";

// KMH's SSE reader accepts at most this many UTF-16 code units per frame.
const maxHostFrameLength = 16_384;

/** 生成完成事件帧，逐步缩短结果文本以满足宿主的 SSE 帧上限。 */
function completionFrame(
  event: Omit<z.input<typeof dshCompletionSchema>, "result">,
  run: Run | undefined,
  textLimit: number,
) {
  for (let limit = textLimit; ; limit = Math.floor(limit / 2)) {
    const completion = dshCompletionSchema.parse({
      ...event,
      ...(run?.endedAt
        ? {
            result: {
              status: run.status,
              output: run.output.slice(0, limit),
              error: run.error?.slice(0, limit) ?? null,
              truncated:
                run.output.length > limit || (run.error?.length ?? 0) > limit,
            },
          }
        : {}),
    });
    const frame = `event: task.completed\ndata: ${JSON.stringify(completion)}\n\n`;
    // JSON escaping can expand the result past the peer's frame limit.
    if (frame.length <= maxHostFrameLength) return { frame, completion };
  }
}

const hostSchema = z.strictObject({
  hostId: z.uuid(),
  token: z.string().regex(/^[a-f0-9]{64}$/),
});
export type DshWakeupHost = z.infer<typeof hostSchema>;

/** 从环境变量和令牌文件读取并校验 DSH 唤醒宿主配置。 */
export function configuredDshWakeupHost(env: NodeJS.ProcessEnv = process.env) {
  if (!env.MINGTING_DSH_HOST_ID && !env.MINGTING_DSH_TOKEN_FILE)
    return undefined;
  return hostSchema.parse({
    hostId: env.MINGTING_DSH_HOST_ID,
    token: readFileSync(
      z.string().min(1).parse(env.MINGTING_DSH_TOKEN_FILE),
      "utf8",
    ).trim(),
  });
}

/** 创建 DSH 宿主专用的发单、事件订阅及确认路由。 */
export function dshWakeupRouter(
  service: TaskService,
  config: DshWakeupHost,
  resultTextLimit: number,
) {
  const router = Router();
  const { hostId, token } = hostSchema.parse(config);
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  let connected = false;
  /** 拒绝带浏览器来源标记的请求，并以恒定时间比较宿主令牌摘要。 */
  const requireHost = (req: Request) => {
    if (
      req.headers.origin !== undefined ||
      req.headers["sec-fetch-site"] !== undefined
    )
      throw new AppError(403, "宿主事件接口仅供本机客户端使用");
    const actual = createHash("sha256")
      .update(req.headers.authorization ?? "")
      .digest();
    if (!timingSafeEqual(expected, actual))
      throw new AppError(401, "DSH 宿主认证失败");
  };
  /** 校验宿主和发单上下文，并从发单请求 ID 派生结果订阅令牌。 */
  const publisher = (req: Request, raw: unknown) => {
    requireHost(req);
    const parsed = dshPublisherContextSchema.safeParse(raw);
    if (!parsed.success) throw new AppError(400, "KMH 发单会话或轮次无效");
    const source = parsed.data;
    return {
      hostId,
      source,
      connected,
      subscriptionToken: createHmac("sha256", token)
        .update(`mingting-result:${source.publishRequestId}`)
        .digest("hex"),
    };
  };
  router.use((req, _res, next) => {
    // 对宿主路由统一执行认证，再进入具体处理器。
    requireHost(req);
    next();
  });

  router.post("/publish", (req, res) => {
    // 处理旧版 DSH 发单请求，记录回执并区分首次发布和重复请求。
    const result = service.publishFromDsh(
      hostId,
      dshPublishSchema.parse(req.body),
      connected,
    );
    const receipt = { taskId: result.taskId };
    const scope =
      result.taskTurn === undefined
        ? undefined
        : { ...receipt, taskTurn: result.taskTurn };
    taskMessage(
      service.store,
      scope,
      "publisher",
      "send",
      "new.response",
      receipt,
    );
    res.status(result.created ? 201 : 200).json(receipt);
  });

  router.get("/events", (req, res) => {
    // 建立宿主独占的 SSE 连接，推送待确认事件并维持心跳。
    if (connected) throw new AppError(409, "该宿主已连接完成事件流");
    connected = true;
    let lastSent: string | undefined;
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });
    res.setTimeout(0);
    /** 结束宿主的 SSE 响应。 */
    const stop = () => res.end();
    /** 按宿主版本构造完成事件，避免在同一连接中重复发送当前事件。 */
    const sendEvent = () => {
      if (res.writableEnded || res.destroyed) return;
      const event = service.store.pendingDshWakeup(hostId);
      if (!event || lastSent === event.id) return;
      const version = req.headers[wakeupResultHeader];
      const run =
        version === "1" || version === "2"
          ? service.store.run(event.runId)
          : undefined;
      const { frame, completion } = completionFrame(
        {
          eventId: event.id,
          taskId: event.taskId,
          runId: event.runId,
          sessionId: event.target.sessionId,
          originTurn: event.target.originTurn,
          completedAt: event.createdAt,
          ...(version === "2" && run?.taskTurn !== undefined
            ? { taskTurn: run.taskTurn }
            : {}),
        },
        run,
        resultTextLimit,
      );
      lastSent = event.id;
      taskMessage(
        service.store,
        service.store.runMessageScope(event.runId),
        "publisher",
        "send",
        "wakeup",
        completion,
      );
      if (!res.write(frame)) stop();
    };
    /** 尝试发送待确认事件，构造或发送失败时关闭连接。 */
    const send = () => {
      try {
        sendEvent();
      } catch {
        stop();
      }
    };
    const heartbeat = setInterval(() => {
      // 定期发送心跳，输出出现背压时关闭连接。
      if (!res.write(": heartbeat\n\n")) stop();
    }, LIMITS.subscriptionHeartbeatMs);
    service.events.on("changed", send);
    service.events.once("close", stop);
    res.once("close", () => {
      // 释放宿主连接标记、心跳定时器和服务事件监听器。
      connected = false;
      clearInterval(heartbeat);
      service.events.off("changed", send);
      service.events.off("close", stop);
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ hostId })}\n\n`);
    send();
  });

  router.post("/ack", (req, res) => {
    // 校验宿主回执，并按会话归属关联任务通信记录。
    const ack = dshAckSchema.parse(req.body);
    const event = service.store.dshWakeup(ack.eventId, hostId);
    const scope =
      event?.target.sessionId === ack.sessionId
        ? service.store.runMessageScope(event.runId)
        : undefined;
    res.json(
      taskExchange(
        service.store,
        scope,
        "publisher",
        "wakeup.ack",
        ack,
        /* 将确认结果写回对应宿主的完成事件。 */ () =>
          service.acknowledgeDshWakeup(hostId, ack),
      ),
    );
  });
  return { router, publisher };
}
