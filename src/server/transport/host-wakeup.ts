import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Router, type Request } from "express";
import { z } from "zod";
import {
  hostAckSchema,
  hostCompletionSchema,
  hostPublisherContextSchema,
} from "../../shared/host-wakeup.js";
import { LIMITS, type Run } from "../../shared/protocol.js";
import { AppError, type TaskService } from "../tasks/service.js";
import { releaseShortRequestSlot } from "./http-middleware.js";
import { taskExchange, taskMessage } from "./task-communication.js";

// 通用宿主协议的单帧上限，单位为 UTF-16 代码单元。
const maxHostFrameLength = 16_384;

/** 生成完成事件帧，逐步缩短结果文本以满足宿主的 SSE 帧上限。 */
function completionFrame(
  event: Omit<z.input<typeof hostCompletionSchema>, "result">,
  run: Run | undefined,
  textLimit: number,
) {
  for (let limit = textLimit; ; limit = Math.floor(limit / 2)) {
    const completion = hostCompletionSchema.parse({
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
export type HostWakeupHost = z.infer<typeof hostSchema>;

const hostConfigSchema = hostSchema.omit({ token: true }).extend({
  tokenFile: z.string().min(1),
});

/** 从本机宿主清单和各宿主的令牌文件读取配置。 */
export function configuredWakeupHosts(env: NodeJS.ProcessEnv = process.env) {
  const file = env.MINGTING_WAKEUP_HOSTS_FILE;
  if (!file) return [];
  const entries = z
    .array(hostConfigSchema)
    .parse(JSON.parse(readFileSync(file, "utf8")));
  return entries.map(({ hostId, tokenFile }) =>
    hostSchema.parse({
      hostId,
      token: readFileSync(resolve(dirname(file), tokenFile), "utf8").trim(),
    }),
  );
}

/** 提供宿主事件订阅、确认及 MCP 发布认证。 */
export function hostWakeupRouter(
  service: TaskService,
  config: HostWakeupHost[],
  resultTextLimit: number,
) {
  const router = Router();
  const hosts = z.array(hostSchema).parse(config);
  if (
    new Set(hosts.map((host) => host.hostId)).size !== hosts.length ||
    new Set(hosts.map((host) => host.token)).size !== hosts.length
  )
    throw new Error("唤醒宿主 ID 和令牌必须各自唯一");
  const credentials = hosts.map((host) => ({
    ...host,
    digest: createHash("sha256").update(`Bearer ${host.token}`).digest(),
  }));
  const connected = new Set<string>();
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
    const host = credentials.find(({ digest }) =>
      timingSafeEqual(digest, actual),
    );
    if (!host) throw new AppError(401, "唤醒宿主认证失败");
    return host;
  };
  /** 校验宿主和发单上下文，并从发单请求 ID 派生结果订阅令牌。 */
  const publisher = (req: Request, raw: unknown) => {
    const { hostId, token } = requireHost(req);
    const parsed = hostPublisherContextSchema.safeParse(raw);
    if (!parsed.success) throw new AppError(400, "发单会话或轮次无效");
    const source = parsed.data;
    return {
      hostId,
      source,
      connected: connected.has(hostId),
      subscriptionToken: createHmac("sha256", token)
        .update(`mingting-result:${source.publishRequestId}`)
        .digest("hex"),
    };
  };
  router.get("/events", (req, res) => {
    // 建立宿主独占的 SSE 连接，推送待确认事件并维持心跳。
    const { hostId } = requireHost(req);
    if (connected.has(hostId))
      throw new AppError(409, "该宿主已连接完成事件流");
    connected.add(hostId);
    let lastSent: string | undefined;
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });
    res.setTimeout(0);
    /** 结束宿主的 SSE 响应。 */
    const stop = () => res.end();
    /** 构造完成事件，避免在同一连接中重复发送当前事件。 */
    const sendEvent = () => {
      if (res.writableEnded || res.destroyed) return;
      const event = service.store.pendingHostWakeup(hostId);
      if (!event || lastSent === event.id) return;
      const run = service.store.run(event.runId);
      const { frame, completion } = completionFrame(
        {
          eventId: event.id,
          taskId: event.taskId,
          runId: event.runId,
          sessionId: event.target.sessionId,
          completedAt: event.createdAt,
          ...(run?.taskTurn !== undefined ? { taskTurn: run.taskTurn } : {}),
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
      connected.delete(hostId);
      clearInterval(heartbeat);
      service.events.off("changed", send);
      service.events.off("close", stop);
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ hostId })}\n\n`);
    send();
    releaseShortRequestSlot(res);
  });

  router.post("/ack", (req, res) => {
    // 校验宿主回执，并按会话归属关联任务通信记录。
    const { hostId } = requireHost(req);
    const ack = hostAckSchema.parse(req.body);
    const event = service.store.hostWakeup(ack.eventId, hostId);
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
          service.acknowledgeHostWakeup(hostId, ack),
      ),
    );
  });
  return { router, publisher };
}
