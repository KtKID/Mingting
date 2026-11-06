import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import {
  bootstrapSchema,
  LIMITS,
  auditedHarnessSchema,
  isAuditedHarness,
  publishResultSchema,
  browserSnapshotSchema,
  auditPageSchema,
  type AuditPage,
  type HarnessSubscription,
  type Bootstrap,
  type Task,
  type BrowserTaskDetail,
  type Approval,
  type RunUsage,
} from "../shared/protocol";
import type { WakeupEvent } from "../shared/task-wakeup";
import "./style.css";
import { ApprovalCard } from "./approval-card";

const viewParams = new URLSearchParams(window.location.search);
if (viewParams.get("theme") === "light")
  document.documentElement.dataset.theme = "light";
const linkedTask = z.string().uuid().safeParse(viewParams.get("task"));
const tokenNumber = new Intl.NumberFormat("zh-CN");
const usageLabels = {
  totalTokens: "总量",
  uncachedInputTokens: "非缓存输入",
  cachedReadTokens: "缓存读",
  cachedWriteTokens: "缓存写",
  outputTokens: "输出",
  reasoningTokens: "思考（已含于输出）",
} satisfies Record<
  keyof Pick<
    RunUsage,
    | "totalTokens"
    | "uncachedInputTokens"
    | "cachedReadTokens"
    | "cachedWriteTokens"
    | "outputTokens"
    | "reasoningTokens"
  >,
  string
>;
type UsageMetric = keyof typeof usageLabels;

function UsageNumbers({
  values,
  overflow = [],
}: {
  values: Pick<RunUsage, UsageMetric>;
  overflow?: UsageMetric[];
}) {
  return (
    <ul>
      {(Object.keys(usageLabels) as UsageMetric[]).map((key) => (
        <li key={key}>
          {usageLabels[key]}{" "}
          {overflow.includes(key)
            ? "超出安全汇总范围"
            : values[key] === null
              ? "未知"
              : tokenNumber.format(values[key])}
        </li>
      ))}
    </ul>
  );
}

