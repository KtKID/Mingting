# 网页任务接口

> 草稿，待用户检查。

## 功能描述

这个目录给本机明庭任务台提供任务列表、详情、发布、取消、重试和审批接口。网页也在一条持续连接上接收当前状态，用来刷新任务进度、在线执行器和待审批弹窗。

## 设计理念

网页表单调用 `POST /mcp` 的 `mcp-mingting-tool` 发单。网页用本机会话访问，提交任务或审批时带 CSRF 令牌，用来核对操作来自这个任务台。 [统一发布](../../../../docs/spec/unified-task-publishing/spec.md#feat01-用统一规则发布任务并取得回执) · [本机安全边界](../../../../README.md#安全限制与验证)

实时更新采用 SSE，也就是服务器在同一条 HTTP 连接上持续推送消息。每次推送的是一份完整的当前状态，网页断线后拿到新快照即可替换原来的显示。完整快照会重复携带列表等内容，服务端把短时间内的多次变更合并成一次推送，慢连接等恢复可写后再补发。 [实时执行设计](../../../../docs/spec/harness-subscriptions/tasks/task-acp-streaming.md) · [网页重连记录](../../../../docs/spec/harness-subscriptions/tasks/task-web-reconnect.md)

## 使用方式

1. 按服务端说明启动演示，打开终端打印的本机地址。网页会先请求 `GET /api/bootstrap`，获得会话 Cookie 和写操作用的 `csrf`。 [服务端启动](../../readme.md#使用方式)
2. 在任务台发布一条测试任务并打开详情。网页监听 `GET /api/events` 的 `snapshot` 消息；打开任务时加上 `taskId`，就能随列表一起收到该任务的执行过程、待审批项和唤醒摘要。连接断开时，网页重新请求 `bootstrap` 后再连接。 [网页接入代码](../../../web/main.tsx#L271)
3. 网页发起写操作时带上同源 `Origin` 和 `x-csrf-token`。会话过期或地址换成另一个 Host 时，重新建立会话。请求超出本机服务限制时会收到 `429`。 [网页请求代码](../../../web/main.tsx#L251) · [会话校验](session.ts#L54)

服务端已在 `createPlatform()` 里用 `app.use(browserApiRouter(service, workspace, mode))` 挂载完整路由。网页会话、执行中快照、重连和审计查询可通过现有集成用例核对。 [挂载位置](../http.ts#L50) · [网页实时测试](../../../../tests/streaming.test.ts#L209) · [审计查询测试](../../../../tests/platform.test.ts#L318)

## 代码说明

本节覆盖目录中的三个脚本。`router.ts` 注册网页接口，`session.ts` 提供同一份会话检查，`events.ts` 把任务服务的变更转成网页快照。

### [router.ts](router.ts)

`browserApiRouter(service, workspace, mode)` 返回一组完整的 `/api` 路由。它先开放会话初始化，再为其余接口检查会话。路由负责校验网页输入、读取查询结果和记录任务通信，任务状态的变化由 `TaskService` 处理。 [路由入口](router.ts#L15) · [任务处理](../../tasks/readme.md)

| 路由处理器                             | 输入和结果                                                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/tasks`、`GET /api/harnesses` | 返回任务列表和在线执行器及其能力。 [源码](router.ts#L29)                                                                                                                                                |
| 网页来源的 `POST /mcp`                 | 校验已有网页会话和 CSRF，通过后交给 MCP 路由。 [源码](router.ts#L19) |
| `GET /api/tasks/:id`                   | 读取任务详情。可用 `seqAfter` 从指定序号之后查看通信流水，默认从 `0` 开始。任务不存在时返回 `404`。 [源码](router.ts#L39)                                                                               |
| `GET /api/tasks/:id/runs/:runId/audit` | 校验这次运行属于指定任务，按 `cursor` 和 `limit` 读取工具审计及同一执行会话的审批。`nextCursor` 用于继续翻页，游标只能用于原来的运行。 [源码](router.ts#L51)                                            |
| 取消、重试和审批的 `POST` 处理器       | 接收任务编号或审批编号。审批还要提供运行、执行会话和原始选项编号。调用任务服务处理后返回结果，并按所属任务轮次记录请求与回应。 [取消](router.ts#L92) · [重试](router.ts#L110) · [审批](router.ts#L124) |

### [session.ts](session.ts)

`browserSession(workspace, mode)` 为每个服务实例创建一份内存会话表，返回初始化、请求校验和有效期检查。会话与请求的 Host 绑定，有效期为 12 小时，服务重启后网页会重新建立会话。 [源码](session.ts#L6) · [时限](../../../shared/protocol.ts#L35)

- `readSession(req)` 从 `task_session` Cookie 查找会话。`bootstrap(req, res)` 先清理过期条目，再复用同 Host 的会话或新建一个，返回 `csrf`、运行模式和工作目录。 [查找](session.ts#L12) · [初始化](session.ts#L23)
- `requireSession(req, res, next)` 检查 Cookie、有效期和 Host，非 `GET` 请求还检查同源 `Origin` 与 `x-csrf-token`。校验失败返回 `403`。`isActive(req)` 供已建立的事件流复查会话有效期。 [请求校验](session.ts#L54) · [有效期检查](session.ts#L68)

### [events.ts](events.ts)

`browserEvents(service, sessionIsActive)` 创建 `GET /api/events` 的处理器。接收可选的任务 UUID，先监听变更，再读取当前状态，避免在建立连接时漏掉更新。每个服务实例最多同时开启 8 条网页流。 [处理器](events.ts#L7) · [连接限制](../../../shared/protocol.ts#L49)

- `send()` 读取任务列表、在线执行器、选中任务详情、待审批和服务端时间，写出一帧 `snapshot`。`schedule()` 把 40 毫秒内收到的变更合并成一次推送。 [快照](events.ts#L41) · [合并更新](events.ts#L58)
- `write(text)` 在客户端来不及接收时暂停推送。连接恢复可写后补发最新快照，持续阻塞到超时就关闭。定时保活也会复查会话有效期，连接关闭时释放名额、定时器和监听器。 [暂停写入](events.ts#L34) · [恢复与清理](events.ts#L63)

## spec 索引

| 功能定义                                                                                                                                  | 与模块的关系及依据                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [统一发单 feat01](../../../../docs/spec/unified-task-publishing/spec.md#feat01-用统一规则发布任务并取得回执)                              | 网页沿用统一发布和回执，在任务台完成审批和查看结果。 [发布设计](../../../../docs/spec/unified-task-publishing/tech-design.md#publish)                                                                                      |
| [结果订阅与唤醒 feat02](../../../../docs/spec/unified-task-publishing/spec.md#feat02-订阅任务结果)                                        | 网页快照提供已有的唤醒会话、发单轮次和投递状态，供任务详情显示。 [实现记录](../../../../docs/spec/unified-task-publishing/tasks/task-kmh-wakeup-display.md)                                                                |
| [Codex 审批审计 feat02](../../../../docs/spec/codex-task-settings-and-audit/spec.md#feat02-查看运行过程和工具审批审计)                    | 实时快照提供当前过程，审计路由按单次运行分页查询历史工具与审批。 [审计开发清单](../../../../docs/spec/codex-task-settings-and-audit/tasks/task-run-tool-approval-audit/dev-checklist.md)                                   |
| [同单多轮与通信计数 feat02](../../../../docs/spec/task-turns-and-seq/spec.md#feat02-查看逐条通信计数与每轮来源)                           | 任务详情按 `seqAfter` 翻阅通信记录，网页操作参与任务收发记账。 [详情协议](../../../../docs/spec/task-turns-and-seq/tech-design.md#contract) · [计数规则](../../../../docs/spec/task-turns-and-seq/tech-design.md#sequence) |
| [实时执行过程 H5](../../../../docs/HARNESS-SUBSCRIPTIONS.md#h5-实时执行过程) · [审批 A2](../../../../docs/APPROVALS.md#a2-弹窗标题与描述) | 原始功能说明。网页会话保护实时快照，待审快照驱动网页弹窗。 [实时执行任务](../../../../docs/spec/harness-subscriptions/tasks/task-acp-streaming.md) · [审批任务](../../../../docs/spec/approvals/tasks/task-approvals.md)                                               |
