# 执行器订阅：Codex、Grok、ZCode、DeepSeek 等执行器上线登记、领任务、执行并回报

> 模块：harness-subscriptions
> 管哪些代码：src/connector/、src/server/harness/、src/server/tasks/harness-registry.ts、src/server/transport/connector.ts
> 状态：在用
> 最近更新：2026-11-16

## 功能正文

功能说明原地维护在 [HARNESS-SUBSCRIPTIONS.md](../../HARNESS-SUBSCRIPTIONS.md)，本文件只做这个模块的 spec 入口和 task 归类，不重复正文。

## 任务

- [task-acp-offline-replay](tasks/task-acp-offline-replay.md)：真实 ACP 运行离线回放
- [task-acp-streaming](tasks/task-acp-streaming.md)：各 Harness ACP 与网页实时执行过程
- [task-harness-subscriptions](tasks/task-harness-subscriptions.md)：Harness 身份订阅与定向问候验证
- [task-multi-harness-acp](tasks/task-multi-harness-acp.md)：ZCode、Grok 与 DeepSeek Harness 接入统一 ACP 审计
- [task-web-reconnect](tasks/task-web-reconnect.md)：网页实时连接自动恢复
- [task-zcode-model-selection](tasks/task-zcode-model-selection.md)：ZCode 模型选择与问候回传

## 变更记录

| 日期 | 改了什么 | task | 状态 |
|---|---|---|---|
| 2026-11-16 | 建立模块 spec，把原 docs/task/ 下属于本模块的 6 个 task 挪到 tasks/ | 见上方任务列表 | 已完成 |
