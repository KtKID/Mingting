# 审批：执行者要权限时，由任务发起方或用户来批

> 模块：approvals
> 管哪些代码：src/server/tasks/approvals.ts、src/server/storage/approval-history.ts、src/shared/approval*.ts、src/web/approval-*.tsx、scripts/approval-*.ts
> 状态：在用
> 最近更新：2026-11-16

## 功能正文

功能说明原地维护在 [APPROVALS.md](../../APPROVALS.md)，本文件只做这个模块的 spec 入口和 task 归类，不重复正文。

## 任务

- [task-approval-default-regression](tasks/task-approval-default-regression.md)：审批默认自动回归与批次留存
- [task-approval-replay](tasks/task-approval-replay.md)：真实审批数据复用与网页端到端回放
- [task-approvals](tasks/task-approvals.md)：发起方订阅审批与用户优先
- [task-automatic-regression](tasks/task-automatic-regression.md)：默认自动回归覆盖任务和审批网页

## 变更记录

| 日期 | 改了什么 | task | 状态 |
|---|---|---|---|
| 2026-11-16 | 建立模块 spec，把原 docs/task/ 下属于本模块的 4 个 task 挪到 tasks/ | 见上方任务列表 | 已完成 |
