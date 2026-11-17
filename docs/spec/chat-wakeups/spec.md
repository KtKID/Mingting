# 当前聊天的事件唤醒：审批或任务完成后，叫醒发起任务的那个聊天

> 模块：chat-wakeups
> 管哪些代码：src/server/wakeup/、src/server/transport/host-wakeup.ts、src/shared/host-wakeup.ts、src/shared/task-wakeup.ts、scripts/chat-wakeup-live.ts
> 状态：在用
> 最近更新：2026-11-16

## 功能正文

功能说明原地维护在 [CHAT-WAKEUPS.md](../../CHAT-WAKEUPS.md)，本文件只做这个模块的 spec 入口和 task 归类，不重复正文。

## 任务

- [task-chat-wakeups](tasks/task-chat-wakeups.md)：审批和任务完成恢复当前聊天
- [task-web-wakeup-status](tasks/task-web-wakeup-status.md)：在任务详情查看 MCP 唤醒

## 变更记录

| 日期 | 改了什么 | task | 状态 |
|---|---|---|---|
| 2026-11-16 | 建立模块 spec，把原 docs/task/ 下属于本模块的 2 个 task 挪到 tasks/ | 见上方任务列表 | 已完成 |
