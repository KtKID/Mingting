# spec 目录

一个模块功能一份 spec，长期更新。每个 task 都放在所属 spec 的 `tasks/` 下面；task 开头写明所属 spec、状态、执行者和创建日期。

| 模块 | 说明 | task 数 | 来源 |
|---|---|---|---|
| [codex-task-settings-and-audit](codex-task-settings-and-audit/spec.md) | Codex 任务设置、过程审计与用量对账 | 5 | 原有 |
| [dsh-task-wakeups](dsh-task-wakeups/spec.md) | DSH 发布明庭任务后唤醒原会话 | 1 | 原有 |
| [task-board-dispatch](task-board-dispatch/spec.md) | 明庭任务中台：发布登记与手动派发 | 4 | 原有 |
| [task-turns-and-seq](task-turns-and-seq/spec.md) | 同一任务的多轮沟通与通信计数 | 0 | 原有 |
| [unified-task-publishing](unified-task-publishing/spec.md) | 统一发布明庭任务和订阅结果 | 6 | 原有 |
| [approvals](approvals/spec.md) | 审批：执行者要权限时，由任务发起方或用户来批 | 4 | 新建（链到原模块说明） |
| [chat-wakeups](chat-wakeups/spec.md) | 当前聊天的事件唤醒：审批或任务完成后，叫醒发起任务的那个聊天 | 2 | 新建（链到原模块说明） |
| [harness-subscriptions](harness-subscriptions/spec.md) | 执行器订阅：Codex、Grok、ZCode、DeepSeek 等执行器上线登记、领任务、执行并回报 | 6 | 新建（链到原模块说明） |
| [engineering](engineering/spec.md) | 工程杂活：不属于任何功能模块的维护工作 | 0 | 新建 |

## 待定

下面 2 个 task 还没决定归到哪个模块，暂时留在 `docs/task/`：

| task | 为什么待定 | 建议 |
|---|---|---|
| [task-connector-execution-refactor](../task/task-connector-execution-refactor.md) | 功能文档指向 `src/connector/readme.md`，技术依据却是 codex-task-settings-and-audit 的设计 | 归 harness-subscriptions 或 codex-task-settings-and-audit，二选一 |
| [task-server-module-layout](../task/task-server-module-layout.md) | 只是服务端源码挪目录，不改功能 | 归 engineering |
