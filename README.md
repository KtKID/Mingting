# 任务台 MVP

本机运行的任务发布与审批平台。MCP **只提供 `publish_task`**；Node TypeScript 服务保存任务、排队并调用 Codex ACP；React TypeScript 网页显示标题、任务描述、发布人名字，在详情侧栏处理 ACP 审批。

这是可运行的多文件项目，需要 Node 子进程。没有公网部署，没有自动配置你的 MCP 客户端，没有启动或安装 Codeg。发布人名字仅用于展示，不是登录身份。

## 快速试用（Mac / Linux，Node 24+）

在项目目录执行：

```bash
npm ci --ignore-scripts
npm run build
FAKE_ACP=1 npm start
```

浏览器访问 **http://127.0.0.1:60390**。点击“发布任务”，填写标题、描述、名字。任务出现“待审批”后，在侧栏选择允许或拒绝，观察结果。

演示通过**真正的子进程和官方 ACP SDK**交换协议消息，但子进程是 `tests/fake-acp.ts`：不调用模型、不读写任务文件、不执行页面上展示的命令。网页有醒目的演示标记。这只能证明平台闭环，不能代替真实 Codex 联调。

## 接入真实 Codex ACP

锁定依赖已经包含官方 `@agentclientprotocol/codex-acp`（当前锁定 2.5.0）及其兼容的 Codex CLI。服务直接启动这个包的 Node 入口，不用 `codex exec` 代替 ACP，不在运行时下载可执行程序。

先自行登录官方适配器使用的 Codex（请使用你自己的账户）：

```bash
npx --no-install codex-acp login
```

然后选定一个你愿意交给 Codex 操作的、已存在的项目目录：

```bash
TASK_WORKSPACE=/absolute/path/to/your/project npm start
```

默认使用现有 Codex 登录状态。可通过 `CODEX_HOME` 指定自己的 Codex 配置目录。平台本身不提供登录页面，不扫描或复制凭据。认证缺失时任务会失败，保留初始化时发现的认证方式，待你完成配置后显式重试。

如需明确选择 API key 认证，可自行配置环境后运行：

```bash
TASK_AUTH=api-key TASK_WORKSPACE=/absolute/path/to/your/project npm start
```

这个模式要求你已经在进程环境提供 `CODEX_API_KEY` 或 `OPENAI_API_KEY`。平台检查适配器是否公布 `api-key` 方法，再发送标准 ACP `authenticate` 请求；密钥由适配器读取，平台不通过网页或数据库保存密钥。适配器登录行为可能更新你指定的 Codex 配置目录。不要把密钥写进源码或提交到 Git。

`.env.example` 是配置说明；`npm start` 自动读取本项目可选 `.env`。该文件已被 Git 忽略。修改配置后需重启服务。

| 配置                               | 默认值 / 说明                                                |
| ---------------------------------- | ------------------------------------------------------------ |
| `PORT`                             | `60390`，仅允许 60001–65535，始终绑定 `127.0.0.1`            |
| `TASK_WORKSPACE`                   | 真实模式必须显式指定、必须已存在；所有任务共用此工作区       |
| `TASK_DB`                          | `./var/tasks.sqlite`，持久化任务、运行、审批、有限数量的事件 |
| `FAKE_ACP`                         | `1` 为测试子进程；其余为真实 Codex ACP                       |
| `TASK_AUTH`                        | `existing` 或显式 `api-key`；演示不认证                      |
| `CODEX_HOME`                       | 仅真实模式向适配器转发你的 Codex 配置目录                    |
| `CODEX_API_KEY` / `OPENAI_API_KEY` | 仅真实模式向适配器转发，不记录、不展示                       |

请先用独立测试仓库验证真实执行。当前实现固定 `workspace-write`、`on-request` 和人工审批者；不会启用 full access、YOLO 或模型代批。初始化后还会检查并选择 `workspace-write` 模式，不支持该模式就停止。

## MCP：仅发布任务

入口：`http://127.0.0.1:60390/mcp`，使用官方 MCP SDK 的 **Streamable HTTP**，无状态 POST。工具列表只有一个：

```json
{
  "name": "publish_task",
  "arguments": {
    "title": "补充项目安装说明",
    "description": "检查 README，补充安装和启动步骤。",
    "publisherName": "小林"
  }
}
```

成功返回的 `structuredContent` 为：

```json
{ "taskId": "<UUID>" }
```

无需打开网页也能发布。可直接用项目中的真实 MCP 客户端示例：

```bash
npm run publish -- "补充安装说明" "检查 README 并补充启动步骤" "小林"
```

可选 `TASK_MCP_URL` 仅供这个示例客户端指定本机端口。其他客户端配置时选择 HTTP / Streamable HTTP，并填入上面的 `/mcp` URL；具体配置字段随客户端而异。本项目不替你修改客户端配置。MCP 不提供查看、订阅、审批或执行命令工具。

网页的小发布表单调用同一个任务应用服务，没有另一条执行链路。服务端严格限制客户端输入为三个字段，拒绝自定义命令、执行器和工作目录。相同内容的两次发布会产生两个任务；发布工具不是幂等接口。

## 架构与归属

