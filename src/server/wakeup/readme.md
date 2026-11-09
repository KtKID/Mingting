# 聊天唤醒

> 草稿，待用户检查。

## 功能描述

这里把待审批或任务完成事件送进已授权的 Codex 聊天。外接宿主通过 [服务端接口](../transport/readme.md) 接收自己的待确认事件。

## 设计理念

事件先保存，任务提交后再投递。投递状态可在任务详情追查。进程在送出通知时中断，结果可能已经进入原聊天，因此恢复时标记待核对，由用户确认后再处理。 [聊天唤醒说明](../../../docs/CHAT-WAKEUPS.md#w3-失败与回放)

## 使用方式

按 [Codex 聊天唤醒指南](../../../docs/CHAT-WAKEUPS.md#唤醒-codex-聊天) 准备宿主。启用 `MINGTING_CODEX_WAKEUPS=1` 并配置 `CODEX_THREAD_ID` 后，服务启动时预检原会话。预检通过后，带对应 `wakeup` 目标的 MCP 任务可触发投递，详情页会显示结果。隔离回归入口是 `npm run test:chat-wakeups`。

## 代码说明

- [receipts.ts](receipts.ts) 校验 外接宿主完成通知与 Codex 聊天的回执，记录宿主确认状态和恢复轮次。Codex 查询与确认先由任务服务校验审批订阅凭据。
- [task-wakeup.ts](task-wakeup.ts) 将通知格式和宿主实现分开。[wakeupMessage(event)](task-wakeup.ts#L15) 用稳定事件 ID 和任务、运行、会话信息构建通知。[WakeupDispatcher.kick()](task-wakeup.ts#L52) 触发串行扫描，[drain()](task-wakeup.ts#L72) 跳过已失效的待审事件，并记录发送中、已投递或失败。[idle()](task-wakeup.ts#L64) 等当前队列处理完成，[close()](task-wakeup.ts#L67) 停止接收后续调度并关闭宿主。
- [codex-wakeup.ts](codex-wakeup.ts) 用 ACP 恢复已有聊天，ACP 是与执行器交换消息的协议。[configuredCodexWakeups(env)](codex-wakeup.ts#L158) 读取开关并预检，[codexWakeupConfig()](codex-wakeup.ts#L140) 组装命令和环境。[probe(threadId)](codex-wakeup.ts#L56) 成功后只授权该会话，[accepts(target)](codex-wakeup.ts#L45) 检查授权，[send(event)](codex-wakeup.ts#L70) 核对恢复身份后提交通知，收到有效输出或正常结束时确认送达。后续通知等待上一轮收尾。[close()](codex-wakeup.ts#L134) 中止当前连接并等待结束。

## spec 索引

| Spec 或功能记录                                                          | 与模块的关系                                                                                                                                                       |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [聊天唤醒 W1–W4](../../../docs/CHAT-WAKEUPS.md)                          | Codex 预检、投递、失败和网页状态的功能说明。[开发记录](../../../docs/task/task-chat-wakeups.md)                                                                    |
| [统一发单与结果订阅](../../../docs/spec/unified-task-publishing/spec.md) | 相关 spec 定义唤醒目标和结果通知的归属。当前目录实现 Codex 投递，外接会话通过通用宿主事件流交付。[技术设计](../../../docs/spec/unified-task-publishing/tech-design.md) |
