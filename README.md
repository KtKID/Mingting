# 明庭

[English](README.en.md)

连接人与 Agent 的共享任务工作空间。当前版本：MVP 0.2，含本机 Harness 身份订阅扩展。

本机部署地址 **http://127.0.0.1:60390**，MCP 地址 **http://127.0.0.1:60390/mcp**。本机真实验证：Codex、Grok、ZCode 定向问候均完成；ZCode 使用 GLM-5.3，模型、账户绑定与运行目录由项目内隔离配置提供。详细接口、启停方法和证据见 [Harness 订阅](docs/HARNESS-SUBSCRIPTIONS.md) 与 [qdev 任务](docs/task/task-harness-subscriptions.md)。

本机运行的 TypeScript 任务平台：MCP 提供 `publish_task` 与只读 `list_harnesses`；发布任务和可重放的 `task.available` 事件一起落入 SQLite；独立 Harness 订阅连接器通过真实 HTTP SSE 登记身份、接收匹配目标的事件并领取任务；Codex 调用 ACP，Grok/ZCode 调用各自原生 CLI。React 网页展示标题、任务描述、发布人，以及运行状态和人工审批。

任务订阅是本平台的 HTTP 应用协议；Codex 执行使用标准 ACP v1。两者是独立链路。网页仍使用短轮询刷新界面，网页刷新不是任务订阅，也不是执行连接器。

## 当前功能与支持范围

| 功能       | 当前实现                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------- |
| 发布任务   | MCP `publish_task`，接收标题、描述、发布人名字与可选目标 Harness；也可使用网页表单            |
| 任务列表   | React + TypeScript 网页展示标题、描述、发布人、状态、结果与审批；支持桌面、手机尺寸和明暗主题 |
| 订阅与领取 | 独立 HTTP SSE 订阅、SQLite 持久事件、断线补发、原子领取和运行所有权                           |
| 执行连接器 | 本机 Codex ACP、Grok/ZCode 原生 CLI 连接器；新增 CLI 当前只验证简短文字任务                   |
| 人工审批   | 展示原始工具上下文与选项；支持允许、拒绝、取消、超时和旧请求失效，不自动批准                  |
| 恢复与状态 | 心跳租约、顺序幂等回传、进程退出恢复、显式重试；收到通知不等于执行成功                        |
| 本地持久化 | SQLite 保存任务、运行、审批和有限 ACP 事件；任务通知事件支持重放                              |

当前面向可信本机、单用户、单服务实例、全局串行执行。支持本机多 Harness 身份订阅和定向领取。后续范围包括远端 worker、多用户登录/授权、任务依赖 DAG、聊天工作台、模型路由、自动 Git 合并或公网部署。仓库中的网页界面目前为中文；双语切换只针对 README。

已有私有 Site 是仅使用浏览器本地数据的界面演示，不是运行此 Node 后端的地址，也不是 MCP 接入地址。

## 快速试用：无模型的完整传输闭环

要求 Node 24+，在本项目目录运行：

```bash
npm ci --ignore-scripts
npm run build
FAKE_ACP=1 npm start
```

打开 **http://127.0.0.1:60390**。默认同时启动平台和一个**独立 Node 订阅连接器子进程**。发布任务后，连接器日志会打印收到的事件 ID；任务变为待审批后可在网页允许、拒绝或取消。

`FAKE_ACP=1` 使用 `tests/fake-acp.ts`，它是通过官方 SDK 说 ACP 的真实测试子进程。HTTP、SSE、SQLite、领取、心跳、审批桥接和状态回传都是真实代码；模型与工具操作是模拟的，不调用模型、不执行展示的命令。页面有演示标记。

## 分开运行，观察离线保留和补发

终端一，仅启动平台：

```bash
FAKE_ACP=1 TASK_CONNECTOR=manual npm start
```

此时可通过 MCP 或网页发布任务。没有执行连接器时任务保持 `queued`，不会被另一个隐藏内部队列直接执行。

终端二，以 Codex 身份启动一个连接器：

```bash
FAKE_ACP=1 npm run connector
```