```text
MCP 客户端 → publish_task ─┐
                          ├→ TaskService → SQLite → 单并发队列 → CodexAdapter → codex-acp → Codex App Server
React 网页 → 本机 HTTP ──┘                                  ↑                    │
                                                           └── ACP 审批回调 ────┘
```

单向依赖：`web → shared`；`HTTP → TaskService → Store / CodexAdapter → shared`。`shared/protocol.ts` 的 Zod schema 是应用输入与数据类型的唯一来源，类型由 schema 推导。ACP/MCP 使用官方 SDK 的类型和解析，未另写一套 ACP/MCP JSON-RPC 协议。

- **任务**保存需求、发布人展示名、当前状态。发布人并不因此获得审批授权。
- **运行**保存某次执行、固定执行器、ACP session、能力发现、输出和停止原因。重试创建新运行。
- **审批单**保存 `taskId / runId / sessionId / requestId`、原始 toolCall 和 options。页面只是处理同一张审批单的入口。

`initialize → 认证能力发现 → 可选显式 api-key authenticate → session/new → session/set_mode → session/prompt`。`session/update` 保存有限事件并积累文本结果。客户端不宣告宿主 shell、terminal、read/write fs 能力，也不实现更宽权限的 shell/fs 代理；Codex 保留自己的文件和命令执行及原有沙箱。

ACP `request_permission` 只在匹配当前 session 时登记。网页从原始 options 选择，服务器验证选项、当前运行、session 和 pending 状态，再回复**同一个内存中的 ACP 请求**：

- 允许或拒绝均回传 `selected + 原始 optionId`，不会把拒绝改成允许。
- 相同审批只能决策一次；重放或过期请求返回 409。
- 断开网页不会自动批准；审批 10 分钟超时后取消任务。
- 取消发送 `session/cancel`，待审批请求以 `cancelled` 结果结束，之后旧按钮失效。
- 服务停止或重启将旧运行标记 `interrupted`，旧审批标记 `expired`。原内存回调不能复活；只能显式重试新运行。排队任务在重启后继续。
- 停止时先结束 stdin，必要时终止所启动的进程组；执行总超时 30 分钟。
- `succeeded / 已完成` 表示 ACP 回合以 `end_turn` 结束，不代表有人验收了任务，也不表示任何被拒绝的工具已经执行。

## 本地边界与限制

仅供可信本机用户使用。校验 loopback 来源、Host、Origin，网页变更要求同源、临时 HttpOnly / SameSite cookie 和 CSRF token。审批同时绑定运行和 ACP session；这些措施用于防跨站和重放，**不是多用户身份认证**。同一台机器上的其他可信进程属于本地信任边界。手机尺寸已适配，但当前 loopback 服务不能由真实手机跨设备访问。

不要通过反向代理、隧道或 `0.0.0.0` 无鉴权暴露服务。若以后要远程访问，应另行加入真实身份和审批授权、TLS 等部署设计。本版本不包含这些功能。

Codex 的 `workspace-write` 允许工作区内常规编辑和操作；只有它实际发出的 ACP 权限请求会进入网页，不是“每条命令必审批”。平台不会为没有上报的操作凭空生成审批。目标工作区的 Codex 配置、沙箱兼容性、原生依赖及登录状态，仍需你在本机确认。

队列最多 100 个活动任务，单并发；列表显示最近 200 项，不删除历史。每任务最多 20 次运行，每运行最多 100 张审批、同时最多 16 张待审批；每运行保留最近 300 条协议事件、最近 64000 字符输出。HTTP 请求 128 KiB，ACP 单消息 1 MiB，请求并发最多 16，网页临时会话最多 64。常量集中在 `shared/protocol.ts`。结果可能截断，MVP 未做日志归档和数据库清理。

同一数据库只运行一个服务实例。任务没有依赖 DAG、多 Harness、订阅总线、远端 worker、模型路由、Git 自动合并或聊天工作台。服务不会替你提交或合并 Codex 在目标工作区内产生的改动。

## 验证与项目文件

```bash
npm test
npm run build
npx playwright install chromium
npm run test:ui
```

若机器已安装 Chromium，可以设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/absolute/path/to/chromium`，不下载浏览器。UI 测试只启动演示子进程，端口 60391，独立临时数据库。

- `src/shared/protocol.ts`：schema、派生类型与常量
- `src/server/store.ts`：SQLite 与重启恢复
- `src/server/service.ts`：发布、队列、运行、审批状态
- `src/server/codex-adapter.ts`：真实 ACP 子进程连接与生命周期
- `src/server/http.ts`：本机 HTTP、唯一 MCP 工具、网页会话校验
- `src/web/`：任务列表、详情、发布表单与审批
- `tests/`：真实 HTTP MCP 集成、真实 ACP 测试子进程、浏览器交互
- `docs/TEST-REPORT.md`：本轮实测结果与尚未验证部分

源码包不含 `node_modules`、运行数据库、`.env`、账户或凭据。安装依赖需要网络。首次启动前先构建网页；更改源码后重新 `npm run build`。

## 官方参考

- [Codex ACP 官方仓库与安装说明](https://github.com/agentclientprotocol/codex-acp)
- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

本轮依据锁定的 SDK 与适配器代码实现稳定 ACP v1，不启用实验 v2 或 AIR 扩展。
