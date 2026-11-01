import { useEffect, useState } from "react";
import type { Approval } from "../shared/protocol";
import { approvalOption, approvalPrompt } from "../shared/approval";

function choiceName(approval: Approval, optionId: string | undefined) {
  const option = approval.request.options.find(
    (item) => item.optionId === optionId,
  );
  if (option?.kind.startsWith("allow")) return "同意";
  if (option?.kind.startsWith("reject")) return "拒绝";
  return option?.name ?? "待决定";
}

export function ApprovalCard({
  approval,
  publisherName,
  subscriberEnabled,
  busy,
  online,
  clockOffset,
  onDecide,
  modal = false,
}: {
  approval: Approval;
  publisherName: string;
  subscriberEnabled: boolean;
  busy: boolean;
  online: boolean;
  clockOffset: number;
  onDecide: (optionId: string) => void;
  modal?: boolean;
}) {
  const [time, setTime] = useState(Date.now);
  useEffect(() => {
    if (approval.status !== "pending" || !approval.fallbackAt) return;
    const timer = setInterval(() => setTime(Date.now()), 100);
    return () => clearInterval(timer);
  }, [approval.status, approval.fallbackAt]);
  const prompt = approval.prompt ?? approvalPrompt(approval.request);
  const subscriber = approval.reviewerDecisions.find(
    (decision) => decision.target === "subscriber",
  );
  const remaining = approval.fallbackAt
    ? Math.max(
        0,
        Math.ceil(
          (Date.parse(approval.fallbackAt) - time - clockOffset) / 1000,
        ),
      )
    : null;
  const closed = approval.status !== "pending";
  const expired = remaining === 0;
  const allow = approvalOption(approval.request, "allow");
  const reject = approvalOption(approval.request, "reject");
  const state = (optionId: string | undefined) =>
    optionId ? choiceName(approval, optionId) : closed ? "未决定" : "待决定";
  return (
    <section
      className={`approval ${closed ? "" : "pending"} ${modal ? "approval-in-modal" : ""}`}
    >
      <div className="approval-heading">
        <div>
          <p className="eyebrow">{closed ? "审批记录" : "操作审批"}</p>
          {modal ? (
            <h2>{prompt.title}</h2>
          ) : (
            <h3>
              {closed
                ? approval.status === "decided"
                  ? "审批已处理"
                  : "审批已失效"
                : "需要你的审批"}
            </h3>
          )}
        </div>
        {approval.status === "pending" && remaining !== null && (
          <span
            className="approval-countdown"
            role="timer"
            aria-label="采用订阅者意见倒计时"
          >
            <strong>{remaining}s</strong>
            <span>{expired ? "正在应用意见" : "后采用订阅者意见"}</span>
          </span>
        )}
      </div>
      {!modal && <p className="tool-title">{prompt.title}</p>}
      <p className="approval-description">{prompt.description}</p>
      <dl className="approval-decisions">
        <div
          className={
            subscriber
              ? `decision-${choiceName(approval, subscriber.optionId) === "同意" ? "allow" : "reject"}`
              : ""
          }
        >
          <dt>
            订阅者 <span>{publisherName}</span>
          </dt>
          <dd>{subscriberEnabled ? state(subscriber?.optionId) : "未启用"}</dd>
        </div>
        <div
          className={
            approval.userDecision
              ? `decision-${choiceName(approval, approval.userDecision.optionId) === "同意" ? "allow" : "reject"}`
              : ""
          }
        >
          <dt>用户</dt>
          <dd>{state(approval.userDecision?.optionId)}</dd>
        </div>
      </dl>
      <details>
        <summary>查看操作上下文与原始选项</summary>
        <pre>
          {JSON.stringify(
            {
              toolCall: approval.request.toolCall,
              options: approval.request.options,
            },
            null,
            2,
          )}
        </pre>
        <p className="mono small">
          Run {approval.runId}
          <br />
          Session {approval.sessionId}
          <br />
          Request {String(approval.requestId)}
        </p>
      </details>
      {!closed && (
        <>
          <p className="small muted">
            {subscriber
              ? "倒计时结束前，你的决定立即生效。"
              : "你可以直接决定；订阅者提交意见后，将保留 10 秒等待你的决定。"}
          </p>
          {!online && (
            <p role="status" className="run-error">
              连接恢复后可提交决定。
            </p>
          )}
          <div className="approval-actions">
            <button
              className="reject"
              disabled={busy || !online || expired || !reject}
              onClick={() => reject && onDecide(reject.optionId)}
            >
              拒绝
            </button>
            <button
              className="primary"
              disabled={busy || !online || expired || !allow}
              onClick={() => allow && onDecide(allow.optionId)}
            >
              同意
            </button>
          </div>
          {(allow?.kind === "allow_always" ||
            reject?.kind === "reject_always") && (
            <p className="small muted">
              授权范围：
              {[allow, reject]
                .filter((option) => option?.kind.endsWith("always"))
                .map((option) => option?.name)
                .join("；")}
            </p>
          )}
        </>
      )}
      {closed && (
        <p className="small muted">
          {approval.status === "expired"
            ? "本次审批已失效。"
            : `最终采用${approval.resolvedBy === "user" ? "用户" : approval.resolvedBy === "subscriber" ? "订阅者" : "审批方"}的决定：${choiceName(approval, approval.optionId ?? undefined)}`}
        </p>
      )}
    </section>
  );
}
