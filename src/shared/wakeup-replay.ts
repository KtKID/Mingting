import { z } from "zod";
import { wakeupEventSchema, wakeupTargetSchema } from "./task-wakeup.js";

const itemSchema = z
  .object({
    type: z.string(),
    phase: z.string().optional(),
    text: z.string().optional(),
    command: z.string().optional(),
    content: z
      .array(
        z
          .object({ type: z.string(), text: z.string().optional() })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
export const wakeupReplaySchema = z
  .object({
    mode: z.enum(["real", "fixture"]),
    taskId: z.string().uuid(),
    target: wakeupTargetSchema,
    events: z.array(wakeupEventSchema),
    threadTrace: z
      .object({
        thread: z.object({ id: z.string() }).passthrough(),
        turns: z.array(
          z
            .object({
              id: z.string(),
              status: z.string(),
              startedAt: z.number(),
              completedAt: z.number().nullable(),
              items: z.array(itemSchema),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
  })
  .strict();
export type WakeupReplay = z.infer<typeof wakeupReplaySchema>;

export function validateWakeupReplay(raw: unknown) {
  const report = wakeupReplaySchema.parse(raw);
  const failures: string[] = [];
  if (report.mode !== "real")
    failures.push("真实验收需要实际宿主记录；当前输入标记为fixture");
  if (report.threadTrace.thread.id !== report.target.threadId)
    failures.push("宿主记录的聊天身份不匹配");
  const turns = report.threadTrace.turns;
  const ended = (turnId: string) => {
    const turn = turns.find((item) => item.id === turnId);
    return (
      turn?.status === "completed" &&
      turn.completedAt !== null &&
      turn.items.some(
        (item) => item.type === "agentMessage" && item.phase === "final",
      )
    );
  };
  if (!ended(report.target.originTurnId))
    failures.push("发布回合缺少实际结束记录");
  const approvals = report.events.filter(
    (event) => event.type === "approval.requested",
  );
  const completions = report.events.filter(
    (event) => event.type === "task.completed",
  );
  if (approvals.length !== 1 || completions.length !== 1)
    failures.push("本用例要求一张审批与一次完成事件");
  const resumed = new Set<string>();
  for (const event of report.events) {
    if (
      event.taskId !== report.taskId ||
      event.target.threadId !== report.target.threadId ||
      event.target.originTurnId !== report.target.originTurnId
    )
      failures.push(`${event.id} 的归属不匹配`);
    if (
      event.status !== "acknowledged" ||
      !event.deliveredAt ||
      !event.resumedTurnId ||
      !event.acknowledgedAt ||
      event.receipt == null
    )
      failures.push(`${event.id} 缺投递或恢复确认`);
    const receipt = z
      .object({
        source: z.literal("codex-acp/session/prompt"),
        result: z
          .object({
            sessionId: z.string().uuid(),
            accepted: z.literal(true),
            agentInfo: z
              .object({ name: z.string(), version: z.string() })
              .passthrough(),
          })
          .passthrough(),
      })
      .safeParse(event.receipt);
    if (!receipt.success) failures.push(`${event.id} 缺实际宿主消息投递回执`);
    if (receipt.success) {
      if (receipt.data.result.sessionId !== report.target.threadId)
        failures.push(`${event.id} 的 ACP 会话编号不匹配`);
      if (
        /fixture|fake|test/i.test(receipt.data.result.agentInfo.name) ||
        z
          .object({ source: z.literal("test-fixture") })
          .safeParse(receipt.data.result).success
      )
        failures.push(`${event.id} 的消息投递来自测试夹具`);
    }
    if (
      event.deliveredAt &&
      event.acknowledgedAt &&
      !(
        Date.parse(event.createdAt) <= Date.parse(event.deliveredAt) &&
        Date.parse(event.deliveredAt) <= Date.parse(event.acknowledgedAt)
      )
    )
      failures.push(`${event.id} 的发生、投递和恢复时间顺序错误`);
    if (
      event.resumedTurnId === report.target.originTurnId ||
      (event.resumedTurnId && resumed.has(event.resumedTurnId))
    )
      failures.push(`${event.id} 复用了已有回合`);
    if (event.resumedTurnId) resumed.add(event.resumedTurnId);
    const turn = turns.find((item) => item.id === event.resumedTurnId);
    const marker = `[MINGTING_EVENT ${event.id}]`;
    if (
      !turn?.items.some(
        (item) =>
          item.type === "userMessage" &&
          item.content?.some(
            (content) =>
              content.type === "text" && content.text?.includes(marker),
          ),
      )
    )
      failures.push(`${event.id} 缺宿主入站事件消息`);
    if (
      turn?.items.some(
        (item) =>
          item.type === "commandExecution" &&
          /\bwatch(?:\.mjs|\s)|wait_for_approval|mingting-client\.mjs\s+wait|curl[^\n]*(?:-N|--no-buffer)/.test(
            item.command ?? "",
          ),
      )
    )
      failures.push(`${event.id} 的恢复回合包含主动等待`);
  }
  const approval = approvals[0],
    completion = completions[0];
  if (approval && completion && approval.runId !== completion.runId)
    failures.push("审批与完成属于不同运行");
  if (approval?.resumedTurnId && !ended(approval.resumedTurnId))
    failures.push("审批回合缺少实际结束记录");
  const order = (turnId: string | null | undefined) =>
    turns.findIndex((turn) => turn.id === turnId);
  // read_thread returns newest first.
  if (
    approval &&
    completion &&
    !(
      order(completion.resumedTurnId) >= 0 &&
      order(completion.resumedTurnId) < order(approval.resumedTurnId) &&
      order(approval.resumedTurnId) < order(report.target.originTurnId)
    )
  )
    failures.push("实际回合顺序不符合两阶段唤醒");
  const originTurn = turns.find(
    (turn) => turn.id === report.target.originTurnId,
  );
  const approvalTurn = turns.find(
    (turn) => turn.id === approval?.resumedTurnId,
  );
  const completionTurn = turns.find(
    (turn) => turn.id === completion?.resumedTurnId,
  );
  if (
    originTurn &&
    approvalTurn &&
    (originTurn.completedAt === null ||
      approvalTurn.startedAt < originTurn.completedAt)
  )
    failures.push("审批回合在发布回合结束前启动");
  if (
    approvalTurn &&
    completionTurn &&
    (approvalTurn.completedAt === null ||
      completionTurn.startedAt < approvalTurn.completedAt)
  )
    failures.push("完成回合在审批回合结束前启动");
  return {
    passed: failures.length === 0,
    failures,
    taskId: report.taskId,
    threadId: report.target.threadId,
    resumedTurns: [...resumed],
  };
}

export function renderWakeupReplay(raw: unknown) {
  const report = wakeupReplaySchema.parse(raw);
  const result = validateWakeupReplay(report);
  const frames = [
    report.target.originTurnId,
    ...report.events.map((event) => event.resumedTurnId),
  ]
    .filter((id): id is string => id !== null)
    .map((id) => {
      const turn = report.threadTrace.turns.find((item) => item.id === id);
      return {
        turnId: id,
        status: turn?.status ?? "缺回合",
        events: report.events.filter((event) => event.resumedTurnId === id),
        messages:
          turn?.items.filter((item) =>
            ["userMessage", "agentMessage"].includes(item.type),
          ) ?? [],
      };
    });
  const data = JSON.stringify({ result, mode: report.mode, frames }).replaceAll(
    "<",
    "\\u003c",
  );
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>明庭聊天唤醒回放</title><style>body{font:16px system-ui;margin:36px auto;max-width:1000px;padding:0 24px;color:#182333;background:#fafafa}button{padding:10px 20px;margin-right:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;padding:20px;border:1px solid #ddd}h1{font-size:24px}</style><h1>明庭聊天唤醒回放</h1><p id="verdict"></p><button id="prev">上一步</button><button id="next">下一步</button><p id="step"></p><pre id="frame"></pre><pre id="checks"></pre><script>const data=${data};let i=0;const show=()=>{document.getElementById('verdict').textContent=(data.mode==='real'?'真实记录':'测试夹具')+' · '+(data.result.passed?'通过':'未通过');document.getElementById('step').textContent='回合 '+(i+1)+' / '+data.frames.length;document.getElementById('frame').textContent=JSON.stringify(data.frames[i],null,2);document.getElementById('checks').textContent=JSON.stringify(data.result,null,2);};document.getElementById('prev').onclick=()=>{i=Math.max(0,i-1);show();};document.getElementById('next').onclick=()=>{i=Math.min(data.frames.length-1,i+1);show();};show();</script></html>`;
}
