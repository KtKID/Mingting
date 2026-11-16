import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { bootstrapSchema, type Bootstrap } from "../shared/protocol";
import {
  projectDirectoryChoiceSchema,
  projectRecordsSchema,
  recordDocumentSchema,
  recordPhaseLabels,
  recordPhaseSchema,
  syncProjectRecordsReceiptSchema,
  type ProjectRecord,
  type RecordedTask,
  type RecordSource,
} from "../shared/project-records";
import { PageNav } from "./page-nav";
import "./project-records.css";

const REFRESH_MS = 3000;
const errorSchema = z.object({ error: z.string() });
const specAccents = [
  "#577fbe",
  "#b17441",
  "#45907d",
  "#9b69ae",
  "#ad5d78",
  "#8b8437",
  "#397f9c",
  "#8a6755",
];
function specAccent(index: number) {
  return specAccents[index] ?? `hsl(${(index * 137.5) % 360}deg 42% 50%)`;
}
const displayTime = (value: string) =>
  new Date(value).toLocaleString("zh-CN", { hour12: false });
const stepLabels = {
  pending: "待开始",
  active: "进行中",
  passed: "已验证",
  failed: "验证失败",
  unknown: "待核对",
};

async function readApi<T>(
  url: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, init);
  const value: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      errorSchema.safeParse(value).data?.error ?? "读取失败，请重试",
    );
  return schema.parse(value);
}

