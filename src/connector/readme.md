# 明庭任务连接器

> 草稿，待用户检查。

## 功能描述

任务连接器让本机的 Codex、Grok、ZCode 或 DeepSeek 接手明庭任务。它登记在线身份，接收并领取任务，把标题和本轮指令交给执行器，再把进度、审批请求和结果送回明庭。[执行器配置与接入](../server/harness/readme.md) · [订阅与执行功能](../../docs/HARNESS-SUBSCRIPTIONS.md)

## 设计理念

- **把通知和领取分开。** SSE 是一条保持打开的 HTTP 连接，明庭通过它推送任务通知，断线后可按最后收到的事件 ID 补收。通知可以重放，平台在领取时再次核对执行器身份、任务轮次和执行槽位。连接器逐条领取，平台一次只允许一个运行占用执行槽位。[订阅和定向领取设计](../../docs/spec/harness-subscriptions/tasks/task-harness-subscriptions.md) · [轮次领取设计](../../docs/spec/task-turns-and-seq/tech-design.md#turns)
- **用租约和顺序回报保护一次执行。** 租约是平台给当前执行者的一段有效期，连接器靠心跳延长它。过程回报带运行 ID、领取凭据和该次运行内递增的 `seq`，平台据此核对归属和顺序。连接器中途退出时，平台会在租约失效后收尾。串行回报让适配器可以等模型设置回执提交后再发任务，代价是回报迟滞或积压会阻断执行。[设置提交顺序](../../docs/spec/codex-task-settings-and-audit/tech-design.md#settings) · [同次运行归属](../../docs/spec/codex-task-settings-and-audit/tech-design.md#audit)

## 使用方式

在仓库根目录使用 Node 24+ 并安装项目依赖。`npm start` 默认按 `TASK_HARNESSES` 拉起连接器，未配置时启动 Codex。设置 `TASK_CONNECTOR=manual` 后可分开启动平台和连接器。独立连接器使用 `TASK_HARNESS` 选择身份，使用 `TASK_PLATFORM_URL` 连接本机 HTTP 根地址，默认 `http://127.0.0.1:60390`。两边须使用相同的工作目录和运行模式。真实模式的工作目录须预先存在，执行器的登录与配置见部署指南。[服务启动入口](../server/main.ts#L28) · [部署指南](../../docs/HARNESS-SUBSCRIPTIONS.md#h4-部署)

用模拟执行器验证一次离线发单和补收。以下命令使用临时数据库和工作目录，示例端口为 `60490`。如需更换端口，三步都使用同一个空闲端口。

1. 在终端一启动平台，记下打印出的临时目录。

   ```bash
   demo_dir="$(mktemp -d)"
   printf '%s\n' "$demo_dir"
   PORT=60490 TASK_DB="$demo_dir/tasks.sqlite" TASK_WORKSPACE="$demo_dir/workspace" \
     FAKE_ACP=1 TASK_AUTH=existing TASK_HARNESS=Codex TASK_CONNECTOR=manual \
     MINGTING_CODEX_WAKEUPS=0 MINGTING_WAKEUP_HOSTS_FILE= npm start
   ```

2. 在终端二通过普通 MCP 发一条测试任务。回执返回 `taskId` 和任务链接，此时任务保持排队。`[settings-check]` 让模拟执行器直接回报实际采用的模型和档位。

   ```bash
   TASK_MCP_URL=http://127.0.0.1:60490/mcp npm run publish -- \
     "连接器演示" "[settings-check] 回报模拟执行设置" "本机演示" Codex
   ```

3. 在终端二用第一步打印的目录启动连接器。连接器日志会打印 `收到任务订阅事件`。任务详情显示成功和模拟输出 `executed:A/medium`。已构建网页时，可通过发单回执的链接查看详情。[演示执行器](../../tests/fake-acp.ts) · [网页构建和访问](../../README.md#快速试用无模型的完整传输闭环)

   ```bash
   demo_dir="/替换为第一步打印的临时目录"
   FAKE_ACP=1 TASK_AUTH=existing TASK_HARNESS=Codex TASK_WORKSPACE="$demo_dir/workspace" \
     TASK_PLATFORM_URL=http://127.0.0.1:60490 npm run connector
   ```

这组命令已在临时环境中验证。先通过普通 MCP 发单并看到 `queued`，再启动连接器补收，详情接口返回 `succeeded` 和预期输出。

任务持续排队时，用 MCP `list_harnesses` 确认目标身份在线并核对连接端口。领取后报工作目录或模式不一致时，先统一两边的配置再重试。运行因租约到期中断时，可在任务详情发起重试。[MCP 发布与在线身份查询](../../README.md#mcp-发布与在线身份查询)

## 代码说明

本节覆盖目录内的三个脚本。启动入口选好执行器后交给 `TaskConnector`。`TaskConnector` 调度任务，并通过传输层收发消息。模型交互走 ACP，也就是连接器与执行器交换指令、进度和审批的协议。

### main.ts

启动脚本把 `runtime()` 返回的执行器和身份交给 `TaskConnector`，开始订阅并打印事件及实例标识。平台拉起子进程与手动启动共用此入口和配置规则，运行配置以仓库根目录为起点查找默认工作目录和测试脚本。收到 `SIGTERM` 或 `SIGINT` 时，`stop()` 合并退出信号，等待 `close()` 收尾后退出。[源码](main.ts) · [关闭入口](main.ts#L18) · [运行配置](../server/harness/runtime.ts#L13)

### connector.ts

`TaskConnector` 管理一条订阅和一个串行领取循环。重连保留进程内游标与待领队列，新进程从游标 `0` 开始补收。每次连接生成新代次，领取和模型选项上报关联当前连接。已领取的运行通过独立心跳维持租约，因此订阅断开时仍可继续回报。[源码](connector.ts)

| 函数                                                 | 处理过程和结果                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `constructor()`、`start()`、`reconnect()`、`close()` | 构造时接收本机平台地址、执行器和身份，可传入事件回调及任务筛选器。`start()` 启动一次监听循环。`reconnect()` 断开订阅，循环按原游标恢复。`close()` 中止订阅、运行和探测，等它们退出。[构造和启动](connector.ts#L38) · [重连](connector.ts#L53) · [关闭](connector.ts#L306)                |
| `listen()`                                           | 按事件 ID 更新游标，通知观察回调，将通过筛选的任务事件排队。每条待领事件有自己的 `claimId`，重试沿用它。[源码](connector.ts#L57)                                                                                                                                                         |
| `maybeProbe()`、`kick()`                             | 连接空闲且执行器支持时，探测可用模型和思考档位，随当前连接代次上报。任务到来时发出取消探测的信号并启动领取循环。[探测](connector.ts#L101) · [调度](connector.ts#L138)                                                                                                                    |
| `pump()`                                             | 取队首的 `taskId` 和 `deliveryId` 申请领取。成功后执行该次运行。平台返回 `404` 或 `410` 时丢弃该事件，其他失败保留队首并延时再试。[源码](connector.ts#L154)                                                                                                                              |
| `execute()` | 先发心跳并核对工作目录和模式，再把标题与本轮描述交给适配器。等过程回报提交后判断结果，收尾时清理计时器并尝试提交终态和用量。[源码](connector.ts#L196) |
| `createRunReports()` | 为每次运行建立回报队列，按序提交会话、设置回执和进度。设置回执遇到传输异常时可沿用原序号补发一次。即使过程回报失败，队列也会尝试用下一个序号提交终态。[源码](connector.ts#L326) |
| `createPermissionHandler()` | 执行器请求审批时先等已排队的回报，再登记审批并轮询裁决，把原始响应交给执行器。[源码](connector.ts#L381) |
| `createRunHeartbeat()` | 执行器运行和等待审批时独立续租。同一时间只发一个心跳。平台请求取消或心跳失败时中止执行。[源码](connector.ts#L418) |

2026-11-07 · 内部整理 · 将单次运行的心跳、回报队列和审批处理移出 `execute()`，保留回报、审批和取消的既有顺序。[任务记录，已验证](../../docs/task/task-connector-execution-refactor.md)

`deliveryId` 是领取事件的编号，帮助平台找到对应的任务轮次。`report.seq` 从每次运行的第一条回报开始计数。任务详情的通信序号由服务端按整张任务的实际收发另行累计，跨任务轮次连续递增。[轮次与通信序号设计](../../docs/spec/task-turns-and-seq/tech-design.md#sequence)

### transport.ts

这个文件把地址校验、JSON 请求和 SSE 解析集中起来。SSE 长连接负责及时收事件，领取与回报使用有超时的独立 HTTP 请求。上层可按状态码区分过期事件和其他失败。[源码](transport.ts) · [连接器接口](../server/transport/http.ts#L498)

| 函数                  | 处理过程和结果                                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `localBase()`         | 输入平台地址，只接受 `127.0.0.1` 或 `localhost` 的 HTTP 根地址，可指定端口。校验成功返回 `origin`，其余地址抛错。[源码](transport.ts#L8)                                                                            |
| `post()`、`HttpError` | 向已校验的平台地址提交 JSON，合并请求超时与可选的取消信号。返回解析后的 JSON，非成功状态的 JSON 响应会转成带状态码的 `HttpError`，具体响应结构由调用方校验。[请求](transport.ts#L32) · [错误类型](transport.ts#L22) |
| `subscribe()`         | 传入上次收到的事件 ID、取消信号和可选身份。连接就绪后逐块读取，等完整事件帧到齐才解析，跳过保活帧，并核对帧头与正文的事件 ID 一致后交出事件。退出时释放读取器。[源码](transport.ts#L51)                             |

## spec 索引

### 已核对的 spec

| Spec                                                                                                                                                                                                                                                                                                                                              | 与连接器的关系及依据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 同一任务的多轮沟通与通信计数 [feat01](../../docs/spec/task-turns-and-seq/spec.md#feat01-同一任务中分轮追加内容并接收结果) · [feat02](../../docs/spec/task-turns-and-seq/spec.md#feat02-查看逐条通信计数与每轮来源)                                                                                                                                | 连接器按领取事件分开处理同一任务的各轮，平台在领取回执中提供本轮内容，并为可归属的执行通信记账。[领取设计](../../docs/spec/task-turns-and-seq/tech-design.md#turns) · [计数设计](../../docs/spec/task-turns-and-seq/tech-design.md#sequence)                                                                                                                                                                                                                                                                         |
| Codex 任务设置、过程审计与用量对账 [feat01](../../docs/spec/codex-task-settings-and-audit/spec.md#feat01-设置-codex-任务的模型和思考档位) · [feat02](../../docs/spec/codex-task-settings-and-audit/spec.md#feat02-查看运行过程和工具审批审计) · [feat03](../../docs/spec/codex-task-settings-and-audit/spec.md#feat03-查看并对账任务消耗与上下文) | 连接器承担空闲探测、设置回执提交、进度与审批回传、上下文和终态用量回报。该 spec 定义 Codex 首期，后续接入记录说明 Grok、ZCode、DeepSeek 沿用这条回传链路。[设置任务](../../docs/spec/codex-task-settings-and-audit/tasks/task-codex-settings/dev-checklist.md) · [审计设计](../../docs/spec/codex-task-settings-and-audit/tech-design.md#audit) · [计量任务](../../docs/spec/codex-task-settings-and-audit/tasks/task-run-metering/dev-checklist.md) · [多执行器接入记录](../../docs/spec/harness-subscriptions/tasks/task-multi-harness-acp.md) |

### 功能定义与历史来源

| 功能文档                                                          | 与连接器的关系及依据                                                                                                                                                                          |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Harness 订阅 H1–H4](../../docs/HARNESS-SUBSCRIPTIONS.md#h1-身份) | 定义在线身份、定向领取、执行与本机部署。首次实现沿用当时的传输闭环说明，历史任务记录注明当时的 spec 来源。[首次实现记录](../../docs/spec/harness-subscriptions/tasks/task-harness-subscriptions.md)                       |
| [审批 A1–A3](../../docs/APPROVALS.md#a1-任务发起方与审批对象)     | 定义审批对象、原始选项和用户优先规则。平台裁决并留存决定，连接器负责把请求送到平台和把结果交回执行器。[审批实现记录](../../docs/spec/approvals/tasks/task-approvals.md) · [连接器审批回调](connector.ts#L381) |
