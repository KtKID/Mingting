import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  replayReportSchema,
  approvalHistorySchema,
  type ReplayReport,
} from "../shared/approval-replay";
import { z } from "zod";
import "./approval-report.css";

const word = (value: string | null | undefined) =>
  value === "allow_once" ? "同意" : value === "deny" ? "拒绝" : "未决定";
function Report() {
  const [report, setReport] = useState<ReplayReport>();
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("R1");
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [history, setHistory] =
    useState<z.infer<typeof approvalHistorySchema>>();
  const [selectedBatch, setSelectedBatch] = useState(
    () => new URLSearchParams(window.location.search).get("run") ?? "",
  );
  const batch =
    history?.runs.find((run) => run.id === selectedBatch) ?? history?.runs[0];
  const reportPath = batch?.reportPath ?? "run.json";
  useEffect(() => {
    let live = true;
    const refresh = async () => {
      try {
        const response = await fetch("/approval-tests/data/history.json", {
          cache: "no-store",
        });
        if (!response.ok) throw new Error("读取历史批次失败");
        const next = approvalHistorySchema.parse(await response.json());
        if (live) setHistory(next);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "历史数据无效");
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    let live = true;
    setReport(undefined);
    const refresh = async () => {
      try {
        const response = await fetch("/approval-tests/data/" + reportPath, {
          cache: "no-store",
        });
        if (!response.ok) throw new Error("测试记录正在准备");
        const next = replayReportSchema.parse(await response.json());
        if (live) {
          setReport(next);
          setError("");
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "读取记录失败");
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [reportPath]);
  const item = report?.cases.find((c) => c.id === selected);
  const steps = item?.steps.filter((s) => s.image) ?? [];
  const step = steps[Math.min(index, Math.max(0, steps.length - 1))];
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(
      () =>
        setIndex((value) => {
          if (value >= steps.length - 1) {
            setPlaying(false);
            return value;
          }
          return value + 1;
        }),
      1600,
    );
    return () => clearInterval(timer);
  }, [playing, steps.length]);
  const approval = item?.detail?.approvals[0];
  return (
    <main>
      <header>
        <a href="/?theme=light">← 返回任务台</a>
        <span>明庭 / 审批验证</span>
      </header>
      <section className="intro">
        <div>
          <p className="eyebrow">审批回放</p>
          <h1>审批端到端测试</h1>
          <p>
            使用固定输入自动走完审批。选择批次和用例，查看实际操作、自动判定和完整结果。
          </p>
        </div>
        <div className="score">
          <b>
            {report?.cases.filter((c) => c.passed).length ?? 0}
            <small> / {report?.cases.length ?? 10}</small>
          </b>
          <span>用例通过</span>
        </div>
      </section>
      <div className="batch-picker">
        <label>
          测试批次
          <select
            aria-label="测试批次"
            value={batch?.id ?? ""}
            onChange={(event) => {
              setSelectedBatch(event.target.value);
              setIndex(0);
              setPlaying(false);
            }}
          >
            {history?.runs.map((run) => (
              <option key={run.id} value={run.id}>
                {new Date(run.startedAt).toLocaleString("zh-CN")} ·{" "}
                {run.mode === "default"
                  ? "默认回归"
                  : run.mode === "approval"
                    ? "审批专项"
                    : "原始可见回放"}{" "}
                ·{" "}
                {
                  {
                    running: "执行中",
                    passed: "通过",
                    failed: "失败",
                    interrupted: "已中断",
                  }[run.status]
                }{" "}
                {run.passed}/{run.caseCount}
              </option>
            ))}
          </select>
        </label>
        <span>{history?.runs.length ?? 0} 个批次已保留</span>
      </div>
      <p className="boundary">
        模型和文件工具使用回放输入。MCP、订阅连接器、ACP、数据库、网页操作和十秒裁决实际执行。
      </p>
      {batch && (
        <div className="batch-meta">
          本轮环境：{report?.platform ?? "准备中"} · 批次 {batch.id}
          <div className="stage-results">
            {batch.stages.map((stage) => (
              <a
                key={stage.name}
                className={stage.exitCode === 0 ? "pass" : "fail"}
                href={"/approval-tests/data/" + stage.logPath}
                target="_blank"
                rel="noreferrer"
              >
                {
                  {
                    recording: "录制输入",
                    unit: "单元检查",
                    build: "构建",
                    approval: "审批10用例",
                  }[stage.name]
                }{" "}
                · {stage.exitCode === 0 ? "通过" : "失败"} ↗
              </a>
            ))}
          </div>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {report?.error && <p role="alert">{report.error}</p>}
      <div className="layout">
        <nav aria-label="审批用例">
          {report?.cases.map((c) => (
            <button
              key={c.id}
              className={c.id === selected ? "selected" : ""}
              onClick={() => {
                setSelected(c.id);
                setIndex(0);
                setPlaying(false);
              }}
            >
              <span>
                <b>{c.id}</b>
                {c.title.replace(/^【.*?】/, "")}
              </span>
              <em className={c.passed ? "pass" : ""}>{c.phase}</em>
            </button>
          ))}
        </nav>
        <article>
          {item && (
            <>
              <div className="case-heading">
                <div>
                  <p className="eyebrow">{item.id} · 操作回放</p>
                  <h2>{item.title.replace(/^【.*?】/, "")}</h2>
                </div>
                {item.taskId &&
                  report &&
                  (!batch || batch.mode === "manual") &&
                  new URL(report.platform).origin ===
                    window.location.origin && (
                    <a
                      className="task-link"
                      href={`/?theme=light&task=${encodeURIComponent(item.taskId)}`}
                    >
                      查看平台任务 ↗
                    </a>
                  )}
                {item.snapshotPath && batch && batch.mode !== "manual" && (
                  <a
                    className="task-link"
                    href={"/approval-tests/data/" + item.snapshotPath}
                    target="_blank"
                    rel="noreferrer"
                  >
                    查看本轮任务快照 ↗
                  </a>
                )}
              </div>
              <div className="decisions">
                <div>
                  订阅者 Codex
                  <strong>
                    {word(approval?.reviewerDecisions[0]?.optionId)}
                  </strong>
                </div>
                <div>
                  用户<strong>{word(approval?.userDecision?.optionId)}</strong>
                </div>
                <div>
                  最终采用
                  <strong>
                    {approval?.resolvedBy === "user"
                      ? "用户"
                      : approval?.resolvedBy === "subscriber"
                        ? "订阅者"
                        : approval?.status === "expired"
                          ? "已取消"
                          : "等待决定"}
                  </strong>
                </div>
              </div>
              <div className="viewer">
                {step ? (
                  <img
                    src={"/approval-tests/data/" + step.image}
                    alt={step.label}
                  />
                ) : (
                  <div className="placeholder">等待本用例的实际操作截图</div>
                )}
              </div>
              <div className="playback">
                <button
                  disabled={!steps.length}
                  onClick={() => {
                    if (index >= steps.length - 1) setIndex(0);
                    setPlaying(!playing);
                  }}
                >
                  {playing ? "暂停" : "播放操作"}
                </button>
                <button
                  disabled={index <= 0}
                  onClick={() => {
                    setPlaying(false);
                    setIndex(index - 1);
                  }}
                >
                  上一步
                </button>
                <input
                  aria-label="操作步骤"
                  type="range"
                  min="0"
                  max={Math.max(0, steps.length - 1)}
                  value={Math.min(index, Math.max(0, steps.length - 1))}
                  onChange={(e) => {
                    setPlaying(false);
                    setIndex(Number(e.target.value));
                  }}
                />
                <button
                  disabled={index >= steps.length - 1}
                  onClick={() => {
                    setPlaying(false);
                    setIndex(index + 1);
                  }}
                >
                  下一步
                </button>
                <span>
                  {steps.length ? index + 1 : 0} / {steps.length}
                </span>
              </div>
              <p className="caption">
                {step &&
                  `${new Date(step.at).toLocaleTimeString("zh-CN")} · ${step.label}`}
                {step?.image && (
                  <>
                    {" "}
                    ·{" "}
                    <a
                      href={"/approval-tests/data/" + step.image}
                      target="_blank"
                      rel="noreferrer"
                    >
                      查看原图
                    </a>
                  </>
                )}
              </p>
              <section className="evidence">
                <div>
                  <h3>实际操作时间线</h3>
                  <ol>
                    {item.steps.map((s, i) => (
                      <li key={i}>
                        <time>
                          {new Date(s.at).toLocaleTimeString("zh-CN")}
                        </time>
                        <span>{s.label}</span>
                      </li>
                    ))}
                  </ol>
                </div>
                <div>
                  <h3>结果核对</h3>
                  <ul>
                    {item.checks.map((c, i) => (
                      <li key={i} className={c.passed ? "pass" : "fail"}>
                        {c.passed ? "✓" : "×"} {c.label}
                      </li>
                    ))}
                  </ul>
                  <h3>执行器回答</h3>
                  <pre>{item.detail?.runs[0]?.output || "等待执行结果"}</pre>
                  <p className="muted">任务 ID：{item.taskId || "尚未发布"}</p>
                </div>
              </section>
            </>
          )}
        </article>
      </div>
      <details className="sources">
        <summary>
          {report?.sources.length
            ? `本机录制 · ${report.sources.length} 份原始记录`
            : "审批回放输入"}
        </summary>
        {report?.sources.map((s) => (
          <p key={s.taskId}>
            <b>{s.taskId}</b>
            <br />
            {s.path}
            <br />
            <code>SHA-256 {s.sha256}</code>
          </p>
        ))}
        <a
          href={
            "/approval-tests/data/" + (batch?.recordingPath ?? "recording.json")
          }
        >
          查看本轮输入录制
        </a>{" "}
        · <a href={"/approval-tests/data/" + reportPath}>查看本轮完整记录</a>
      </details>
      <footer>
        原始数据只读保留 · 批次独立归档 ·{" "}
        {report?.stopped ? "本轮测试已结束" : "测试记录实时更新"}
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Report />);
