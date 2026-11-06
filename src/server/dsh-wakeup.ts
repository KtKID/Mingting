import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { Router } from "express";
import { z } from "zod";
import {
  dshAckSchema,
  dshCompletionSchema,
  dshPublishSchema,
} from "../shared/dsh-wakeup.js";
import { LIMITS } from "../shared/protocol.js";
import { AppError, type TaskService } from "./service.js";

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

export function dshWakeupRouter(service: TaskService, config: DshWakeupHost) {
  const router = Router();
  const { hostId, token } = hostSchema.parse(config);
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  let connected = false;
  router.use((req, _res, next) => {
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

  router.get("/events", (_req, res) => {
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
      const frame = dshCompletionSchema.parse({
        eventId: event.id,
        taskId: event.taskId,
        runId: event.runId,
        sessionId: event.target.sessionId,
        originTurn: event.target.originTurn,
        completedAt: event.createdAt,
      });
      lastSent = event.id;
      if (
        !res.write(`event: task.completed\ndata: ${JSON.stringify(frame)}\n\n`)
      )
        stop();
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
  return router;
}
