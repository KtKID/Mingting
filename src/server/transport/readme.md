# 服务端接口

> 草稿，待用户检查。

## 功能描述

这个目录接收网页、MCP、连接器、结果订阅者和 DSH 宿主的请求。接口检查来访者身份和输入，再调用任务服务或返回查询结果。

## 设计理念

网页和其他发布方共用 MCP 发单入口。网页、连接器和宿主各有自己的身份校验，宿主通过通用事件流接收完成通知，再回报投递结果。事件流让连接方在同一条连接上持续收消息。 [统一发布](../../../docs/spec/unified-task-publishing/spec.md#feat01-用统一规则发布任务并取得回执) · [通用唤醒契约](../../../docs/CHAT-WAKEUPS.md#通用宿主唤醒)

## 使用方式

启动 [服务端](../readme.md#使用方式) 后，网页从 `GET /api/bootstrap` 建立浏览器会话。MCP 客户端连接 `POST /mcp` 并调用 `mcp-mingting-tool`，成功时取得任务链接和订阅凭据。接入示例见 [MCP 发布指南](../../../README.md#mcp-发布与在线身份查询)。各唤醒宿主准备各自的 ID 和令牌，见 [通用唤醒操作入口](../../../docs/CHAT-WAKEUPS.md#通用宿主唤醒)。

## 代码说明

- [http.ts](http.ts) 的 [createPlatform(config)](http.ts#L26) 创建数据库、任务服务和 Express 应用，挂载各路由和全局中间件，返回 `app`、`service`、`store` 供启动入口和测试使用。
- [mcp.ts](mcp.ts) 提供普通 MCP 入口，处理新建和追加任务、在线执行器查询、审批及唤醒工具。发单规则由 `TaskService` 维护，审批决定与订阅 HTTP 入口共用 [decision.ts](subscriber/decision.ts)。
- [browser-api](browser-api/) 提供网页任务 API。[router.ts](browser-api/router.ts) 注册任务和审批接口，[session.ts](browser-api/session.ts) 管理会话和 CSRF，[events.ts](browser-api/events.ts) 合并变更并推送网页快照。
- [subscriber](subscriber/) 提供发起方的 HTTP 接口。[router.ts](subscriber/router.ts) 校验任务订阅令牌，推送审批或结果状态，补发已完成事件，并接收订阅者的审批决定。
- [connector.ts](connector.ts) 提供执行器接口，按游标重放待领取任务，并处理认领、租约心跳、进度与结果回报和工具审批。
- [http-middleware.ts](http-middleware.ts) 处理全局请求防护与错误响应。[web-assets.ts](web-assets.ts) 提供网页和审批回归报告资源。
- [host-wakeup.ts](host-wakeup.ts) 读取宿主配置与密钥，为 MCP 发布提供宿主认证，并挂载完成事件流和确认接口。宿主重连可补收待确认事件。任务服务核对确认的事件和会话归属。

## spec 索引

| Spec                                                                                                         | 与模块的关系                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [统一发单与结果订阅](../../../docs/spec/unified-task-publishing/spec.md) | 发单统一走 MCP，订阅接口支持补收。[旧入口退役记录](../../../docs/spec/unified-task-publishing/tasks/task-retire-legacy-publishing.md) |
| [DSH 原会话唤醒](../../../docs/spec/dsh-task-wakeups/spec.md)                                                | 规定宿主记录发起会话、完成后回原会话及去重。[鉴权和宿主事件设计](../../../docs/spec/dsh-task-wakeups/tech-design.md)                                                  |
| [Codex 审批审计](../../../docs/spec/codex-task-settings-and-audit/spec.md#feat02-查看运行过程和工具审批审计) | 网页按任务和运行查询审计，接口会核对归属。[审计任务记录](../../../docs/spec/codex-task-settings-and-audit/tasks/task-run-tool-approval-audit/dev-checklist.md)        |
