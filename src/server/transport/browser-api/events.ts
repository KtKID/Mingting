import type { Request, RequestHandler } from "express";
import { z } from "zod";
import { LIMITS } from "../../../shared/protocol.js";
import { AppError, type TaskService } from "../../tasks/service.js";
import { releaseShortRequestSlot } from "../http-middleware.js";

/** 合并任务变更，通过 SSE 推送网页所需的完整快照。 */
export function browserEvents(
  service: TaskService,
  sessionIsActive: (req: Request) => boolean,
): RequestHandler {
  const { store } = service;
  let browserCount = 0;
  return (req, res) => {
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
      if (!sessionIsActive(req)) return stop();
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
    releaseShortRequestSlot(res);
  };
}
