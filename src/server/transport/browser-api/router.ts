import { Router } from "express";
import { z } from "zod";
import {
  decisionSchema,
  LIMITS,
  publishTaskSchema,
} from "../../../shared/protocol.js";
import { AppError, type TaskService } from "../../tasks/service.js";
import { taskExchange, taskMessage } from "../task-communication.js";
import { withTaskUrl } from "../task-url.js";
import { browserEvents } from "./events.js";
import { browserSession } from "./session.js";

/** 挂载网页会话、任务查询与操作，以及实时快照。 */
export function browserApiRouter(
  service: TaskService,
  workspace: string,
  mode: "fake" | "codex",
) {
  const router = Router();
  const { store } = service;
  const session = browserSession(workspace, mode);
  router.get("/api/bootstrap", session.bootstrap);
  router.use("/api", session.requireSession);
  router.get(
    "/api/tasks",
    /* 返回网页任务列表。 */ (_req, res) => res.json(store.list()),
  );
  router.get(
    "/api/harnesses",
    /* 返回当前在线的执行器及其能力。 */ (_req, res) =>
      res.json(service.harnesses()),
  );
  router.get("/api/events", browserEvents(service, session.isActive));
  router.post("/api/tasks", (req, res) => {
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
  router.get("/api/tasks/:id", (req, res) => {
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
  router.get("/api/tasks/:id/runs/:runId/audit", (req, res) => {
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
  router.post("/api/tasks/:id/cancel", (req, res) => {
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
  router.post("/api/tasks/:id/retry", (req, res) => {
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
  router.post("/api/approvals/:id/decision", (req, res) => {
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
  router.use(
    "/api",
    /* 为未匹配的网页 API 返回 JSON 404。 */ (_req, res) =>
      res.status(404).json({ error: "接口不存在" }),
  );
  return router;
}
