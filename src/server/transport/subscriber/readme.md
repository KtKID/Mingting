# 发起方审批与结果订阅

> 草稿，待用户检查。

## 功能描述

发起方通过普通 MCP 发单后，可以凭回执中的任务专属令牌，接收这张任务单的审批或执行结果。启用了订阅者审批的任务还允许发起方提交意见，网页用户仍可作最终决定。 [发单与接入](../../../../README.md#mcp-发布与在线身份查询) · [审批规则](../../../../docs/APPROVALS.md#a3-用户优先与十秒窗口)

## 设计理念

结果订阅和审批权限分开。只交给网页用户审批的任务也能订阅执行结果。审批意见通过 HTTP 或 MCP 提交时，使用同一个处理入口，沿用同一套身份、选项和用户优先规则。 [发布与订阅权限](../../../../docs/spec/unified-task-publishing/tech-design.md#publish) · [审批任务记录](../../../../docs/task/task-approvals.md)

结果从已保存的运行记录读取。每次运行有固定的完成事件编号，所以任务先结束、发起方后连接时也能取回结果。每条连接会跳过本连接内已发送的完成事件。重连会重新读取已结束的运行，发起方用 `eventId` 跳过已经处理过的结果。 [结果补收设计](../../../../docs/spec/unified-task-publishing/tech-design.md#results)

## 使用方式

本机客户端用 `mcp-mingting-tool` 发单，保存回执中的 `resultSubscription`。把里面的 `taskId` 和 `subscriptionToken` 分别填入 `TASK_ID` 和 `SUBSCRIPTION_TOKEN`。以下示例使用默认本机端口，演示端口按实际地址替换。

```bash
curl -N -H "Authorization: Bearer $SUBSCRIPTION_TOKEN" \
  "http://127.0.0.1:60390/subscriber/events?taskId=$TASK_ID&view=result"
```

连接后先收到 `task.status`，包含任务编号和当前状态。每次已结束的运行各发一条 `task.completed`，包含运行编号、结束状态、已保存的输出或错误。未领取就取消的任务通过状态帧报告。SSE 是服务器在同一条 HTTP 连接上持续推送消息，示例会持续等待新事件。 [订阅入口](router.ts#L26) · [结果字段](../../tasks/publisher-subscriptions.ts#L34)

接收审批时，用回执中的 `approvalSubscription` 建立连接，查询参数改用 `view=approval`，也可省略 `view`。收到的 `approval.snapshot` 包含当前运行仍待处理的审批。使用 `POST /subscriber/decision` 时，在 JSON 请求体里带上 `taskId`、`subscriptionToken`、`approvalId`、`runId`、`sessionId` 和原始 `optionId`。也可以把同一组字段交给 MCP 工具 `submit_approval_decision`。 [审批接口](../../../../docs/APPROVALS.md#a1-任务发起方与审批对象) · [字段定义](../../../shared/protocol.ts#L394)

HTTP 订阅供可信本机客户端使用，带浏览器来源标记的请求会收到 `403`。服务实例的审批和结果流合计最多 8 条，超限返回 `429`。审批和结果订阅的实际接口分别由现有集成用例覆盖。 [入口限制](router.ts#L16) · [审批集成测试](../../../../tests/approvals.test.ts#L382) · [结果补收测试](../../../../tests/dsh-wakeup.test.ts#L472)

## 代码说明

本节覆盖目录中的两个脚本。`router.ts` 提供 HTTP 接口，`decision.ts` 提供 HTTP 与 MCP 共用的审批处理。

### [router.ts](router.ts)

这里的路由是明庭按 HTTP 方法和网址分派请求的规则。`createPlatform()` 把 `subscriberRouter(service)` 接到明庭服务上。请求先过服务的本机访问检查，再由订阅路由拦截带浏览器来源标记的请求，最后进入下面的处理流程。 [本机访问检查](../http-middleware.ts#L7) · [路由入口](router.ts#L13) · [挂载](../http.ts#L51)

| 发起方要做什么     | 发送什么请求                                    | `router.ts` 怎么处理                                                                                                                              |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 等一张任务单的结果 | `GET /subscriber/events?taskId=…&view=result`   | 用回执令牌确认这张单可订阅。打开长连接，先发任务状态，再发已有的完成结果。任务继续变化时沿这条连接推送。 [订阅入口](router.ts#L26)                |
| 等一张任务单的审批 | `GET /subscriber/events?taskId=…&view=approval` | 用审批凭据核对权限，在同一地址上切换为审批视图，发送这张单当前待处理的审批。省略 `view` 时也进入这个视图。 [视图选择](router.ts#L28)              |
| 对一项审批提交意见 | `POST /subscriber/decision`                     | 检查提交字段，交给 `decision.ts` 的 `subscriberDecision()` 核验权限和处理意见。受理后回 `{ ok: true }`，请求到此结束。 [提交入口](router.ts#L142) |

- `sendSnapshot()` 只在状态内容变化时发快照。结果视图还从 `TaskService.resultEvents()` 读出本连接未发过的完成事件。实际发出的任务消息按任务或运行归属记入通信流水。 [源码](router.ts#L76) · [计数规则](../../../../docs/spec/task-turns-and-seq/tech-design.md#sequence)
- `write(frame)` 在连接暂时写不动时暂停，`drain()` 在恢复可写时继续读取和发送。`send()` 遇到读写失败会通过 `stop()` 结束连接，连接关闭时清理心跳、监听器和连接名额。 [暂停写入](router.ts#L72) · [恢复与清理](router.ts#L112)

### [decision.ts](decision.ts)

`subscriberDecision(service, input)` 接收已通过格式校验的凭据和意见，先确认发起方有审批权限，再找出审批所属运行和任务轮次。它记录可归属的请求与回应，把保存意见交给 `TaskService.decideSubscriber()`。两个入口共用这个函数，所以审批规则和通信记录走同一条路径。 [源码](decision.ts#L7) · [MCP 调用](../mcp.ts#L201) · [通信记录](../task-communication.ts#L23)

返回 `{ ok: true }` 表示发起方意见已受理。首次有效意见开启 10 秒的网页用户优先窗口。窗口内提交同一意见会沿用原截止时间，改选项或审批已经结束时会拒绝。最终结果由任务服务按用户决定或超时规则裁决。 [任务服务](../../tasks/approvals.ts#L149) · [裁决规则](../../../../docs/APPROVALS.md#a3-用户优先与十秒窗口)

## spec 索引

| 功能定义                                                                                                                          | 与模块的关系及依据                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [统一发单 feat01](../../../../docs/spec/unified-task-publishing/spec.md#feat01-用统一规则发布任务并取得回执)                      | 上游依赖。发单回执提供任务专属订阅凭据，本模块按订阅用途校验。 [发布设计](../../../../docs/spec/unified-task-publishing/tech-design.md#publish)                                                                                             |
| [结果订阅 feat02](../../../../docs/spec/unified-task-publishing/spec.md#feat02-订阅任务结果)                                      | `view=result` 推送当前状态和实际运行结果，支持晚订阅和重连补收。 [结果设计](../../../../docs/spec/unified-task-publishing/tech-design.md#results) · [交付记录](../../../../docs/spec/unified-task-publishing/tasks/task-kmh-mcp-publish.md) |
| [同单多轮与通信计数 feat02](../../../../docs/spec/task-turns-and-seq/spec.md#feat02-查看逐条通信计数与每轮来源)                   | 订阅请求、发出的任务状态和结果、可归属的审批请求及回应纳入同一任务的通信流水。 [计数规则](../../../../docs/spec/task-turns-and-seq/tech-design.md#sequence) · [多轮接口测试](../../../../tests/task-turns.test.ts#L53)                      |
| [审批 A1](../../../../docs/APPROVALS.md#a1-任务发起方与审批对象) · [审批 A3](../../../../docs/APPROVALS.md#a3-用户优先与十秒窗口) | 原始功能说明。发起方凭任务令牌接收审批快照和提交意见，任务服务执行用户优先规则。 [设计与实现记录](../../../../docs/task/task-approvals.md)                                                                                                  |

## 待实现

新增任务的凭据由新表统一核验已列入待办。当前代码分别查结果和审批凭据表，启用订阅者审批的新任务会把同一令牌的哈希写入两张表。 [待办](../../../../TODO.md#订阅凭据) · [设计原文](../../../../docs/spec/unified-task-publishing/tech-design.md#publish) · [凭据写入](../../tasks/publication.ts#L266) · [结果校验](../../tasks/publisher-subscriptions.ts#L21) · [审批校验](../../tasks/publisher-subscriptions.ts#L48)
