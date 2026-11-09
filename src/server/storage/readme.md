# 服务端存储

> 草稿，待用户检查。

## 功能描述

这里保存任务、运行、审批和待投递事件，也为审批报告网页读取历史回归批次。

## 设计理念

任务状态和该状态产生的通知一起保存，事务提交后再告诉订阅者。事务把一组写入当成一个整体，失败时一起回滚。服务重启时使旧领取失效，并让连接器重新看到排队任务。审批回放批次各自保存输入和报告，网页可切回以前的批次。 [运行审计设计](../../../docs/spec/codex-task-settings-and-audit/tech-design.md) · [审批归档](../../../docs/APPROVALS.md#a5-默认自动回归与批次留存)

## 使用方式

应用通过 [createPlatform(config)](../transport/http.ts#L48) 传入 `dbPath` 并取得 `store`。查询任务可调用 `store.detail(taskId)`，按次读取审计可调用 `store.runAudit(runId, after, limit)`。写入由 [任务服务](../tasks/readme.md) 协调。审批报告页从 `GET /approval-tests/data/history.json` 取得批次索引。

## 代码说明

### [store.ts](store.ts)

`Store` 打开本机 SQLite，创建或更新所需表和索引。任务、运行、审批及待投事件使用同一数据库，方便在同一个事务内保存相互关联的变化。

| 方法                                                                                                                      | 处理过程与结果                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [transaction()](store.ts#L115)、[publish()](store.ts#L166)、[deliver()](store.ts#L486)                                    | 提交后通知客户端，失败时回滚。发布保存排队任务和可选会话目标，`deliver()` 追加带游标的任务可领取事件。 |
| [saveRun()](store.ts#L205)、[saveApproval()](store.ts#L214)、[enqueueWakeup()](store.ts#L253)                             | 保存运行与审批，按任务和运行归属记录完成或待审批事件。写入使用稳定事件 ID。                            |
| [pendingWakeups()](store.ts#L305)、[pendingHostWakeup()](store.ts#L320)、[browserWakeupSummary()](store.ts#L234)           | 分别读取待调度事件、指定宿主待确认事件，以及网页使用的绑定和投递摘要。                                 |
| [appendEvent()](store.ts#L400)、[appendRunAudit()](store.ts#L410)、[runAudit()](store.ts#L417)、[detail()](store.ts#L434) | 保存近期事件与按次审计，分页读回旧记录。任务详情汇总各次运行的用量，并保留缺项。                       |
| [lease()](store.ts#L519)、[saveLease()](store.ts#L534)、[recover()](store.ts#L561)、[close()](store.ts#L585)              | 保存连接器的执行资格和回报进度。重启时中断旧运行、使待审项过期、补发排队任务。关闭时释放数据库。       |

### [approval-history.ts](approval-history.ts)

[readApprovalHistory(root)](approval-history.ts#L9) 扫描 `runs/` 下以批次 ID 命名的目录，读取并校验批次清单，再按启动时间倒序返回。没有清单的目录可等下次再读，清单格式或身份不符时报告错误，避免网页把损坏记录当作有效批次。

## spec 索引

| Spec 或功能记录                                                              | 与模块的关系                                                                                                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [Codex 审计与用量](../../../docs/spec/codex-task-settings-and-audit/spec.md) | 按运行保存审计并聚合用量。[审计存储任务](../../../docs/spec/codex-task-settings-and-audit/tasks/task-run-audit-foundation/dev-checklist.md) |
| [统一发单与结果订阅](../../../docs/spec/unified-task-publishing/spec.md)     | 保存结果订阅凭据、历史运行及唤醒状态。[存储设计](../../../docs/spec/unified-task-publishing/tech-design.md)                                 |
| [DSH 原会话唤醒](../../../docs/spec/dsh-task-wakeups/spec.md)                | 保存宿主、会话、轮次和完成事件，供重连补收。[开发记录](../../../docs/spec/dsh-task-wakeups/tasks/task-dsh-wakeups/dev-checklist.md)         |
| [审批回归与批次留存](../../../docs/APPROVALS.md#a5-默认自动回归与批次留存)   | 审批归档索引的功能说明。[归档开发记录](../../../docs/task/task-approval-default-regression.md)                                              |
