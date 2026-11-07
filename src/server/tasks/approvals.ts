import { randomUUID } from "node:crypto";
import type {
  JsonRpcId,
  RequestPermissionRequest,
} from "@agentclientprotocol/sdk";
import { approvalPrompt } from "../../shared/approval.js";
import {
  LIMITS,
  type Approval,
  type Decision,
  type Run,
  type SubscriberDecision,
} from "../../shared/protocol.js";
import { validateAcp } from "../harness/acp/acp-validation.js";
import type { Store } from "../storage/store.js";
import { AppError } from "./app-error.js";

const now = () => new Date().toISOString();

/** 将待处理审批标记为过期，与调用方的运行状态更新一并提交。 */
export function expireRunApprovals(store: Store, runId: string) {
  for (const a of store.approvals(runId))
    if (a.status === "pending") {
      a.status = "expired";
      store.saveApproval(a);
    }
}

export class TaskApprovals {
  constructor(
    private store: Store,
    private cancelTask: (taskId: string, reason: string) => void,
  ) {}

  /** 验证 ACP 审批请求，复用相同请求 ID，并限制单次运行的审批数量。 */
  permission(r: Run, requestId: JsonRpcId, request: RequestPermissionRequest) {
    const runId = r.id;
    if (r.status === "cancelled") throw new AppError(410, "运行已取消");
    if (
      !validateAcp("RequestPermissionRequest", request) ||
      request.sessionId !== r.sessionId
    )
      throw new AppError(400, "ACP 审批结构无效或会话不匹配");
    const previous = this.store.approvals(runId);
    const existing = previous.find(
      /* 按 ACP 请求 ID 查找已登记的审批。 */ (a) => a.requestId === requestId,
    );
    if (existing) {
      if (JSON.stringify(existing.request) !== JSON.stringify(request))
        throw new AppError(409, "重复审批 ID 的内容不同");
      return { approvalId: existing.id };
    }
    if (
      previous.length >= LIMITS.approvalsPerRun ||
      previous.filter(
        /* 只统计仍待处理的审批，检查并行积压上限。 */ (a) =>
          a.status === "pending",
      ).length >= LIMITS.pendingApprovals
    ) {
      this.cancelTask(r.taskId, "审批请求数量超限");
      throw new AppError(410, "审批请求数量超限");
    }
    const a: Approval = {
      id: randomUUID(),
      taskId: r.taskId,
      runId,
      sessionId: request.sessionId,
      requestId,
      request,
      prompt: approvalPrompt(
        request,
        r.tools.find(
          /* 定位对应工具的进度记录，用于生成审批提示。 */ (tool) =>
            tool.id === request.toolCall.toolCallId,
        ),
      ),
      status: "pending" as const,
      optionId: null,
      createdAt: now(),
      reviewerDecisions: [],
      userDecision: null,
      fallbackAt: null,
      resolvedBy: null,
    };
    r.status = "awaiting_approval";
    const t = this.store.task(r.taskId)!;
    t.status = "awaiting_approval";
    this.store.transaction(() => {
      // 在同一事务保存新审批和任务、运行的等待状态。
      this.store.saveApproval(a);
      this.store.saveRun(r);
      this.store.saveTask(t);
    });
    return { approvalId: a.id };
  }
  /** 向持有有效认领的连接器返回审批状态或 ACP 决定。 */
  permissionResult(runId: string, approvalId: string) {
    const a = this.store.approval(approvalId);
    if (!a || a.runId !== runId) throw new AppError(404, "审批不存在");
    return a.status === "pending"
      ? { status: "pending" as const }
      : a.status === "decided"
        ? {
            status: "resolved" as const,
            response: {
              outcome: { outcome: "selected" as const, optionId: a.optionId! },
            },
          }
        : {
            status: "resolved" as const,
            response: { outcome: { outcome: "cancelled" as const } },
          };
  }
  /** 校验审批仍可处理、运行租约有效且所选选项存在。 */
  private pendingApproval(id: string, decision: Decision) {
    const a = this.store.approval(id);
    const r = a ? this.store.run(a.runId) : undefined;
    const lease = r ? this.store.lease(r.id) : undefined;
    if (
      !a ||
      a.status !== "pending" ||
      !r ||
      r.endedAt ||
      r.status === "cancelled" ||
      !lease ||
      lease.deadline <= Date.now() ||
      a.runId !== decision.runId ||
      a.sessionId !== decision.sessionId ||
      r.sessionId !== a.sessionId ||
      this.store.task(a.taskId)?.currentRunId !== r.id
    )
      throw new AppError(409, "审批已失效或不属于当前执行");
    if (
      !a.request.options.some(
        /* 确认决定引用了审批请求实际提供的选项。 */ (o) =>
          o.optionId === decision.optionId,
      )
    )
      throw new AppError(409, "审批选项无效");
    return { approval: a, run: r };
  }
  /** 保存网页用户的决定，并立即完成该审批。 */
  decide(id: string, decision: Decision) {
    const { approval } = this.pendingApproval(id, decision);
    approval.userDecision = { optionId: decision.optionId, decidedAt: now() };
    this.resolveApproval(approval, decision.optionId, "user");
  }
  /** 保存订阅者的审批意见，并设置网页用户可优先处理的宽限期。 */
  decideSubscriber(decision: SubscriberDecision) {
    const { approval } = this.pendingApproval(decision.approvalId, decision);
    if (approval.taskId !== decision.taskId)
      throw new AppError(409, "审批不属于订阅任务");
    const existing = approval.reviewerDecisions.find(
      /* 找出订阅者已提交的意见，用于幂等和冲突检查。 */ (d) =>
        d.target === "subscriber",
    );
    if (existing) {
      if (existing.optionId !== decision.optionId)
        throw new AppError(409, "订阅者已提交审批意见");
      return;
    }
    const decidedAt = Date.now();
    approval.reviewerDecisions.push({
      target: "subscriber",
      optionId: decision.optionId,
      decidedAt: new Date(decidedAt).toISOString(),
    });
    approval.fallbackAt = new Date(
      decidedAt + LIMITS.approvalGraceMs,
    ).toISOString();
    this.store.saveApproval(approval);
  }
  /** 记录最终审批决定，并按剩余审批更新任务与运行状态。 */
  private resolveApproval(
    a: Approval,
    optionId: string,
    source: NonNullable<Approval["resolvedBy"]>,
  ) {
    const r = this.store.run(a.runId);
    if (!r) throw new AppError(409, "审批执行已结束");
    a.status = "decided";
    a.optionId = optionId;
    a.resolvedBy = source;
    this.store.transaction(() => {
      // 原子写入审批结果、运行状态与任务状态。
      a.resolvedAt = now();
      this.store.saveApproval(a);
      r.status = this.store
        .approvals(r.id)
        .some(
          /* 检查同一次运行是否还有待处理审批。 */ (x) =>
            x.status === "pending",
        )
        ? "awaiting_approval"
        : "running";
      const t = this.store.task(r.taskId)!;
      t.status = r.status;
      this.store.saveRun(r);
      this.store.saveTask(t);
    });
  }

  /** 已进入用户优先窗口的审批沿用各自的宽限期。 */
  hasTimedOut(runId: string, time: number) {
    return this.store
      .approvals(runId)
      .some(
        (approval) =>
          approval.status === "pending" &&
          approval.fallbackAt === null &&
          time - Date.parse(approval.createdAt) >= LIMITS.approvalMs,
      );
  }

  /** 采纳已过用户优先窗口的订阅者意见。 */
  resolveDue(runId: string, time: number) {
    for (const approval of this.store.approvals(runId)) {
      if (
        approval.status !== "pending" ||
        !approval.fallbackAt ||
        Date.parse(approval.fallbackAt) > time
      )
        continue;
      const reviewer = approval.reviewerDecisions.find(
        (decision) => decision.target === "subscriber",
      );
      if (reviewer)
        this.resolveApproval(approval, reviewer.optionId, reviewer.target);
    }
  }
}