function TaskDetail({
  project,
  specTitle,
  task,
  close,
}: {
  project: ProjectRecord;
  specTitle: string;
  task: RecordedTask;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [document, setDocument] =
    useState<z.infer<typeof recordDocumentSchema>>();
  const [error, setError] = useState("");
  const request = useRef(0);
  useEffect(() => {
    dialog.current?.showModal();
    return () => {
      request.current++;
    };
  }, []);
  async function openDocument(source: RecordSource) {
    const current = ++request.current;
    setError("");
    try {
      const doc = await readApi(
        `/api/project-records/${project.id}/document?path=${encodeURIComponent(source.path)}`,
        recordDocumentSchema,
      );
      if (current === request.current) setDocument(doc);
    } catch (e) {
      if (current === request.current)
        setError(e instanceof Error ? e.message : "读取失败");
    }
  }
  return (
    <dialog
      ref={dialog}
      className="records-detail"
      aria-label="开发任务详情"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === dialog.current) close();
      }}
    >
      <div className="records-detail-head">
        <span className="eyebrow">TASK / 开发记录</span>
        <button
          onClick={close}
          aria-label="关闭开发任务详情"
          className="records-close"
        >
          ×
        </button>
      </div>
      <h2>{task.title}</h2>
      <div className="records-detail-meta">
        <span className={`record-phase ${task.phase}`}>
          {recordPhaseLabels[task.phase]}
        </span>
        <span>
          {project.name} · {specTitle}
        </span>
        <span>同步于 {displayTime(project.observedAt)}</span>
      </div>
      {task.blocker && <p className="records-blocker">阻塞 · {task.blocker}</p>}
      {error && (
        <p role="alert" className="records-error">
          {error}
        </p>
      )}
      {document ? (
        <section className="records-document" aria-label="来源文档">
          <button
            className="records-text-button"
            onClick={() => {
              request.current++;
              setDocument(undefined);
            }}
          >
            ← 返回任务
          </button>
          <p className="records-path">{document.path}</p>
          <pre>{document.content}</pre>
        </section>
      ) : (
        <>
          <section className="records-detail-section">
            <h3>状态依据</h3>
            <p>{task.summary}</p>
            {task.statusSource && (
              <button
                className="records-source"
                onClick={() =>
                  void openDocument(task.statusSource ?? task.sources[0])
                }
              >
                {task.statusSource.path}:{task.statusSource.line} ↗
              </button>
            )}
          </section>
          {task.steps.length > 0 && (
            <section className="records-detail-section">
              <h3>
                内部步骤 ·{" "}
                {task.steps.filter((s) => s.status === "passed").length}/
                {task.steps.length} 已验证
              </h3>
              <ol className="records-steps">
                {task.steps.map((s) => (
                  <li key={s.id}>
                    <span className={`records-step-state ${s.status}`}>
                      {stepLabels[s.status]}
                    </span>
                    <div>
                      <b>{s.id}</b> {s.title}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          )}
          <section className="records-detail-section">
            <h3>文档与交付依据</h3>
            <ul className="records-sources">
              {task.sources.map((s) => (
                <li key={s.path}>
                  <button onClick={() => void openDocument(s)}>
                    <strong>{s.label}</strong>
                    <span>{s.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </dialog>
  );
}

function ConnectProjectForm({
  csrf,
  busy,
  onConnect,
}: {
  csrf: string;
  busy: boolean;
  onConnect: (root: string, name?: string) => void;
}) {
  const directoryId = useId();
  const [root, setRoot] = useState("");
  const [suggestedName, setSuggestedName] = useState("");
  const [nameOverride, setNameOverride] = useState<string>();
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  async function chooseDirectory() {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setChoosing(true);
    setError("");
    try {
      const result = await readApi(
        "/api/project-records/choose-directory",
        projectDirectoryChoiceSchema,
        {
          method: "POST",
          headers: { "x-csrf-token": csrf },
          signal: controller.signal,
        },
      );
      if (result.status === "selected" && !controller.signal.aborted) {
        setRoot(result.projectRoot);
        setSuggestedName(result.projectName);
        setNameOverride((name) => (name?.trim() ? name : undefined));
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(
          error instanceof Error ? error.message : "无法打开文件夹选择器",
        );
      }
    } finally {
      active.current = null;
      if (!controller.signal.aborted) setChoosing(false);
    }
  }

  function connect(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || choosing) return;
    setError("");
    onConnect(root, (nameOverride ?? suggestedName).trim() || undefined);
  }

  return (
    <form className="records-connect" onSubmit={connect} aria-label="接入项目">
      <div className="records-connect-directory">
        <label htmlFor={directoryId}>项目目录</label>
        <div>
          <input
            id={directoryId}
            name="projectRoot"
            value={root}
            onChange={(event) => {
              setRoot(event.target.value);
              setSuggestedName("");
            }}
            required
            placeholder="/你的项目目录"
          />
          <button
            type="button"
            className="records-secondary"
            disabled={busy || choosing}
            onClick={() => void chooseDirectory()}
          >
            {choosing ? "选择中…" : "选择文件夹"}
          </button>
        </div>
      </div>
      <label>
        项目名称（可选）
        <input
          name="projectName"
          value={nameOverride ?? suggestedName}
          onChange={(event) => setNameOverride(event.target.value)}
          placeholder="默认使用目录名称"
        />
      </label>
      <button className="records-primary" disabled={busy || choosing}>
        {busy ? "同步中…" : "读取项目记录"}
      </button>
      {error && (
        <div className="records-connect-error records-error" role="alert">
          {error}
        </div>
      )}
      <p>读取项目的 docs/spec，持续同步文档中的任务进展。</p>
    </form>
  );
}

export function ProjectRecordsPage() {
  const [boot, setBoot] = useState<Bootstrap>();
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [selectedId, setSelectedId] = useState(
    new URLSearchParams(location.search).get("project") ?? "",
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [form, setForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [attention, setAttention] = useState(false);
  const [taskId, setTaskId] = useState<string>();
  const readSequence = useRef(0);
  async function load(signal?: AbortSignal) {
    const seq = ++readSequence.current;
    const rows = await readApi("/api/project-records", projectRecordsSchema, {
      signal,
    });
    if (seq === readSequence.current) {
      setProjects(rows);
      setLoading(false);
      setError("");
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setInterval> | undefined;
    readApi("/api/bootstrap", bootstrapSchema, { signal: controller.signal })
      .then(async (b) => {
        setBoot(b);
        await load(controller.signal);
        timer = setInterval(() => {
          load(controller.signal).catch((e) => {
            if (!controller.signal.aborted)
              setError(e instanceof Error ? e.message : "记录读取失败");
          });
        }, REFRESH_MS);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setError(e instanceof Error ? e.message : "连接失败");
        }
      });
    return () => {
      controller.abort();
      clearInterval(timer);
      readSequence.current++;
    };
  }, []);
  const project = projects.find((p) => p.id === selectedId) ?? projects[0];
  const allTasks = project?.specs.flatMap((s) => s.tasks) ?? [];
  const taskSpec = project?.specs.find((spec) =>
    spec.tasks.some((t) => t.id === taskId),
  );
  const task = taskSpec?.tasks.find((t) => t.id === taskId);
  const needsAttention = (t: RecordedTask) =>
    Boolean(
      t.blocker || t.phase === "unknown" || t.phase === "awaiting_review",
    );
  const search = query.trim().toLocaleLowerCase();
  const visible = (project?.specs ?? [])
    .map((spec, index) => ({
      ...spec,
      accent: specAccent(index),
      visibleTasks: spec.tasks.filter(
        (t) =>
          (!attention || needsAttention(t)) &&
          (!search ||
            `${spec.title} ${t.title} ${t.blocker ?? ""}`
              .toLocaleLowerCase()
              .includes(search)),
      ),
    }))
    .filter((s) => s.visibleTasks.length || (!attention && !search));
  const visibleTasks = visible.flatMap((spec) => spec.visibleTasks);
  const phases = recordPhaseSchema.options;
  async function sync(root: string, name?: string) {
    if (!boot || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const client = new Client({
      name: "mingting-project-records",
      version: "1",
    });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL("/mcp", location.origin), {
          requestInit: { headers: { "x-csrf-token": boot.csrf } },
        }),
      );
      const reply = CallToolResultSchema.parse(
        await client.callTool({
          name: "sync_project_records",
          arguments: {
            projectRoot: root,
            ...(name ? { projectName: name } : {}),
          },
        }),
      );
      if (reply.isError)
        throw new Error(
          reply.content.find((c) => c.type === "text")?.text ?? "同步失败",
        );
      const receipt = syncProjectRecordsReceiptSchema.parse(
        reply.structuredContent,
      );
      await load();
      chooseProject(receipt.projectId);
      setForm(false);
      setNotice("项目记录已同步");
    } catch (e) {
      setError(e instanceof Error ? e.message : "同步失败");
    } finally {
      await client.close();
      setBusy(false);
    }
  }
  function chooseProject(id: string) {
    setSelectedId(id);
    setTaskId(undefined);
    setQuery("");
    setAttention(false);
    const url = new URL(location.href);
    url.searchParams.set("project", id);
    history.replaceState(null, "", url);
  }
  return (
    <>
      <header className="topbar">
        <a className="brand" href="/">
          {" "}
          <span className="brand-mark">明</span> 明庭{" "}
          <span className="version">WORKSPACE</span>
        </a>
        <div className="connection">
          <span className={`connection-dot ${error ? "offline" : ""}`} />
          {error ? "连接待检查" : "本机工作空间"}
        </div>
      </header>
      <PageNav current="records" />
      <main className="records-workspace">
        <div className="records-heading">
          <div>
            <div className="eyebrow">PROJECTS / 项目记录</div>
            <h1>看清每个项目的下一步。</h1>
            <p className="subtitle">按 Spec 查看任务进展，随时回到原始依据。</p>
          </div>
          <div className="records-actions">
            {project && (
              <button
                className="records-secondary"
                disabled={busy}
                onClick={() => void sync(project.root)}
              >
                刷新记录
              </button>
            )}
            <button
              className="records-primary"
              disabled={!boot || busy}
              onClick={() => setForm(!form)}
            >
              {form ? "收起接入" : "接入项目"}
            </button>
          </div>
        </div>
        {form && boot && (
          <ConnectProjectForm
            csrf={boot.csrf}
            busy={busy}
            onConnect={(root, name) => void sync(root, name)}
          />
        )}
        {error && (
          <p className="records-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="records-notice" role="status">
            {notice}
          </p>
        )}
        {loading ? (
          <div className="records-empty">正在读取项目记录…</div>
        ) : !project ? (
          <div className="records-empty">
            <div className="records-empty-mark">▦</div>
            <h2>把开发进度放在一起。</h2>
            <p>接入一个项目，查看它的 Spec、Task 和交付记录。</p>
            <button className="records-primary" onClick={() => setForm(true)}>
              接入第一个项目
            </button>
          </div>
        ) : (
          <>
            <div className="records-projects" role="tablist" aria-label="项目">
              {projects.map((p) => (
                <button
                  role="tab"
                  key={p.id}
                  aria-selected={p.id === project.id}
                  onClick={() => chooseProject(p.id)}
                >
                  <span>{p.name}</span>
                  <small>{p.specs.length} Spec</small>
                  {p.syncError && <span aria-label="同步待检查">!</span>}
                </button>
              ))}
            </div>
            <section className="records-summary" aria-label="项目摘要">
              <div>
                <strong>{project.name}</strong>
                <span>
                  {project.specs.length} 个 Spec · {allTasks.length} 个 Task
                </span>
              </div>
              <div className="records-summary-progress">
                <strong>
                  {allTasks.filter((t) => t.phase === "completed").length}
                  <span>/{allTasks.length}</span>
                </strong>
                <span>任务已完成</span>
              </div>
              <div className="records-observed">
                <span>最近同步</span>
                <time dateTime={project.observedAt}>
                  {displayTime(project.observedAt)}
                </time>
              </div>
            </section>
            {project.syncError && (
              <p className="records-error" role="alert">
                同步待恢复 · {project.syncError}。当前保留上次成功读取的记录。
              </p>
            )}
            <div className="records-toolbar">
              <label className="records-search">
                <span>⌕</span>
                <input
                  type="search"
                  aria-label="搜索 Spec 或 Task"
                  placeholder="搜索 Spec 或 Task"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <button
                className={`records-attention ${attention ? "selected" : ""}`}
                aria-pressed={attention}
                onClick={() => setAttention(!attention)}
              >
                待关注 <span>{allTasks.filter(needsAttention).length}</span>
              </button>
              <span className="records-toolbar-note">状态来自项目文档</span>
            </div>
            {!visible.length ? (
              <div className="records-empty">
                <h2>
                  {project.specs.length
                    ? "当前筛选下暂无记录"
                    : "项目中暂无 Spec"}
                </h2>
                <p>
                  {project.specs.length
                    ? "调整关键词或关注筛选，查看其他任务。"
                    : "在 docs/spec 下建立 Spec 后刷新记录。"}
                </p>
              </div>
            ) : (
              <div
                className="records-board"
                role="region"
                aria-label="Spec 任务状态看板"
                tabIndex={0}
              >
                <div className="records-grid records-board-header">
                  <div>SPEC / 工作范围</div>
                  {phases.map((phase) => (
                    <div key={phase}>
                      <i className={`records-dot ${phase}`} />
                      {recordPhaseLabels[phase]}
                      <span>
                        {visibleTasks.filter((t) => t.phase === phase).length}
                      </span>
                    </div>
                  ))}
                </div>
                {visible.map((spec) => (
                  <section
                    className="records-grid records-lane"
                    key={spec.id}
                    aria-label={spec.title}
                  >
                    <div className="records-spec">
                      <span className="records-spec-label">
                        <span
                          aria-hidden="true"
                          style={{ backgroundColor: spec.accent }}
                        />
                        SPEC
                      </span>
                      <h2>{spec.title}</h2>
                      <p>{spec.goal}</p>
                      <span className="records-spec-count">
                        {
                          spec.tasks.filter((t) => t.phase === "completed")
                            .length
                        }
                        /{spec.tasks.length} Task 已完成
                      </span>
                    </div>
                    {phases.map((phase) => (
                      <div
                        className="records-column"
                        key={phase}
                        aria-label={`${recordPhaseLabels[phase]}任务`}
                      >
                        {spec.visibleTasks
                          .filter((t) => t.phase === phase)
                          .map((t) => (
                            <button
                              className="records-card"
                              style={{ borderInlineStartColor: spec.accent }}
                              key={t.id}
                              onClick={() => setTaskId(t.id)}
                              aria-label={`查看开发任务：${t.title}`}
                            >
                              <span className="records-card-type">
                                TASK <span>↗</span>
                              </span>
                              <h3>{t.title}</h3>
                              {t.blocker && (
                                <span className="records-blocker">
                                  阻塞 · {t.blocker}
                                </span>
                              )}
                              {t.steps.length > 0 ? (
                                <span className="records-card-progress">
                                  {
                                    t.steps.filter((s) => s.status === "passed")
                                      .length
                                  }
                                  /{t.steps.length} 步骤已验证
                                </span>
                              ) : (
                                <span className="records-card-progress">
                                  {recordPhaseLabels[t.phase]}
                                </span>
                              )}
                            </button>
                          ))}
                      </div>
                    ))}
                  </section>
                ))}
              </div>
            )}
            <p className="records-footnote">
              每个 Task 保留自己的状态与依据。文档更新后，记录会自动同步。
              <span>左右滚动查看全部阶段。</span>
            </p>
          </>
        )}
      </main>
      {project && taskSpec && task && (
        <TaskDetail
          key={task.id}
          project={project}
          specTitle={taskSpec.title}
          task={task}
          close={() => setTaskId(undefined)}
        />
      )}
    </>
  );
}
