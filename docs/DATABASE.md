# 明庭数据库与字段

## 有几个库、几张表

每个明庭服务实例使用 **1 个 SQLite 任务数据库**。本项目配置使用 `var/tasks.sqlite`，启动时可用 `TASK_DB` 指定路径。执行器自身的状态库和测试实例的临时库各有用途，这里统计明庭任务库。 [数据库路径](../src/server/main.ts#L15) · [创建存储实例](../src/server/transport/http.ts#L26)

| 核对对象                                   | 业务表 | SQLite 内部表 | 合计 |
| ------------------------------------------ | ------ | ------------- | ---- |
| 2026-11-07 只读检查现有 `var/tasks.sqlite` | 13     | 1             | 14   |
| 同日用当前源码初始化临时库                 | 15     | 1             | 16   |

两份库的差异是新增的 `task_turns`、`task_communications`，以及 `deliveries`、`dsh_publish_requests` 各新增的 `task_turn` 列。当前 `Store` 初始化时建表，并给缺少轮次列的旧表补列。下文以源码初始化后的结构为准。 [建表与补列](../src/server/storage/store.ts#L138)

读表时可以分两层看。**SQLite 列**是建表语句里写明的字段。很多表的 `data` 列存的是 JSON 文本，标题、状态等业务字段就在这段 JSON 里面。比如 `tasks` 只有 `id` 和 `data` 两列，标题要读 `data.title`。

## SQLite 表与列

### `tasks`

一行是一张工单。任务列表和领单判断都从这里读取任务。

| 列     | 类型和约束 | 用途                                 |
| ------ | ---------- | ------------------------------------ |
| `id`   | TEXT，主键 | 工单编号                             |
| `data` | TEXT，非空 | 工单正文和当前状态，见下方 JSON 字段 |

### `deliveries`

一行是一条「有单可领」通知。连接器按 `id` 补读通知，再拿任务编号和通知编号来申请领单。 [写入与重放](../src/server/storage/store.ts#L785)

| 列           | 类型和约束            | 用途                             |
| ------------ | --------------------- | -------------------------------- |
| `id`         | INTEGER，自增主键     | 通知编号，也是重连补读的游标     |
| `task_id`    | TEXT，引用 `tasks.id` | 通知对应的工单                   |
| `created_at` | TEXT，非空            | 通知生成时间                     |
| `task_turn`  | INTEGER，可空         | 通知对应的任务轮次，旧记录可为空 |

### `runs`

一行是一次执行。一次成功领单会创建一条运行记录，同一张工单后续可有多次运行。

| 列        | 类型和约束            | 用途                               |
| --------- | --------------------- | ---------------------------------- |
| `id`      | TEXT，主键            | 运行编号                           |
| `task_id` | TEXT，引用 `tasks.id` | 运行所属的工单                     |
| `data`    | TEXT，非空            | 执行器、输出和运行状态等 JSON 数据 |

### `leases`

一行是一次运行的领取凭证。明庭用它判断连接器能否为本次运行续期或回报。 [领单写入](../src/server/tasks/service.ts#L722) · [租约存取](../src/server/storage/store.ts#L824)

| 列         | 类型和约束                 | 用途                               |
| ---------- | -------------------------- | ---------------------------------- |
| `run_id`   | TEXT，主键，引用 `runs.id` | 凭证对应的运行                     |
| `owner_id` | TEXT，非空                 | 领到这张单的连接器编号             |
| `claim_id` | TEXT，非空                 | 这次领取的请求编号，重试沿用原编号 |
| `deadline` | INTEGER，非空              | 凭证到期时间，Unix 毫秒            |
| `seq`      | INTEGER，非空，默认 `0`    | 最后一次接受的执行器回报序号       |

### `task_turns`

一行是一张工单的一轮。首轮为 `1`，追加任务内容时创建下一轮。主键为 `(task_id, task_turn)`。 [保存轮次](../src/server/storage/store.ts#L220)

| 列          | 类型和约束                  | 用途                                       |
| ----------- | --------------------------- | ------------------------------------------ |
| `task_id`   | TEXT，非空，引用 `tasks.id` | 所属工单                                   |
| `task_turn` | INTEGER，非空               | 工单内的轮次编号                           |
| `data`      | TEXT，非空                  | 本轮描述、状态、来源和唤醒目标等 JSON 数据 |

### `task_communications`

一行是一条任务通信。序号在同一张工单内跨轮次递增。主键为 `(task_id, seq)`。 [保存通信](../src/server/storage/store.ts#L232)

| 列        | 类型和约束                  | 用途                                             |
| --------- | --------------------------- | ------------------------------------------------ |
| `task_id` | TEXT，非空，引用 `tasks.id` | 所属工单                                         |
| `seq`     | INTEGER，非空               | 工单内的通信序号                                 |
| `data`    | TEXT，非空                  | 轮次、收发双方、消息类型和脱敏后内容等 JSON 数据 |

### `events`

一行是执行器发来的一条 ACP 原始通知，例如文本增量或工具进度。每次运行保留最近一批通知。 [追加和清理通知](../src/server/storage/store.ts#L662)

| 列       | 类型和约束           | 用途                              |
| -------- | -------------------- | --------------------------------- |
| `id`     | INTEGER，自增主键    | 明庭分配的事件编号                |
| `run_id` | TEXT，引用 `runs.id` | 通知所属的运行                    |
| `data`   | TEXT，非空           | 收到的 ACP 通知与时间等 JSON 数据 |

### `run_audit`

一行是一条整理后的运行审计记录。主键为 `(run_id, seq)`。删除所属运行时，SQLite 会级联删除对应审计记录。 [追加审计](../src/server/storage/store.ts#L673)

| 列       | 类型和约束                           | 用途                                              |
| -------- | ------------------------------------ | ------------------------------------------------- |
| `run_id` | TEXT，非空，引用 `runs.id`，级联删除 | 所属运行                                          |
| `seq`    | INTEGER，非空                        | 产生这条审计记录的执行器回报序号                  |
| `kind`   | TEXT，非空                           | `tool` 表示工具变更，`context` 表示上下文用量观测 |
| `data`   | TEXT，非空                           | 具体审计内容的 JSON 数据                          |

### `approvals`

一行是执行过程中的一次审批请求和它的处理结果。

| 列       | 类型和约束           | 用途                             |
| -------- | -------------------- | -------------------------------- |
| `id`     | TEXT，主键           | 明庭审批编号                     |
| `run_id` | TEXT，引用 `runs.id` | 发出审批的运行                   |
| `data`   | TEXT，非空           | 审批内容、状态和决定等 JSON 数据 |

### `approval_subscribers`

每张启用订阅者审批的工单可保存一份审批订阅凭据摘要。

| 列           | 类型和约束                  | 用途                                      |
| ------------ | --------------------------- | ----------------------------------------- |
| `task_id`    | TEXT，主键，引用 `tasks.id` | 允许订阅审批的工单                        |
| `token_hash` | TEXT，非空                  | 订阅令牌的 SHA-256 摘要，用于校验审批请求 |

### `task_result_subscribers`

每张走通用发单流程的工单保存一份结果订阅凭据摘要。

| 列           | 类型和约束                  | 用途                                      |
| ------------ | --------------------------- | ----------------------------------------- |
| `task_id`    | TEXT，主键，引用 `tasks.id` | 允许订阅结果的工单                        |
| `token_hash` | TEXT，非空                  | 订阅令牌的 SHA-256 摘要，用于校验结果订阅 |

### `task_wakeup_targets`

保存旧任务的聊天唤醒绑定。读取时优先使用对应轮次的 `task_turns.data.wakeupTarget`，没有轮次记录时查这张表。 [读取绑定](../src/server/storage/store.ts#L456)

| 列        | 类型和约束                  | 用途                         |
| --------- | --------------------------- | ---------------------------- |
| `task_id` | TEXT，主键，引用 `tasks.id` | 绑定所属工单                 |
| `data`    | TEXT，非空                  | Codex 或 DSH 的唤醒目标 JSON |

### `task_wakeup_events`

一行是一条要送回指定聊天的事件。Codex 可接收待审批和任务完成事件，DSH 接收任务完成事件。 [创建唤醒事件](../src/server/storage/store.ts#L490)

| 列        | 类型和约束                  | 用途                                         |
| --------- | --------------------------- | -------------------------------------------- |
| `id`      | TEXT，主键                  | 唤醒事件编号，由事件类型与审批或运行编号组成 |
| `task_id` | TEXT，非空，引用 `tasks.id` | 事件所属工单                                 |
| `data`    | TEXT，非空                  | 唤醒目标、投递状态和回执等 JSON 数据         |

### `dsh_publish_requests`

一行记录一次 DSH 宿主发单或追加请求对应的工单和轮次。主键为 `(host_id, request_id)`，用来识别重复请求。 [查找与保存发单记录](../src/server/storage/store.ts#L401)

| 列            | 类型和约束                  | 用途                                                        |
| ------------- | --------------------------- | ----------------------------------------------------------- |
| `host_id`     | TEXT，非空                  | 发单宿主编号                                                |
| `request_id`  | TEXT，非空                  | 宿主发单请求编号，通用 MCP 宿主请求加 `mcp:` 前缀           |
| `fingerprint` | TEXT，非空                  | 请求内容等信息的 SHA-256 指纹，用于发现同编号请求的内容变更 |
| `task_id`     | TEXT，非空，引用 `tasks.id` | 请求对应的工单                                              |
| `task_turn`   | INTEGER，可空               | 请求对应的任务轮次，旧记录可为空                            |

### `runtime_metadata`

保存服务运行所需的少量键值。当前使用 `quarantine`，值为旧连接器领取隔离期的截止时间，单位为 Unix 毫秒。 [读写隔离时间](../src/server/storage/store.ts#L854)

| 列      | 类型和约束    | 用途             |
| ------- | ------------- | ---------------- |
| `key`   | TEXT，主键    | 运行信息的键名   |
| `value` | INTEGER，非空 | 该键对应的整数值 |

### `sqlite_sequence`

SQLite 的内部表，跟踪 `deliveries` 和 `events` 等使用 `AUTOINCREMENT` 的表的自增编号。

| 列     | 类型和约束         | 用途                            |
| ------ | ------------------ | ------------------------------- |
| `name` | 内部表未声明列类型 | 使用自增编号的表名              |
| `seq`  | 内部表未声明列类型 | SQLite 为该表记录的最大自增编号 |

## `data` 里的 JSON 字段

下列字段属于 JSON 对象。标为「可选」的键可以省略，标为「可空」的值可以是 JSON 的 `null`。ACP 原始消息按 SDK 自带的协议结构保存，明庭通过对应消息名校验。 [ACP 校验入口](../src/server/harness/acp/acp-validation.ts#L1)

### `tasks.data` 工单

| 字段                                    | 含义                                                                                                       |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `id`                                    | 工单编号，与 SQL 列 `id` 对应                                                                              |
| `title`、`description`、`publisherName` | 工单标题、发单时的描述、发起方显示名称                                                                     |
| `targetHarness`                         | 指定的执行器类型，可选                                                                                     |
| `requestedSettings`                     | 可选的执行设置，含可选的 `modelId`（模型）和 `reasoningEffort`（推理档位），至少提供一项                   |
| `approvalTargets`                       | 审批订阅目标列表，默认 `["subscriber"]`。类型还保留 `third_party`，当前发单逻辑拒绝启用它                  |
| `status`                                | 任务状态，取 `awaiting_dispatch`、`queued`、`running`、`awaiting_approval`、`succeeded`、`failed`、`cancelled` 或 `interrupted`。`awaiting_dispatch` 表示登记未派发：发布时未指定执行者、尚无投递事件，派发后转为 `queued` |
| `createdAt`、`updatedAt`                | 创建时间、最近更新时间                                                                                     |
| `currentRunId`                          | 当前关联的运行编号，可空                                                                                   |

任务对象的读取结构还允许 `taskTurn`。列表和详情从 `task_turns` 取最新轮次附到返回结果。 [工单结构](../src/shared/protocol.ts#L199) · [列表补上轮次](../src/server/storage/store.ts#L319)

### `runs.data` 单次运行

| 字段                       | 含义                                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`、`taskId`、`taskTurn` | 运行编号、工单编号、所属轮次，轮次可选                                                                                                                                                     |
| `status`                   | 本次运行的状态，使用同一套任务状态值                                                                                                                                                       |
| `sessionId`                | 执行会话编号，可空                                                                                                                                                                         |
| `createdAt`、`endedAt`     | 开始和结束时间，结束时间可空                                                                                                                                                               |
| `output`、`reasoning`      | 累积的文本输出和推理文本                                                                                                                                                                   |
| `tools`                    | 工具调用列表，每项有 `id`、`title`、`kind`、`status`、`input`、`output`，分别是工具调用编号、标题、类别、状态、输入和输出                                                                  |
| `error`、`stopReason`      | 错误说明、执行器结束原因，均可空                                                                                                                                                           |
| `discovery`                | 可空的 ACP 初始化响应 `InitializeResponse`，含 `protocolVersion`（协议版本），可带 `agentCapabilities`（能力）、`authMethods`（认证方式）、`agentInfo`（执行器信息）和 `_meta`（扩展信息） |
| `ownerId`、`harnessName`   | 领取连接器编号、实际执行器名称，均可空                                                                                                                                                     |
| `settingsReceipt`          | 可选的设置生效回执，见下表                                                                                                                                                                 |
| `usage`                    | 可选的本次执行用量，见下表                                                                                                                                                                 |

详情返回的 `context` 来自 `run_audit` 的最新上下文观测。 [运行结构](../src/shared/protocol.ts#L269) · [详情附上上下文](../src/server/storage/store.ts#L703)

| 嵌套字段                                                             | 含义                                                                                                                                                                                                                               |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settingsReceipt.status`、`modelId`、`reasoningEffort`               | 生效结果（`applied`、`default`、`rejected`）、回读的模型、回读的推理档位，后两项可空                                                                                                                                               |
| `settingsReceipt.confirmedAt`、`reason`                              | 确认时间、原因说明，原因可空                                                                                                                                                                                                       |
| `settingsReceipt.modelWindow`                                        | 可空的上下文窗口记录，含 `tokens`（窗口大小）、`provider`（供应商）、`modelId`（模型）、`basis`（数据口径）、`observedOn`（记录日期）、`sourceUrl`（来源链接）                                                                     |
| `usage.uncachedInputTokens`、`cachedReadTokens`、`cachedWriteTokens` | 未缓存输入、缓存读取、缓存写入 token 数，分别可空                                                                                                                                                                                  |
| `usage.outputTokens`、`reasoningTokens`、`totalTokens`               | 输出、推理、总 token 数，分别可空                                                                                                                                                                                                  |
| `usage.scope`、`basis`、`coverage`、`inconsistent`                   | 主回合范围（`primary_prompt`）、统计口径（`token_breakdown_v1`）、用量完整程度（`complete`、`partial`、`missing`）、数值是否矛盾                                                                                                   |
| `usage.cost`、`modelId`、`missingReason`                             | 可选费用（`currency` 为 `USD`，`amount` 是金额）、实际模型（可空）、可选的用量缺失原因                                                                                                                                             |
| `usage.source`                                                       | 用量来源，含 `wireFormat`（上报格式）、`adapterVersion`（适配器版本）、`protocolVersion`（协议版本）、`method`（协议方法或取数途径）、`fieldPath`（字段路径）、`sessionId`（会话编号）、可选的 `upstreamSessionId`（上游会话编号） |

[设置回执和用量结构](../src/shared/protocol.ts#L117)

### `task_turns.data` 任务轮次

- `taskId`、`taskTurn` 分别是工单编号和轮次编号。
- `description`、`status`、`createdAt` 分别是本轮任务描述、状态和创建时间。
- `source` 是可空的发起来源，含 `hostId`（宿主编号）、`publisherSessionId`（发单会话编号）、`originTurn`（发单回合编号）。
- `wakeupTarget` 是可空的本轮唤醒目标，字段见下方「唤醒目标」。 [轮次结构](../src/shared/protocol.ts#L208)

### `task_communications.data` 任务通信

- `taskId`、`taskTurn`、`seq` 分别是工单编号、所属轮次和任务内通信序号。
- `from`、`to` 分别是发送方和接收方，可取 `publisher`（发起方）、`mingting`（明庭）、`executor`（执行器侧）。
- `type`、`createdAt` 分别是消息类型和记录时间。
- `content` 是按消息类型变化的内容，存储前按字段规则脱敏。 [通信结构](../src/shared/protocol.ts#L223) · [脱敏与写入](../src/server/storage/store.ts#L232)

### `events.data` 执行器原始通知

- `runId`、`createdAt` 分别是所属运行编号和明庭记录时间。
- `notification` 是 ACP 的 `SessionNotification`，其中 `sessionId` 标识执行会话，`update` 按通知种类保存文本增量、工具更新等内容，`_meta` 可携带扩展信息。
- 详情返回的事件 `id` 取自 SQLite 的 `events.id` 列。 [写入原始通知](../src/server/storage/store.ts#L662) · [读取时附上编号](../src/server/storage/store.ts#L722)

### `run_audit.data` 运行审计

- `runId`、`seq`、`sessionId`、`createdAt` 分别是运行编号、回报序号、执行会话编号和记录时间。
- `kind` 为 `tool` 时，`toolCallId` 是工具调用编号，`patch` 是本次变更的工具字段（`title`、`kind`、`status`、`input`、`output` 按需出现），`truncated` 和 `redacted` 分别标记截断和脱敏。
- `kind` 为 `context` 时，`observation` 包含 `usedTokens`（已用 token）、`effectiveWindowTokens`（有效窗口，可空）、`source`（观测来源）。 [审计结构](../src/shared/protocol.ts#L249) · [上下文观测结构](../src/shared/protocol.ts#L161)

### `approvals.data` 审批

| 字段                                    | 含义                                                                                                                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`、`taskId`、`runId`、`sessionId`    | 明庭审批编号、工单编号、运行编号、执行会话编号                                                                                                                             |
| `requestId`、`request`                  | ACP 请求编号（字符串、数字或空值）和完整的 `RequestPermissionRequest`，含 `sessionId`（原会话）、`toolCall`（工具调用）、`options`（候选选项）与可选的 `_meta`（扩展信息） |
| `prompt`                                | 可选的审批提示，含 `title`（标题）与 `description`（说明）                                                                                                                 |
| `status`、`optionId`                    | 状态（`pending`、`decided`、`expired`）与最终选项编号（可空）                                                                                                              |
| `createdAt`、`resolvedAt`、`fallbackAt` | 发起时间、裁决时间（可选且可空）、候选意见可生效的时间（可空）                                                                                                             |
| `reviewerDecisions`                     | 订阅者等评审方的意见列表，每项含 `target`、`optionId`、`decidedAt`，分别是评审方类别、所选选项和提交时间                                                                   |
| `userDecision`                          | 用户决定，可空，含 `optionId`（选项编号）和 `decidedAt`（决定时间）                                                                                                        |
| `resolvedBy`                            | 最终采用谁的决定，可空，取 `user`、`subscriber` 或 `third_party`                                                                                                           |

[审批结构](../src/shared/protocol.ts#L290)

### 唤醒目标

`task_wakeup_targets.data`、`task_turns.data.wakeupTarget` 和 `task_wakeup_events.data.target` 使用两种目标结构。

| 目标  | 字段                                                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------- |
| Codex | `threadId` 是要唤醒的聊天编号，`originTurnId` 是原发起回合编号                                                                  |
| DSH   | `hostId` 是宿主编号，`sessionId` 是要唤醒的会话编号，`originTurn` 是原发起回合编号，`publisherSessionId` 是可选的原发单会话编号 |

[Codex 目标](../src/shared/task-wakeup.ts#L5) · [DSH 目标](../src/shared/dsh-wakeup.ts#L39)

### `task_wakeup_events.data` 唤醒事件

| 字段                              | 含义                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `id`、`type`                      | 唤醒事件编号和事件类型（`approval.requested` 或 `task.completed`）                                     |
| `taskId`、`runId`、`approvalId`   | 工单编号、运行编号、审批编号（可空）                                                                   |
| `target`、`createdAt`             | 目标聊天的绑定信息、事件创建时间                                                                       |
| `status`、`attempts`              | 投递状态和尝试次数。状态取 `pending`、`sending`、`delivered`、`failed`、`acknowledged` 或 `superseded` |
| `deliveredAt`、`receipt`、`error` | 投递成功时间、宿主返回的回执、投递失败说明，均可空                                                     |
| `resumedTurnId`、`acknowledgedAt` | 接收事件后开启的新聊天回合编号、确认时间，均可空                                                       |

回执格式随宿主而变。Codex 回执有 `source` 和 `result`，后者保存 `sessionId`、`accepted` 和可选的 `agentInfo`。DSH Web 的成功回执直接保存 `source`、`sessionId` 和 `accepted`。 [唤醒事件结构](../src/shared/task-wakeup.ts#L12) · [Codex 回执](../src/server/wakeup/codex-wakeup.ts#L82) · [DSH Web 回执](../src/server/tasks/service.ts#L234)

## 按领单流程看这四张表

发单时，明庭在同一个事务里写 `tasks` 和 `deliveries`。连接器收到通知后申请领单，明庭在另一个写事务里更新 `tasks`，新建 `runs`，并在 `leases` 里登记谁领到和何时到期。 [发单事务](../src/server/tasks/service.ts#L392) · [领单事务](../src/server/tasks/service.ts#L669)