它从事件游标 0 开始接收历史及实时事件，领取仍在排队的任务。停止连接器后，未领取任务保留；再启动连接器会补收事件并继续。连接器进程退出不会静默标记成功；已领取的运行会在心跳失效后中断，需明确重试。

可在第三个终端只观察事件（不领取、不执行）：

```bash
curl -N http://127.0.0.1:60390/connector/events
```

重连时可指定最后完整收到的事件 ID：

```bash
curl -N -H 'Last-Event-ID: 12' http://127.0.0.1:60390/connector/events
```

ID 必须是本数据库中的有效游标范围；未来 ID、非整数等无效游标会被拒绝。观察流不能代替执行连接器。

## 真实 Codex ACP

官方适配器为锁定的 `@agentclientprotocol/codex-acp 2.5.0`，通过 Node 包入口启动，再启动它兼容的 Codex CLI App Server。没有使用 `codex exec` 文本输出假装 ACP，不需安装 Codeg 或 Zed。

先在你自己的本机完成登录：

```bash
npx --no-install codex-acp login
```

然后明确选择一个已存在的测试项目目录：

```bash
TASK_WORKSPACE=/absolute/path/to/your/project npm start
```

默认启动一个真实 Codex 订阅连接器，使用你已有的 Codex 登录。可用 `CODEX_HOME` 指定配置目录。平台不扫描或复制凭据，不提供登录页面。

若明确选择 API key 方法，先自行在进程环境提供 `CODEX_API_KEY` 或 `OPENAI_API_KEY`，再运行：

```bash
TASK_AUTH=api-key TASK_WORKSPACE=/absolute/path/to/your/project npm start
```

连接器检查适配器公布的认证方法后才发送 ACP `authenticate`。密钥不进入网页或任务数据库；适配器自己的登录可能更新你指定的 Codex 配置目录。未配置认证时会明确失败，完成配置后再重试。**本次已经复用现有登录完成 Codex 问候；真实工具审批仍需单独验证。**

拆分运行真实连接器时，两边必须使用同一 `TASK_WORKSPACE`、同一 fake/real 模式和相同认证配置。领取响应带有平台固定配置；连接器发现工作区或模式不一致，会报告失败并在启动 ACP 前停止。

`.env.example` 是说明，`npm start` 与 `npm run connector` 自动读取可选 `.env`。该文件不进入 Git 或源码包。

| 配置                   | 默认 / 说明                                                                    |
| ---------------------- | ------------------------------------------------------------------------------ |
| `PORT`                 | `60390`，仅允许 60001–65535，始终绑定 `127.0.0.1`                              |
| `TASK_WORKSPACE`       | 真实模式必须显式指定且已存在；平台与连接器必须一致                             |
| `TASK_DB`              | `./var/tasks.sqlite`，只由平台服务打开                                         |
| `TASK_CONNECTOR`       | 默认自动启动一个连接器；`manual` 仅启动平台                                    |
| `TASK_PLATFORM_URL`    | 独立连接器连接地址，默认 `http://127.0.0.1:60390`，只接受 loopback HTTP 根地址 |
| `FAKE_ACP`             | `1` 为无模型测试子进程；平台与连接器必须一致                                   |
| `TASK_AUTH`            | `existing` 或明确的 `api-key`                                                  |
| `CODEX_HOME` / API key | 仅真实执行时由运行环境转发到适配器，不保存到任务数据                           |

## MCP 发布与在线身份查询

Streamable HTTP 入口：`http://127.0.0.1:60390/mcp`。

```json
{
  "name": "publish_task",
  "arguments": {
    "title": "补充安装说明",
    "description": "检查 README，补充安装和启动步骤。",
    "publisherName": "小林"
  }
}
```

### 客户端接入示例

先启动本机服务，再在支持 Streamable HTTP 的 MCP 客户端里配置上面的 URL。以 Codex CLI 为例，手动执行：

```bash
codex mcp add Mingting --url http://127.0.0.1:60390/mcp
codex mcp list
```

也可以把下面配置**合并**进自己的 `~/.codex/config.toml`，不要覆盖已有配置：

