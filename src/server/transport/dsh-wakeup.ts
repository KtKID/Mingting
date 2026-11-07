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

// KMH's SSE reader accepts at most this many UTF-16 code units per frame.
const maxHostFrameLength = 16_384;

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
    if (frame.length <= maxHostFrameLength) return frame;
  }
}

const hostSchema = z.strictObject({
  hostId: z.uuid(),
  token: z.string().regex(/^[a-f0-9]{64}$/),
});
export type DshWakeupHost = z.infer<typeof hostSchema>;

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

export function dshWakeupRouter(
  service: TaskService,
  config: DshWakeupHost,
  resultTextLimit: number,
) {
  const router = Router();
  const { hostId, token } = hostSchema.parse(config);
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  let connected = false;
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
    requireHost(req);
    next();
  });

  router.post("/publish", (req, res) => {
    const result = service.publishFromDsh(
      hostId,
      dshPublishSchema.parse(req.body),
      connected,
    );
    res.status(result.created ? 201 : 200).json({ taskId: result.taskId });
  });

  router.get("/events", (req, res) => {
    if (connected) throw new AppError(409, "该宿主已连接完成事件流");
    connected = true;
    let lastSent: string | undefined;
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });
    res.setTimeout(0);
    const stop = () => res.end();
    const send = () => {
      if (res.writableEnded) return;
      const event = service.store.pendingDshWakeup(hostId);
      if (!event || lastSent === event.id) return;
      const run =
        req.headers[wakeupResultHeader] === "1"
          ? service.store.run(event.runId)
          : undefined;
      const frame = completionFrame(
        {
          eventId: event.id,
          taskId: event.taskId,
          runId: event.runId,
          sessionId: event.target.sessionId,
          originTurn: event.target.originTurn,
          completedAt: event.createdAt,
        },
        run,
        resultTextLimit,
      );
      lastSent = event.id;
      if (!res.write(frame)) stop();
    };
    const heartbeat = setInterval(() => {
      if (!res.write(": heartbeat\n\n")) stop();
    }, LIMITS.subscriptionHeartbeatMs);
    service.events.on("changed", send);
    service.events.once("close", stop);
    res.once("close", () => {
      connected = false;
      clearInterval(heartbeat);
      service.events.off("changed", send);
      service.events.off("close", stop);
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ hostId })}\n\n`);
    send();
  });

  router.post("/ack", (req, res) => {
    res.json(
      service.acknowledgeDshWakeup(hostId, dshAckSchema.parse(req.body)),
    );
  });
  return { router, publisher };
}
