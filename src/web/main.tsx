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
  taskSchema,
  detailSchema,
  publishResultSchema,
  type Bootstrap,
  type Task,
  type TaskDetail,
  type Approval,
} from "../shared/protocol";
import "./style.css";

const statusNames: Record<Task["status"], string> = {
  queued: "排队中",
  running: "执行中",
  awaiting_approval: "待审批",
  succeeded: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
  interrupted: "已中断",
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
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<TaskDetail>();
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [form, setForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [online, setOnline] = useState(true);
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
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const list = await api("/tasks", z.array(taskSchema));
        const d = selected
          ? await api("/tasks/" + selected, detailSchema)
          : undefined;
        if (live) {
          setTasks(list);
          setDetail(d);
          setOnline(true);
        }
      } catch (e) {
        if (live) {
          setOnline(false);
          setError((e as Error).message);
        }
      } finally {
        if (live) timer = setTimeout(refresh, 1200);
      }
    };
    void refresh();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [boot, selected]);
  async function refresh() {
    setTasks(await api("/tasks", z.array(taskSchema)));
    if (selected) setDetail(await api("/tasks/" + selected, detailSchema));
  }
  async function act(path: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      await api(path, z.unknown(), body);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function publish(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError("");
    try {
      const result = await api("/tasks", publishResultSchema, values);
      setForm(false);
      setSelected(result.taskId);
      await refresh();
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
  function approval(a: Approval) {
    return (
      <section
        className={"approval " + (a.status === "pending" ? "pending" : "")}
        key={a.id}
      >
        <div className="section-title">
          <Icon name="shield" />
          <h3>
            {a.status === "pending"
              ? "需要你的审批"
              : a.status === "decided"
                ? "审批已处理"
                : "审批已失效"}
          </h3>
        </div>
        <p className="tool-title">{a.request.toolCall.title ?? "工具操作"}</p>
        <p className="muted small">
          选项由 Codex ACP 提供。操作是否继续，以执行器返回结果为准。
        </p>
        <details>
          <summary>查看操作上下文与原始选项</summary>
          <pre>
            {JSON.stringify(
              { toolCall: a.request.toolCall, options: a.request.options },
              null,
              2,
            )}
          </pre>
          <p className="mono small">
            Run {a.runId}
            <br />
            Session {a.sessionId}
            <br />
            Request {String(a.requestId)}
          </p>
        </details>
        {a.status === "pending" ? (
          <div className="approval-actions">
            {a.request.options.map((o) => (
              <button
                key={o.optionId}
                className={o.kind.startsWith("reject") ? "reject" : "primary"}
                disabled={busy || !online}
                onClick={() =>
                  void act("/approvals/" + a.id + "/decision", {
                    runId: a.runId,
                    sessionId: a.sessionId,
                    optionId: o.optionId,
                  })
                }
              >
                {o.name}
                <span className="option-kind">{o.kind}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="small muted">
            {a.status === "decided"
              ? `已选择：${a.request.options.find((o) => o.optionId === a.optionId)?.name ?? a.optionId}`
              : "原执行连接已结束，不能继续使用这张审批单。"}
          </p>
        )}
      </section>
    );
  }
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
          <span className={"connection-dot " + (!online ? "offline" : "")} />
          {online ? "本机已连接" : "连接中断"}
          <span className="header-divider" />
          Codex ACP
        </div>
      </header>
      <main className="workspace">
        <div className="page-heading">
          <div>
            <div className="eyebrow">WORKSPACE / TASKS</div>
            <h1>让任务继续向前。</h1>
            <p className="subtitle">发布、执行与审批，在一张任务列表里。</p>
          </div>
          <button
            className="primary new-task"
            disabled={!boot}
            onClick={() => setForm(true)}
          >
            <Icon name="plus" />
            发布任务
          </button>
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
                    onClick={() => setForm(true)}
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
              自动刷新
            </span>
          </footer>
        </section>
        <footer className="page-footer">
          <span>
            <span className="tiny-square" />
            一个执行器，一条清晰的任务链路。
          </span>
          <span>
            MCP 发布 <span className="muted">→</span> Codex ACP 执行{" "}
            <span className="muted">→</span> 网页审批
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
            <p className="muted">提交后进入队列，由 Codex ACP 执行。</p>
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
              <button type="submit" className="primary" disabled={busy}>
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
                  <dd>Codex ACP {boot?.mode === "fake" ? "· 演示" : ""}</dd>
                </div>
                <div>
                  <dt>工作区</dt>
                  <dd className="mono">{boot?.workspace}</dd>
                </div>
              </dl>
              {detail.approvals.map(approval)}
              {detail.runs[0] && (
                <section className="result">
                  <div className="section-title">
                    <Icon name="box" />
                    <h3>执行结果</h3>
                  </div>
                  {detail.runs[0].error && (
                    <p className="run-error">{detail.runs[0].error}</p>
                  )}
                  <pre>{detail.runs[0].output || "等待执行器返回内容…"}</pre>
                  <p className="small muted">
                    共 {detail.runs.length} 次执行
                    {detail.runs[0].stopReason
                      ? ` · ${detail.runs[0].stopReason}`
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
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