```toml
[mcp_servers.Mingting]
url = "http://127.0.0.1:60390/mcp"
```

格式参考 [OpenAI 的 MCP 配置文档](https://developers.openai.com/resources/docs-mcp)。其他客户端的文件名和配置结构不同，应选择 HTTP/Streamable HTTP；本项目不会自动修改你的客户端配置。

### 参数 schema

标题、描述和发布人三个字段必填；可选 `targetHarness` 指定目标身份，目标离线时保持排队。服务端去除首尾空白并校验额外字段：

```json
{
  "type": "object",
  "properties": {
    "title": { "type": "string", "minLength": 1, "maxLength": 160 },
    "description": { "type": "string", "minLength": 1, "maxLength": 16000 },
    "publisherName": { "type": "string", "minLength": 1, "maxLength": 80 },
    "targetHarness": {
      "type": "string",
      "pattern": "^[A-Za-z][A-Za-z0-9_-]{0,39}$"
    }
  },
  "required": ["title", "description", "publisherName"],
  "additionalProperties": false
}
```

返回 `structuredContent: {"taskId":"<UUID>"}`。不需要打开网页或先启动连接器也能发布。项目包含官方 MCP 客户端示例：

```bash
npm run publish -- "补充安装说明" "检查 README 并补充启动步骤" "小林"
```

MCP `list_harnesses` 查询在线订阅身份；SSE 负责登记和通知，审批仍走现有网页流程。发布人名字仅展示，不代表认证身份。相同发布请求会生成不同任务，发布本身不是幂等操作。

## 订阅、领取与回传协议

所有连接器接口仅允许可信本机 CLI 请求；来自浏览器 Origin 或 Sec-Fetch-Site 的访问被拒绝。领取能力绑定 `runId + ownerId + claimId`，不会出现在网页详情或 SSE 事件里；不要把 claimId 当作业务字段转发给其他进程。它是本机运行所有权标识，不是模型凭据或多用户身份系统。

| 接口                                                      | 用途                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `GET /connector/events`                                   | SSE，`Last-Event-ID` 或 `?after=` 指定续传游标，默认 0                               |
| `POST /connector/claim`                                   | `{taskId, ownerId, claimId}`，原子领取，返回任务、run、平台固定工作区/模式及租约时长 |
| `POST /connector/runs/:id/heartbeat`                      | `{ownerId, claimId}` 续约，返回状态和 cancelRequested                                |
| `POST /connector/runs/:id/report`                         | `{ownerId, claimId, seq, update}`，顺序、幂等地回传会话、能力、通知或最终结果        |
| `POST /connector/runs/:id/permissions`                    | 当前所有者转交 ACP requestId 和原始 RequestPermissionRequest                         |
| `POST /connector/runs/:id/permissions/:approvalId/result` | 所有者查询人工决策，pending 时不能自动允许                                           |

SSE 示例：

```text
id: 42
event: task.available
data: {"id":42,"type":"task.available","taskId":"<UUID>","createdAt":"<ISO时间>"}

```

应用 schema 与派生类型集中在 `src/shared/protocol.ts`。ACP 仍使用官方 SDK；经 HTTP 转交的 ACP 负载额外使用 SDK 随附的官方 JSON Schema + Ajv 校验，没有另写一套 ACP wire schema。

## 可靠性与执行归属

- **持久发布：**任务和通知事件在一个 SQLite 事务中提交，再推送。订阅在发布前或发布后建立均可；无订阅者时任务不丢。
- **至少一次投递：**事件 ID 持久、单调递增。重连按游标补发，进程重启从 0 回放。重复事件是正常现象，不表示重复执行。
- **原子领取：**同一 task 只有一个当前运行，整个 MVP 同时只有一个未释放运行。并发领取只有一个成功；同 owner/claimId 的请求重试返回同一个 run。其他客户端不能更新或完成这个 run。
- **单一执行路径：**原来的服务内直接执行队列已移除。只有订阅连接器领取后才会调用 ACP，不存在内部队列和订阅端竞争执行。
- **回传幂等：**运行报告有递增 seq。已接受的重复报告不重复应用；有序号缺口则拒绝。收到事件或取得任务不会标记完成；只有 ACP `end_turn` 后成功回传最终状态，才显示 `succeeded`。
- **心跳：**连接器每 1 秒续约，默认租约 8 秒。等待人工审批也续约。HTTP 回传/心跳失败时连接器中止原 ACP 执行；租约过期由平台中断运行、使旧审批失效并释放串行槽位。失联运行不自动重跑，需用户检查后显式重试。
- **重启：**平台恢复时使旧运行和领取失效，旧审批过期，排队任务重新公告。若上次停止时有执行，持久记录最多 8 秒恢复等待期，让旧连接器完成停止后再接受新领取。
- **运行时界限：**事件流断开会重连，原运行是否继续由独立心跳判断；订阅重连不会自动再开同一运行。租约及报告 fencing 不能撤销已发生的文件改动；这不是业务操作的 exactly-once 或自动回滚保证。

单实例平台、可信本机连接器是本机部署边界。不要同时启动多个服务操作同一个数据库。可有只观察事件的客户端；重复执行连接器测试用于验证领取互斥，多 Harness 定向在通知及领取两处校验。

## 现在会不会卡住？

- `queued`：等待连接器在线或等待前一任务释放；离线发布允许正常排队。
- `awaiting_approval`：明确等待人。当前单并发设计会让后续任务等候，但不是事件丢失或程序死锁。可批准、拒绝或取消；10 分钟审批超时会取消。
- `cancelled` 且原运行未结束：正在让原进程停止。网页显示“正在停止原执行…”，结束前不允许重试，避免重叠执行。
- 连接器异常退出/失联：租约过期后变 `interrupted`，旧审批失效、槽位释放，不会永久堵住后续队列；需要重新启动连接器才能继续领取。
- 总执行超时 30 分钟。停止走 ACP cancel、stdin EOF 和必要的进程组 SIGTERM/SIGKILL 清理。

拒绝使用原始 reject optionId 回给同一 ACP 请求，取消回 `cancelled`；重复、旧运行、错误 session 的审批返回 409。网页断开不会自动批准。固定 `workspace-write / on-request / 人工审批者`；没有 full-access、YOLO 或模型代批。只有 Codex 实际上报的 ACP 权限请求进入审批，沙箱内常规操作不保证逐条询问。

## 安全、限制与验证

默认 loopback。校验本机来源、Host/Origin；网页写操作使用 HttpOnly/SameSite cookie 与 CSRF。连接器接口拒绝浏览器发起的请求，绑定领取所有权；这不是多用户鉴权。同机其他可信进程属于信任边界，不要通过公网代理、隧道或 `0.0.0.0` 无鉴权暴露。手机尺寸已适配，但真实手机跨设备访问没有实现。

队列上限 100，列表最近 200，每任务最多 20 次运行；每运行最多 100 张审批/16 张同时等待、300 条 ACP 事件、64000 字符输出。HTTP 最大 128 KiB，ACP 单消息 1 MiB；HTTP 并发最多 24，订阅流最多 8；待回传报告最多 256。常量集中在 shared/protocol。持久的任务通知日志目前不清理、不分 consumer 记 offset，重启回放可能包括已完成任务，领取接口会跳过它们。需要更长生命周期时应另做归档/保留设计。

```bash
npm test
npm run build
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/absolute/path/to/chromium npm run test:ui
```

测试使用真实 HTTP MCP、真实 HTTP SSE、独立连接器进程以及假 ACP 子进程，真实问候验证另见 [本次 qdev 记录](docs/task/task-harness-subscriptions.md)。历史测试事实见 [测试报告](docs/TEST-REPORT.md)。

源码包不含 node_modules、.env、数据库、凭据或运行数据。既有私有 Sites 页面仍是浏览器本地演示，此次后端更新不会使 Sites 自动具备 Node 子进程能力，也未自动改动或部署它。

官方项目：[Codex ACP](https://github.com/agentclientprotocol/codex-acp)、[ACP SDK](https://github.com/agentclientprotocol/typescript-sdk)、[MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)。