const statusNames: Record<Task["status"], string> = {
  queued: "排队中",
  running: "执行中",
  awaiting_approval: "待审批",
  succeeded: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
  interrupted: "已中断",
};
const wakeupStatusNames: Record<WakeupEvent["status"], string> = {
  pending: "等待投递",
  sending: "投递中",
  delivered: "已投递",
  acknowledged: "已确认",
  superseded: "已失效",
  failed: "投递失败",
};
function Status({ status }: { status: Task["status"] }) {
  return (
    <span className={"status status-" + status}>
      <i />
      {statusNames[status]}
    </span>
  );
}
const date = (s: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(s));
function Icon({
  name,
}: {
  name:
    | "plus"
    | "close"
    | "arrow"
    | "search"
    | "box"
    | "check"
    | "clock"
    | "shield";
}) {
  const paths = {
    plus: "M12 5v14M5 12h14",
    close: "m6 6 12 12M6 18 18 6",
    arrow: "m9 5 7 7-7 7",
    search: "m21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
    box: "m3 7 9-4 9 4v10l-9 4-9-4V7Zm0 0 9 4 9-4M12 11v10",
    check: "m5 12 4 4L19 6",
    clock: "M12 8v4l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
    shield: "m12 3 8 3v6c0 4-8 9-8 9s-8-5-8-9V6l8-3Z",
  };
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
function Modal({
  children,
  onClose,
  className = "",
  label,
}: {
  children: ReactNode;
  onClose: () => void;
  className?: string;
  label: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current!;
    el.showModal();
    return () => el.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={label}
      className={className}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {children}
    </dialog>
  );
}
function App() {
  const [boot, setBoot] = useState<Bootstrap>();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [harnesses, setHarnesses] = useState<HarnessSubscription[]>([]);
  const [selected, setSelected] = useState<string | undefined>(
    linkedTask.success ? linkedTask.data : undefined,
  );
  const [detail, setDetail] = useState<BrowserTaskDetail>();
  const wakeup = detail?.wakeup;
  const [chosenRunId, setChosenRunId] = useState<string>();
  const [audit, setAudit] = useState<AuditPage>();
  const auditRequest = useRef(0);
  const selectedRun =
    detail?.runs.find((run) => run.id === chosenRunId) ?? detail?.runs[0];
  useEffect(() => {
    setChosenRunId(undefined);
    setAudit(undefined);
    auditRequest.current++;
  }, [selected]);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [form, setForm] = useState(false);
  const [targetHarness, setTargetHarness] = useState("");
  const [modelId, setModelId] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const auditedSelected = isAuditedHarness(targetHarness.trim());
  const capabilities = harnesses.find(
    (h) => h.harnessName === targetHarness.trim() && h.capabilities,
  )?.capabilities;
  const model = capabilities?.models.find(
    (item) => item.id === (modelId || capabilities.defaultModelId),
  );
  const invalidSettings =
    auditedSelected &&
    Boolean(
      (modelId && !model) ||
      (reasoningEffort &&
        !model?.efforts.some((item) => item.id === reasoningEffort)),
    );
  function openForm() {
    setTargetHarness("");
    setModelId("");
    setReasoningEffort("");
    setForm(true);
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [online, setOnline] = useState(true);
  const [pendingApprovals, setPendingApprovals] = useState<Approval[]>([]);
  const [activeApprovalId, setActiveApprovalId] = useState<string>();
  const [clockOffset, setClockOffset] = useState(0);
  const dismissedApprovals = useRef(new Set<string>());
  async function api<T>(
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    const r = await fetch("/api" + path, {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined
          ? {}
          : {
              "content-type": "application/json",
              "x-csrf-token": boot?.csrf ?? "",
            },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await r.json();
    if (!r.ok) throw new Error(value.error ?? "请求失败");
    return schema.parse(value);
  }
  useEffect(() => {
    let live = true;
    fetch("/api/bootstrap")
      .then((r) => {
        if (!r.ok) throw new Error("无法建立本机会话");
        return r.json();
      })
      .then((v) => {
        if (live) setBoot(bootstrapSchema.parse(v));
      })
      .catch((e) => setError(e.message));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!boot) return;
    let live = true;
    let source: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (!live || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void recover();
      }, LIMITS.reconnectMs);
    };
    const recover = async () => {
      try {
        const response = await fetch("/api/bootstrap", {
          signal: AbortSignal.timeout(LIMITS.initMs),
        });
        if (!response.ok) throw new Error("重新连接中");
        const next = bootstrapSchema.parse(await response.json());
        if (!live) return;
        if (next.csrf !== boot.csrf) {
          setBoot(next);
          return;
        }
        connect();
      } catch {
        schedule();
      }
    };
    const connect = () => {
      if (!live) return;
      const stream = new EventSource(
        "/api/events" +
          (selected ? "?taskId=" + encodeURIComponent(selected) : ""),
      );
      source = stream;
      stream.addEventListener("snapshot", (event: MessageEvent<string>) => {
        if (!live || source !== stream) return;
        try {
          const snapshot = browserSnapshotSchema.parse(JSON.parse(event.data));
          setTasks(snapshot.tasks);
          setHarnesses(snapshot.harnesses);
          setDetail(snapshot.detail ?? undefined);
          setPendingApprovals(snapshot.pendingApprovals);
          if (snapshot.serverTime !== undefined)
            setClockOffset(snapshot.serverTime - Date.now());
          setOnline(true);
        } catch {
          setError("实时数据格式无效，请刷新页面");
        }
      });
      stream.onerror = () => {
        if (!live || source !== stream) return;
        setOnline(false);
        stream.close();
        source = undefined;
        schedule();
      };
    };
    connect();
    return () => {
      live = false;
      clearTimeout(timer);
      source?.close();
    };
  }, [boot, selected]);
  useEffect(() => {
    if (
      activeApprovalId &&
      pendingApprovals.some((approval) => approval.id === activeApprovalId)
    )
      return;
    setActiveApprovalId(
      pendingApprovals.find(
        (approval) => !dismissedApprovals.current.has(approval.id),
      )?.id,
    );
  }, [pendingApprovals, activeApprovalId]);
  async function act(path: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      await api(path, z.unknown(), body);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function showAudit(cursor?: string) {
    if (!selected || !selectedRun) return;
    const request = ++auditRequest.current;
    try {
      const page = await api(
        `/tasks/${selected}/runs/${selectedRun.id}/audit${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
        auditPageSchema,
      );
      if (request !== auditRequest.current) return;
      setAudit((old) =>
        cursor && old?.runId === page.runId
          ? { ...page, entries: [...old.entries, ...page.entries] }
          : page,
      );
    } catch (e) {
      if (request === auditRequest.current)
        setError(e instanceof Error ? e.message : "读取审计失败");
    }
  }
  async function publish(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const values: Record<string, unknown> = Object.fromEntries(data);
    values.approvalTargets = data.getAll("approvalTargets");
    if (values.targetHarness === "") delete values.targetHarness;
    if (invalidSettings) return;
    if (auditedSelected && (modelId || reasoningEffort))
      values.requestedSettings = {
        modelId: modelId || undefined,
        reasoningEffort: reasoningEffort || undefined,
      };
    setBusy(true);
    setError("");
    try {
      const result = await api("/tasks", publishResultSchema, values);
      setForm(false);
      setSelected(result.taskId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const waiting = tasks.filter((t) => t.status === "awaiting_approval").length;
  const done = tasks.filter((t) => t.status === "succeeded").length;
  const visible = tasks.filter(
    (t) =>
      (filter === "all" ||
        (filter === "approval" && t.status === "awaiting_approval") ||
        (filter === "done" && t.status === "succeeded")) &&
      `${t.title} ${t.description} ${t.publisherName}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  function approval(a: Approval, modal = false) {
    const task = tasks.find((task) => task.id === a.taskId) ?? detail?.task;
    return (
      <ApprovalCard
        key={a.id}
        approval={a}
        publisherName={task?.publisherName ?? "任务发起方"}
        subscriberEnabled={task?.approvalTargets.includes("subscriber") ?? true}
        busy={busy}
        online={online}
        clockOffset={clockOffset}
        modal={modal}
        onDecide={(optionId) =>
          void act("/approvals/" + a.id + "/decision", {
            runId: a.runId,
            sessionId: a.sessionId,
            optionId,
          })
        }
      />
    );
  }
  const activeApproval = pendingApprovals.find(
    (approval) => approval.id === activeApprovalId,
  );
  return (
    <>
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-mark">
            <Icon name="box" />
          </span>
          任务台<span className="version">MVP</span>
        </a>
        <div className="connection">
          <a href="/approval-tests/">审批测试记录</a>
          <span className={"connection-dot " + (!online ? "offline" : "")} />
          {online ? "本机已连接" : "连接中断"}
          <span className="header-divider" />
          在线：
          {[...new Set(harnesses.map((h) => h.harnessName))].join(" · ") ||
            "等待订阅"}
        </div>
      </header>
      <main className="workspace">
        <div className="page-heading">
          <div>
            <div className="eyebrow">WORKSPACE / TASKS</div>
            <h1>让任务继续向前。</h1>
            <p className="subtitle">发布、执行与审批，在一张任务列表里。</p>
          </div>
          <div className="heading-actions">
            <a className="secondary replay-entry" href="/approval-tests/">
              审批回放与测试记录
            </a>
            <button
              className="primary new-task"
              disabled={!boot}
              onClick={openForm}
            >
              <Icon name="plus" />
              发布任务
            </button>
          </div>
        </div>
        {boot?.mode === "fake" && (
          <div className="demo-banner">
            <span>演示模式</span> 当前使用 ACP
            测试子进程，不调用模型、不执行真实命令。
          </div>
        )}
        {error && (
          <div role="alert" className="error-banner">
            {error}
            <button aria-label="关闭提示" onClick={() => setError("")}>
              <Icon name="close" />
            </button>
          </div>
        )}
        <section className="task-surface" aria-label="任务列表">
          <div className="toolbar">
            <div className="tabs" role="tablist" aria-label="筛选任务">
              {[
                { id: "all", label: "全部任务", count: tasks.length },
                { id: "approval", label: "待我审批", count: waiting },
                { id: "done", label: "已完成", count: done },
              ].map((f) => (
                <button
                  role="tab"
                  aria-selected={filter === f.id}
                  key={f.id}
                  className={filter === f.id ? "active" : ""}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label}
                  <span>{f.count}</span>
                </button>
              ))}
            </div>
            <label className="search">
              <Icon name="search" />
              <input
                aria-label="搜索任务"
                placeholder="搜索任务或发布人"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
          </div>
          <div className="list-head">
            <span>任务 / 描述</span>
            <span>发布人</span>
            <span>状态</span>
            <span>发布时间</span>
            <span />
          </div>
          <div className="task-list">
            {visible.map((t) => (
              <button
                className="task-row"
                key={t.id}
                onClick={() => {
                  setDetail(undefined);
                  setSelected(t.id);
                }}
                aria-label={`查看任务：${t.title}`}
              >
                <div className="task-content">
                  <span
                    className={
                      "task-icon " +
                      (t.status === "awaiting_approval" ? "attention" : "")
                    }
                  >
                    <Icon
                      name={
                        t.status === "succeeded"
                          ? "check"
                          : t.status === "awaiting_approval"
                            ? "shield"
                            : "box"
                      }
                    />
                  </span>
                  <div>
                    <strong>{t.title}</strong>
                    <p>{t.description}</p>
                    {t.targetHarness && (
                      <p className="small muted">指定 {t.targetHarness}</p>
                    )}
                  </div>
                </div>
                <div className="publisher">
                  <span className="avatar">
                    {Array.from(t.publisherName)[0]}
                  </span>
                  <span>{t.publisherName}</span>
                </div>
                <Status status={t.status} />
                <time dateTime={t.createdAt}>{date(t.createdAt)}</time>
                <span className="row-arrow">
                  <Icon name="arrow" />
                </span>
              </button>
            ))}
            {!visible.length && (
              <div className="empty">
                <span className="empty-icon">
                  <Icon name="box" />
                </span>
                <h2>
                  {tasks.length
                    ? "没有找到匹配的任务"
                    : "第一项任务，从这里开始"}
                </h2>
                <p>
                  {tasks.length
                    ? "试试其他关键词或筛选条件。"
                    : "通过 MCP 发布任务，或先在网页里试一次。"}
                </p>
                {!tasks.length && (
                  <button
                    className="secondary"
                    disabled={!boot}
                    onClick={openForm}
                  >
                    <Icon name="plus" />
                    发布任务
                  </button>
                )}
              </div>
            )}
          </div>
          <footer className="list-footer">
            <span>显示 {visible.length} 项 · 最近 200 项任务</span>
            <span>
              <Icon name="clock" />
              实时同步
            </span>
          </footer>
        </section>
        <footer className="page-footer">
          <span>
            <span className="tiny-square" />
            按身份订阅，按目标执行。
          </span>
          <span>
            发布任务 <span className="muted">→</span> 指定执行者{" "}
            <span className="muted">→</span> 查看结果
          </span>
        </footer>
      </main>
      {form && (
        <Modal
          label="发布任务"
          onClose={() => setForm(false)}
          className="publish-dialog"
        >
          <form onSubmit={(e) => void publish(e)}>
            <div className="drawer-heading">
              <div>
                <p className="eyebrow">NEW TASK</p>
                <h2>发布任务</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭发布窗口"
                onClick={() => setForm(false)}
              >
                <Icon name="close" />
              </button>
            </div>
            <p className="muted">选择执行者；目标离线时任务会排队等候。</p>
            {error && (
              <p role="alert" className="run-error">
                {error}
              </p>
            )}
            <label>
              任务标题
              <input
                name="title"
                placeholder="例如：为项目补充安装说明"
                required
                maxLength={160}
                autoFocus
              />
            </label>
            <label>
              任务描述
              <textarea
                name="description"
                rows={5}
                placeholder="说明目标、约束与完成条件…"
                required
                maxLength={16000}
              />
            </label>
            <label>
              执行者
              <input
                name="targetHarness"
                list="harness-options"
                placeholder="留空由可用订阅者领取"
                maxLength={40}
                value={targetHarness}
                onChange={(e) => {
                  setTargetHarness(e.target.value);
                  setModelId("");
                  setReasoningEffort("");
                }}
              />
              <datalist id="harness-options">
                {[
                  ...new Set([
                    ...auditedHarnessSchema.options,
                    ...harnesses.map((h) => h.harnessName),
                  ]),
                ].map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </label>
            {auditedSelected &&
              (capabilities ? (
                <>
                  <label>
                    模型
                    <select
                      value={modelId}
                      onChange={(e) => {
                        setModelId(e.target.value);
                        setReasoningEffort("");
                      }}
                    >
                      <option value="">沿用默认</option>
                      {capabilities.models.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    思考档位
                    <select
                      value={reasoningEffort}
                      onChange={(e) => setReasoningEffort(e.target.value)}
                    >
                      <option value="">沿用默认</option>
                      {model?.efforts.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              ) : (
                <p className="small muted">
                  {targetHarness.trim()} 显式选项暂不可发现，仍可使用默认设置。
                </p>
              ))}
            {invalidSettings && (
              <p role="alert">当前选项已变更，请重新选择模型和档位。</p>
            )}
            <fieldset className="approval-targets">
              <legend>
                审批对象 <span>可同时选择</span>
              </legend>
              <label>
                <input
                  type="checkbox"
                  name="approvalTargets"
                  value="subscriber"
                  defaultChecked
                />
                订阅者 <span>任务发起方</span>
              </label>
              <label className="unavailable">
                <input
                  type="checkbox"
                  name="approvalTargets"
                  value="third_party"
                  disabled
                />
                第三方 <span>开发中</span>
              </label>
              <p className="small muted">
                用户始终可以决定；留空时由用户审批。
              </p>
            </fieldset>
            <label>
              发布人名字
              <input
                name="publisherName"
                placeholder="你的名字"
                required
                maxLength={80}
              />
            </label>
            <p className="small muted">
              名字仅用于展示。执行目录固定为服务端配置的工作区。
            </p>
            <div className="form-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setForm(false)}
              >
                取消
              </button>
              <button
                type="submit"
                className="primary"
                disabled={busy || invalidSettings}
              >
                {busy ? "提交中…" : "发布任务"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {selected && (
        <Modal
          label="任务详情"
          onClose={() => {
            setSelected(undefined);
            setDetail(undefined);
          }}
          className="detail-dialog"
        >
          <div className="drawer-heading">
            <div>
              <p className="eyebrow">TASK DETAILS</p>
              <h2>任务详情</h2>
            </div>
            <button
              className="icon-button"
              aria-label="关闭任务详情"
              onClick={() => setSelected(undefined)}
            >
              <Icon name="close" />
            </button>
          </div>
          {!detail ? (
            <p className="loading">读取任务…</p>
          ) : (
            <div className="drawer-body">
              {error && (
                <p role="alert" className="run-error">
                  {error}
                </p>
              )}
              <Status status={detail.task.status} />
              <h2 className="detail-title">{detail.task.title}</h2>
              <p className="description">{detail.task.description}</p>
              <dl className="metadata">
                <div>
                  <dt>发布人</dt>
                  <dd>{detail.task.publisherName}</dd>
                </div>
                <div>
                  <dt>发布时间</dt>
                  <dd>{date(detail.task.createdAt)}</dd>
                </div>
                <div>
                  <dt>执行器</dt>
                  <dd>
                    {selectedRun?.harnessName ?? "等待领取"}{" "}
                    {boot?.mode === "fake" ? "· 演示" : ""}
                  </dd>
                </div>
                <div>
                  <dt>指定执行者</dt>
                  <dd>{detail.task.targetHarness ?? "任一可用订阅者"}</dd>
                </div>
                {selectedRun && (
                  <div>
                    <dt>连接协议</dt>
                    <dd>
                      {selectedRun.discovery
                        ? selectedRun.discovery.agentInfo?.name.includes(
                            "Mingting",
                          )
                          ? "ACP · ZCode 项目桥接"
                          : "ACP"
                        : "等待协议初始化"}
                    </dd>
                  </div>
                )}
                <div>
                  <dt>工作区</dt>
                  <dd className="mono">{boot?.workspace}</dd>
                </div>
                <div>
                  <dt>唤醒目标</dt>
                  <dd>
                    {wakeup ? (
                      <>
                        <div>
                          会话 ID <code>{wakeup.target.sessionId}</code>
                        </div>
                        <div>
                          发单轮次 <code>{wakeup.target.originTurn}</code>
                        </div>
                      </>
                    ) : (
                      "未绑定会话"
                    )}
                  </dd>
                </div>
                <div>
                  <dt>投递结果</dt>
                  <dd>
                    {wakeup?.events.length
                      ? wakeup.events.map((event) => (
                          <div key={event.id}>
                            {event.type === "approval.requested"
                              ? "审批通知"
                              : "完成通知"}
                            {" · "}
                            {wakeupStatusNames[event.status]}
                          </div>
                        ))
                      : wakeup
                        ? "暂无投递记录"
                        : "无"}
                  </dd>
                </div>
              </dl>
              {detail.runs.length > 1 && (
                <label>
                  查看运行
                  <select
                    value={selectedRun?.id}
                    onChange={(event) => {
                      setChosenRunId(event.target.value);
                      setAudit(undefined);
                      auditRequest.current++;
                    }}
                  >
                    {detail.runs.map((run, index) => (
                      <option key={run.id} value={run.id}>
                        {index === 0 ? "最新运行" : date(run.createdAt)} ·{" "}
                        {run.id.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {detail.approvals
                .filter((item) => item.runId === selectedRun?.id)
                .map((item) => approval(item))}
              {detail.usageSummary && (
                <section aria-label="任务用量汇总">
                  <h3>任务用量汇总</h3>
                  <p>
                    主回合 · {detail.usageSummary.runCount} 次已结束运行 ·{" "}
                    {
                      {
                        complete: "完整",
                        partial: "部分覆盖",
                        missing: "未上报",
                      }[detail.usageSummary.coverage]
                    }
                  </p>
                  <UsageNumbers
                    values={detail.usageSummary}
                    overflow={detail.usageSummary.overflow}
                  />
                </section>
              )}
              {selectedRun && (
                <section className="result">
                  <div className="section-title">
                    <Icon name="box" />
                    <h3>执行结果</h3>
                  </div>
                  {selectedRun.error && (
                    <p className="run-error">{selectedRun.error}</p>
                  )}
                  {isAuditedHarness(selectedRun.harnessName) && (
                    <>
                      <section aria-label="上下文">
                        <h4>上下文</h4>
                        <p>
                          占用 / 会话有效窗口{" "}
                          {selectedRun.context
                            ? `${tokenNumber.format(selectedRun.context.usedTokens)} / ${selectedRun.context.effectiveWindowTokens === null ? "未知" : tokenNumber.format(selectedRun.context.effectiveWindowTokens)} tokens · ${selectedRun.context.source === "grok_acp_session_meta" ? "Grok 会话观测" : "ACP 上报"}`
                            : "未知"}
                        </p>
                        <p>
                          模型标称窗口{" "}
                          {selectedRun.settingsReceipt?.modelWindow ? (
                            <a
                              href={
                                selectedRun.settingsReceipt.modelWindow
                                  .sourceUrl
                              }
                              target="_blank"
                              rel="noreferrer"
                            >
                              {tokenNumber.format(
                                selectedRun.settingsReceipt.modelWindow.tokens,
                              )}{" "}
                              tokens ·{" "}
                              {selectedRun.settingsReceipt.modelWindow.basis}
                            </a>
                          ) : (
                            "未知"
                          )}
                        </p>
                      </section>
                      <section aria-label="运行用量">
                        <h4>运行用量</h4>
                        {selectedRun.usage ? (
                          <>
                            <p>
                              主回合 · {selectedRun.usage.source.method} ·{" "}
                              {
                                {
                                  complete: "完整",
                                  partial: "部分覆盖",
                                  missing: "未上报",
                                }[selectedRun.usage.coverage]
                              }
                            </p>
                            <UsageNumbers values={selectedRun.usage} />
                            {selectedRun.usage.cost && (
                              <p>
                                上报费用 USD {selectedRun.usage.cost.amount}
                              </p>
                            )}
                            {selectedRun.usage.inconsistent && (
                              <p>上报总量与分项存在差异，保留原值。</p>
                            )}
                            {selectedRun.usage.missingReason && (
                              <p>{selectedRun.usage.missingReason}</p>
                            )}
                          </>
                        ) : (
                          <p>
                            {selectedRun.endedAt
                              ? "用量未上报"
                              : "等待回合结束"}
                          </p>
                        )}
                      </section>
                    </>
                  )}
                  {(isAuditedHarness(selectedRun.harnessName) ||
                    detail.task.requestedSettings) && (
                    <section aria-label="运行设置回执">
                      <p>
                        请求设置：
                        {detail.task.requestedSettings?.modelId ??
                          "默认"} /{" "}
                        {detail.task.requestedSettings?.reasoningEffort ??
                          "默认"}
                      </p>
                      {selectedRun.settingsReceipt &&
                      selectedRun.settingsReceipt.status !== "rejected" ? (
                        <>
                          <p>
                            生效设置：
                            {selectedRun.settingsReceipt.modelId ??
                              "未知"} /{" "}
                            {selectedRun.settingsReceipt.reasoningEffort ??
                              "未知"}
                          </p>
                          {selectedRun.settingsReceipt.status === "default" && (
                            <p>沿用默认设置</p>
                          )}
                        </>
                      ) : (
                        <p>
                          {selectedRun.settingsReceipt?.reason ??
                            (selectedRun.endedAt
                              ? "生效设置未知"
                              : "等待设置回执")}
                        </p>
                      )}
                    </section>
                  )}
                  <div className="live-label">
                    {selectedRun.endedAt ? "回答" : "回答 · 实时接收中"}
                  </div>
                  <pre className="answer-output">
                    {selectedRun.output || "等待执行器返回内容…"}
                  </pre>
                  <details className="reasoning" open>
                    <summary>思考过程</summary>
                    <pre>
                      {selectedRun.reasoning ||
                        (selectedRun.endedAt
                          ? "本次执行器未提供思考内容"
                          : "等待执行器提供思考内容…")}
                    </pre>
                  </details>
                  <section className="tools" aria-label="工具状态">
                    <h4>
                      工具状态{" "}
                      <span className="muted">{selectedRun.tools.length}</span>
                    </h4>
                    {selectedRun.tools.length === 0 && (
                      <p className="small muted">
                        {selectedRun.endedAt
                          ? "本次没有工具事件"
                          : "等待工具事件…"}
                      </p>
                    )}
                    {selectedRun.tools.map((tool) => (
                      <article className="tool-card" key={tool.id}>
                        <div className="tool-heading">
                          <strong>{tool.title}</strong>
                          <span className={"tool-status tool-" + tool.status}>
                            {
                              {
                                pending: "等待执行",
                                in_progress: "执行中",
                                completed: "已完成",
                                failed: "失败",
                              }[tool.status]
                            }
                          </span>
                        </div>
                        {(tool.input || tool.output) && (
                          <details>
                            <summary>输入与输出</summary>
                            {tool.input && <pre>{tool.input}</pre>}
                            {tool.output && <pre>{tool.output}</pre>}
                          </details>
                        )}
                      </article>
                    ))}
                  </section>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void showAudit()}
                  >
                    查看运行审计
                  </button>
                  {audit?.runId === selectedRun?.id && audit && (
                    <section aria-label="运行审计">
                      <h4>运行审计</h4>
                      <p className="mono">{audit.runId}</p>
                      {audit.entries
                        .filter((entry) => entry.kind === "context")
                        .map((entry) => (
                          <p key={entry.seq}>
                            上下文{" "}
                            {tokenNumber.format(entry.observation.usedTokens)} /{" "}
                            {entry.observation.effectiveWindowTokens === null
                              ? "未知"
                              : tokenNumber.format(
                                  entry.observation.effectiveWindowTokens,
                                )}{" "}
                            tokens · {date(entry.createdAt)}
                          </p>
                        ))}
                      {audit.entries
                        .filter((entry) => entry.kind === "tool")
                        .map((entry) => (
                          <details key={entry.seq}>
                            <summary>
                              {entry.patch.title ?? entry.toolCallId} ·{" "}
                              {entry.patch.status ?? "状态未上报"}
                            </summary>
                            <p>
                              {entry.toolCallId} · {date(entry.createdAt)}
                            </p>
                            {entry.truncated && <p>内容已截断</p>}
                            {entry.redacted && <p>内容已脱敏</p>}
                            {entry.patch.input && (
                              <pre>{entry.patch.input}</pre>
                            )}
                            {entry.patch.output && (
                              <pre>{entry.patch.output}</pre>
                            )}
                          </details>
                        ))}
                      {audit.approvals.map((item) => (
                        <details key={item.id}>
                          <summary>
                            审批 · {item.request.toolCall.toolCallId} ·{" "}
                            {item.request.options.find(
                              (option) => option.optionId === item.optionId,
                            )?.name ?? item.status}
                          </summary>
                          <p>
                            {item.resolvedBy ?? "待裁决"} ·{" "}
                            {item.resolvedAt
                              ? date(item.resolvedAt)
                              : "裁决时间未知"}
                          </p>
                          <ul>
                            {item.request.options.map((option) => (
                              <li key={option.optionId}>
                                {option.name} · {option.optionId}
                              </li>
                            ))}
                          </ul>
                        </details>
                      ))}
                      {audit.nextCursor && (
                        <button
                          type="button"
                          onClick={() =>
                            void showAudit(audit.nextCursor ?? undefined)
                          }
                        >
                          加载更多
                        </button>
                      )}
                    </section>
                  )}
                  <p className="small muted">
                    共 {detail.runs.length} 次执行
                    {selectedRun.stopReason
                      ? ` · ${selectedRun.stopReason}`
                      : ""}
                  </p>
                </section>
              )}
              {["running", "awaiting_approval", "queued"].includes(
                detail.task.status,
              ) && (
                <button
                  className="secondary full"
                  disabled={busy || !online}
                  onClick={() => void act("/tasks/" + selected + "/cancel", {})}
                >
                  取消任务
                </button>
              )}
              {["failed", "cancelled", "interrupted"].includes(
                detail.task.status,
              ) && (
                <button
                  className="primary full"
                  disabled={
                    busy || !online || detail.runs.some((r) => !r.endedAt)
                  }
                  onClick={() => void act("/tasks/" + selected + "/retry", {})}
                >
                  {detail.runs.some((r) => !r.endedAt)
                    ? "正在停止原执行…"
                    : "创建新执行并重试"}
                </button>
              )}
              <details className="technical">
                <summary>执行记录与协议事件</summary>
                <pre>
                  {JSON.stringify(
                    {
                      taskId: detail.task.id,
                      runs: detail.runs.map((r) => ({
                        ...r,
                        output: undefined,
                      })),
                      events: detail.events,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </div>
          )}
        </Modal>
      )}
      {activeApproval && (
        <Modal
          key={activeApproval.id}
          label="操作审批"
          className="approval-dialog"
          onClose={() => {
            dismissedApprovals.current.add(activeApproval.id);
            setActiveApprovalId(undefined);
          }}
        >
          <button
            className="icon-button approval-close"
            aria-label="稍后审批"
            onClick={() => {
              dismissedApprovals.current.add(activeApproval.id);
              setActiveApprovalId(undefined);
            }}
          >
            <Icon name="close" />
          </button>
          {error && (
            <p role="alert" className="run-error">
              {error}
            </p>
          )}
          {approval(activeApproval, true)}
        </Modal>
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
