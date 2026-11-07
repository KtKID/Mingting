# 任务处理

> 草稿，待用户检查。

## 功能描述

任务服务处理从发布到结束的一整笔任务。它决定谁能领取、接受哪些进度回报、如何审批，以及取消、重试和连接中断后的状态。

## 设计理念

所有入口共用发布规则。领取时写入限时的执行资格，回报时核对资格和顺序号，避免两个连接器或迟到的回报改写同一次运行。任务、运行和审批一起提交到数据库，客户端再看到更新。 [订阅与领取](../../../docs/HARNESS-SUBSCRIPTIONS.md#h2-定向发布) · [审批裁决](../../../docs/APPROVALS.md#a3-用户优先与十秒窗口)

## 使用方式

接口层从 [createPlatform(config)](../transport/http.ts#L26) 取得 `service`。例如调用 `service.publish(input)`，传入符合 [任务发布定义](../../shared/protocol.ts) 的任务内容，取得任务和订阅回执。连接器通过 [HTTP 接口](../transport/readme.md) 领取并回报，网页通过同一服务取消、重试和裁决审批。测试入口见 [平台集成测试](../../../tests/platform.test.ts)。

## 代码说明

[TaskService](service.ts) 是网页、MCP 和连接器共用的入口，负责组装模块、广播事件和服务启停。[sweep()](service.ts#L253) 依次检查租约、执行时限、审批时限和用户优先窗口。运行结束时，任务状态、运行状态和待审记录在同一事务内更新。

| 模块 | 负责的规则 |
| --- | --- |
| [publication.ts](publication.ts) | 校验新建与追加，保存轮次、订阅凭据、发布来源和领取事件。旧 DSH 发单在这里保留独立的兼容入口。成功提交后通知连接器。 |
| [harness-registry.ts](harness-registry.ts) | 记录在线执行器、连接代次和能力快照。领取时校验身份是否符合任务指定的执行器。 |
| [runs.ts](runs.ts) | 领取、续期、回报、取消、同轮重试和运行收尾。领取事件绑定任务轮次，回报按单次运行的序号处理。 |
| [approvals.ts](approvals.ts) | 受理审批请求、读取和提交裁决、处理超时与过期。订阅者先给出意见时，网页用户在优先窗口内可直接裁决。 |
| [publisher-subscriptions.ts](publisher-subscriptions.ts) | 分别校验结果和审批订阅凭据，提供结果重放、待审快照和限时等待。 |
| [wakeup/receipts.ts](../wakeup/receipts.ts) | 查询 Codex 聊天唤醒状态，分别校验 DSH 宿主和 Codex 聊天回执。 |
| [progress.ts](progress.ts) | 将运行通知整理为正文、公开思考和工具进度，按工具调用 ID 合并增量，裁剪展示内容并遮盖常见凭据字段。 |

传输层把实际收发交给存储层，由存储层分配任务内的下一个 `seq`。[taskMessage()](../transport/task-communication.ts#L7) · [taskExchange()](../transport/task-communication.ts#L21) · [Store.communication()](../storage/store.ts#L232)

## spec 索引

| Spec                                                                                   | 与模块的关系                                                                                                                        |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [统一发单与结果订阅](../../../docs/spec/unified-task-publishing/spec.md)               | 发布回执、审批与结果订阅分开处理，断线后可补读结果。[技术设计](../../../docs/spec/unified-task-publishing/tech-design.md)           |
| [DSH 原会话唤醒](../../../docs/spec/dsh-task-wakeups/spec.md)                          | 发布时持久绑定会话及轮次，校验该宿主的完成确认。[技术设计](../../../docs/spec/dsh-task-wakeups/tech-design.md)                      |
| [Codex 设置、审批审计和用量](../../../docs/spec/codex-task-settings-and-audit/spec.md) | 服务校验设置回执、按次记录运行事件和用量，供详情页查询。[技术设计](../../../docs/spec/codex-task-settings-and-audit/tech-design.md) |
