# 任务处理

> 草稿，待用户检查。

## 功能描述

任务服务处理从发布到结束的一整笔任务。它决定谁能领取、接受哪些进度回报、如何审批，以及取消、重试和连接中断后的状态。

## 设计理念

所有入口共用发布规则。领取时写入限时的执行资格，回报时核对资格和顺序号，避免两个连接器或迟到的回报改写同一次运行。任务、运行和审批一起提交到数据库，客户端再看到更新。 [订阅与领取](../../../docs/HARNESS-SUBSCRIPTIONS.md#h2-定向发布) · [审批裁决](../../../docs/APPROVALS.md#a3-用户优先与十秒窗口)

## 使用方式

接口层从 [createPlatform(config)](../transport/http.ts#L48) 取得 `service`。例如调用 `service.publish(input)`，传入符合 [任务发布定义](../../shared/protocol.ts) 的任务内容，取得任务和订阅回执。连接器通过 [HTTP 接口](../transport/readme.md) 领取并回报，网页通过同一服务取消、重试和裁决审批。测试入口见 [平台集成测试](../../../tests/platform.test.ts)。

## 代码说明

### [service.ts](service.ts)

`TaskService` 负责业务规则和事务边界，`AppError` 把业务拒绝的状态和原因交给接口层。

| 方法                                                                                                                                              | 处理过程与结果                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [publish()](service.ts#L198)、[publishFromDsh()](service.ts#L144)                                                                                 | 校验内容和唤醒目标，保存排队任务、订阅凭据与通知；宿主发布用请求标识核对重放，并检查已有任务的请求内容。 |
| [registerHarness()](service.ts#L66)、[reportCapabilities()](service.ts#L95)、[harnesses()](service.ts#L106)                                       | 登记在线连接，按连接代次接受模型能力快照，返回当前在线身份及可用选项。                                   |
| [claim()](service.ts#L428)、[heartbeat()](service.ts#L517)、[report()](service.ts#L535)                                                           | 检查目标和执行资格后开始运行，心跳续期。回报按顺序写入设置、进度、用量和终态，接受原序号重送并拒绝跳号。 |
| [permission()](service.ts#L652)、[permissionResult()](service.ts#L709)、[decide()](service.ts#L750)、[decideSubscriber()](service.ts#L756)        | 创建审批并查询裁决。订阅者先决定时等待用户窗口，网页用户的及时裁决优先。                                 |
| [approvalSnapshot()](service.ts#L369)、[waitForApproval()](service.ts#L383)、[resultStatus()](service.ts#L280)、[resultEvents()](service.ts#L292) | 按任务凭据读取待审状态、等待更新或补读已结束的运行结果。                                                 |
| [acknowledgeDshWakeup()](service.ts#L175)、[acknowledgeWakeup()](service.ts#L320)                                                                 | 核对宿主、会话或订阅凭据与通知归属，保存确认后的投递状态。                                               |
| [cancel()](service.ts#L810)、[retry()](service.ts#L827)、[sweep()](service.ts#L849)、[close()](service.ts#L899)                                   | 处理取消、显式重试、过期租约和审批窗口。停止时清理定时器和唤醒投递，持久化原运行的中断状态。             |

### [progress.ts](progress.ts)

[applyProgress(run, notification)](progress.ts#L8) 按通知类型更新正文、公开思考和工具状态。它按工具调用 ID 合并增量，裁剪显示内容，并遮盖结构化内容中的常见凭据字段，给网页提供当前运行快照。需长期核对的工具事件由任务服务另存审计记录。 [回报写入](service.ts#L535)

## spec 索引

| Spec                                                                                   | 与模块的关系                                                                                                                        |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [统一发单与结果订阅](../../../docs/spec/unified-task-publishing/spec.md)               | 发布回执、审批与结果订阅分开处理，断线后可补读结果。[技术设计](../../../docs/spec/unified-task-publishing/tech-design.md)           |
| [DSH 原会话唤醒](../../../docs/spec/dsh-task-wakeups/spec.md)                          | 发布时持久绑定会话及轮次，校验该宿主的完成确认。[技术设计](../../../docs/spec/dsh-task-wakeups/tech-design.md)                      |
| [Codex 设置、审批审计和用量](../../../docs/spec/codex-task-settings-and-audit/spec.md) | 服务校验设置回执、按次记录运行事件和用量，供详情页查询。[技术设计](../../../docs/spec/codex-task-settings-and-audit/tech-design.md) |
