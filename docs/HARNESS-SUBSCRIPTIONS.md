# Harness 订阅

状态为 Codex、Grok、ZCode、DeepSeek Harness 的 ACP 接入均有真实任务记录。日常服务的启用范围取决于项目配置。[身份订阅与问候验证](task/task-harness-subscriptions.md) · [多执行器接入](task/task-multi-harness-acp.md)

## H1 身份

常驻连接器通过本机 HTTP SSE 携带 harnessName 与 ownerId 登记在线身份。连接关闭后对应订阅下线。MCP `list_harnesses` 提供当前在线列表，运行历史保存实际执行身份。支持 Codex、ZCode、Grok 和 DeepSeek 四个执行目标。身份由可信本机进程登记。

## H2 定向发布

MCP `mcp-mingting-tool` 可携带 targetHarness。服务对通知和领取同时匹配目标名称，大小写无关。指定目标离线时任务保持排队，目标恢复订阅后回放。省略目标沿用原来的可用连接器领取方式。既有单任务串行槽位与所有权校验继续生效。

## H3 执行

四个连接器统一通过 ACP v1 执行。Codex 使用官方 Codex ACP。Grok 使用 xAI 的 `grok agent stdio`。DeepSeek 使用官方 `dsh --profile acp`。ZCode 使用明庭维护的 ACP 桥接器驱动原生 CLI 0.17.1 的 `zcode app-server --stdio`。桥接器将原生权限请求转换为 ACP `session/request_permission`，再把明庭选定的原始响应回传给 ZCode。

Grok 固定 plan 模式，仅开放 Read。ZCode 桥接器限制为一次文本回合，并在原生会话中仅开放 Read。Codex 沿用 workspace-write 和人工审批。DeepSeek 按官方 ACP profile 运行，由其工具权限策略决定是否发出审批。MCP 负责发布与查询身份，连接器负责订阅、领取、唤起与按序回传。ZCode 已验证真实 Read 审批与同次运行审计。

## H4 部署

运行目录、依赖、缓存、数据库和日志位于本项目。复用现有 Node 与 CLI 可执行文件，登录使用项目副本；进程 HOME、配置发现与状态目录使用项目内独立目录，关闭 Grok 自动升级。服务只监听 127.0.0.1，提供项目内启动、停止、状态入口。

## H5 实时执行过程

网页通过同源会话保护的 SSE 实时接收完整快照，包含列表、在线身份、当前任务、审批及执行过程。回答按 agent_message_chunk 合并；思考按执行器实际提供的 agent_thought_chunk 显示；tool_call/tool_call_update 按同一工具 ID 更新等待、执行中、完成或失败状态，并提供输入输出摘要。空思考与空工具如实显示。

原始事件保留最近300项，正文/思考各保留最近64000字符，工具保留最近100项且输入输出各最多8000字符。持久化过程投影随同一运行的有效、有序通知更新；重连/刷新以 SQLite 当前快照替换网页状态，继续使用原有领取租约、取消与旧会话隔离。慢连接合并更新并等待 drain，超时关闭后可重连。

连接中断后网页会按重连间隔重新建立会话与实时流，临时恢复失败会继续重试；关闭页面或切换任务会清理旧连接（见[恢复任务](task/task-web-reconnect.md)）。

## H6 审批订阅

执行者通过ACP申请审批，任务发起方通过任务专属订阅接收和决定。发布时可多选审批对象，首版启用订阅者、第三方置灰。网页自动弹窗显示两方意见；用户优先，订阅者先决定后保留10秒用户窗口。完整行为、接口与裁决规则见 [审批](APPROVALS.md)，验证见 [任务记录](task/task-approvals.md)。

## Changelog

| 日期       | 类型 | 内容                                            | 记录                                                     | 状态   |
| ---------- | ---- | ----------------------------------------------- | -------------------------------------------------------- | ------ |
| 2026-11-01 | 修复 | H3原生双向审批、项目OAuth请求授权、拒绝状态同步 | 修复报告（本机归档） | 已完成 |
| 2026-11-01 | 新增 | H6发起方审批订阅、弹窗与十秒用户优先窗口        | [任务](task/task-approvals.md)                           | 已完成 |

### 历史变更

| 日期       | 类型      | 内容                                               | 记录                                       | 状态                         |
| ---------- | --------- | -------------------------------------------------- | ------------------------------------------ | ---------------------------- |
| 2026-11-01 | 新增      | H1–H4 身份订阅、目标领取、真实问候与本机部署       | [task](task/task-harness-subscriptions.md) | 部分完成，ZCode 模型执行阻塞 |
| 2026-11-01 | 修复      | H3 ZCode 账户绑定、隔离环境与 GLM-5.3 完整问候     | [qdev](task/task-zcode-model-selection.md) | 已完成                       |
| 2026-11-01 | 修改/新增 | H3–H5 ACP 接入、项目 HOME 隔离、流式回答/思考/工具 | [qdev](task/task-acp-streaming.md)         | 已完成                       |

## 使用本机部署

在项目根目录执行：

```bash
node scripts/local-service.mjs start
node scripts/local-service.mjs status
node scripts/local-service.mjs stop
```

页面：http://127.0.0.1:60390 ，MCP：http://127.0.0.1:60390/mcp 。后台服务跟随系统会话运行，当前部署使用项目内 `.env`，`TASK_HARNESSES=Codex,ZCode,Grok`。开机自动启动留在后续范围。

独立连接器示例：`TASK_HARNESS=Grok npm run connector`。MCP 客户端以临时配置接入上述 HTTP 地址，先调用 `list_harnesses`，再调用：

```json
{
  "name": "mcp-mingting-tool",
  "arguments": {
    "title": "打招呼",
    "description": "请只回复：你好，我是 Grok。",
    "publisherName": "Codex",
    "targetHarness": "Grok"
  }
}
```

也可执行 `npm run publish -- "打招呼" "请只回复：你好，我是 Grok。" "Codex" "Grok"`。

SSE 自报身份的请求头是 `x-harness-name` 和 `x-owner-id`（UUID）。缺少身份的流作为观察者；指定目标的领取要求同 ownerId 已有匹配的在线订阅。名称匹配忽略大小写。没有目标的旧调用保留兼容。

## 2026-11-01 实测

真实发布者为另一个 Codex CLI，经临时 MCP 配置和 CLI 自动审批发布三个任务。每个任务均记录了实际 harnessName 和独立 runId。

| 目标  | 订阅 / 领取 / 唤起              | 最终结果                        |
| ----- | ------------------------------- | ------------------------------- |
| Codex | 通过，Codex ACP 2.5.0           | `你好，我是 Codex。`，succeeded |
| Grok  | 通过，原生 Grok CLI             | `你好，我是 Grok。`，succeeded  |
| ZCode | 通过，原生 zcode CLI（GLM-5.3） | `你好，我是 ZCode。`，succeeded |

前轮任务 ID、模型会话 ID、MCP 调用与启动 PID 见 历史证据（本机归档）。本轮 ZCode 账户绑定与项目隔离修复后的 完整证据（本机归档） 对应任务 `036e0903-a80d-4afc-97d4-0de3030e913f`，原生 idle 最终结果成功回传。历史失败任务保留原始结果。

## ZCode 项目内模型与登录配置

当前 CLI 0.17.1 需要 provider 账户绑定与有效 OAuth 登录。支持 GLM-5.3、GLM-5.3-Flash；本次选择 `account:bigmodel-individual-coding-plan / GLM-5.3 / high`。

显式初始化（`--source` 只读，传入本机已有登录文件路径）：

```bash
node --import tsx scripts/prepare-zcode-local.ts --source /absolute/path/to/.zcode/v2/credentials.json --builtin /Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json
```

脚本从所选 provider 的唯一账户记录提取标识，复制对应 OAuth 登录的原始密文，补齐 CLI 所需 identity/auth-source 绑定；同时复制源文件中属于该账户的既有原生 Coding Plan 默认项目位置缓存，重复初始化时保留项目副本中的同账户缓存。输出位于忽略的 `var/zcode-local` 和 `var/zcode-provider.json`；私有凭据文件 0600、目录 0700。脚本拒绝项目外输出、符号链接目标、缺失/多账户和未加密登录输入。输出只含路径和模型名称。原账户文件保持只读，平台仅访问项目内的隔离账户。

项目 `.env` 设置 `ZCODE_DATA_BASE_DIR=.../var/zcode-local`，`ZCODE_STORAGE_DIR` 和 `ZCODE_HOME` 指向其 `.zcode`，`ZCODE_SESSION_DB_PATH` 指向其中的会话库；`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 指向复制后的内置配置，`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 指向 `var/zcode-provider.json`。ZCode 子进程 HOME 同时设为该项目账户根，避免加载用户级 hooks。原始密文使用原客户端的解密材料，通过进程环境传入。

原生 app-server 的账户注册与请求期授权由桥接器宿主提供。首版支持项目内 BigModel 个人 Coding Plan OAuth：读取已有默认项目位置缓存，向 BigModel 官方域名申请短期请求令牌，仅在内存中持有；账户、会话或代次变化会终止旧授权。创建会话和发送任务都携带完整模型及思考级别。原生账户缺少既有位置缓存时，任务返回初始化提示；原生客户端完成初始化后再更新项目副本。其他账户类型、写入工具和通用问答交互留在后续范围。`ZCODE_SESSION_DB_PATH` 可显式指向项目内另一实体路径，用于隔离审批测试。

初始化依赖唯一的个人 Coding Plan 账户记录。隔离 OAuth 过期后，在原客户端完成正常登录，再显式重跑初始化命令更新项目快照。CLI 升级后应重新核对模型注册表和原生输出。本次核对的原安装、全局登录及配置文件哈希一致。

Codex/Grok 首次部署执行 `node --import tsx scripts/prepare-harness-local.ts`，只读复制现有登录到 `var/codex-local` / `var/grok-local`，保留已有项目登录副本。`CODEX_HOME`、Grok auth/config 路径和各子进程 HOME 均指向项目目录；配置根拒绝项目外路径及符号链接。平台依赖、npm 缓存、配置和数据库保存在项目内。进程环境清除代理使用 `TASK_DIRECT_NETWORK=1`。

## ACP 实时展示实测

2026-11-01 的[本轮任务](task/task-acp-streaming.md)已完成qdev。经 MCP 指定 Codex/Grok/ZCode，各自产生一个独立运行，读取项目 HELLO.txt 并问候；三项均成功。网页 SSE 在结束前收到正文与工具，Grok/ZCode同时有思考内容；本次Codex思考为空。刷新后快照一致，桌面与手机6项交互通过，自动测试40项通过。实际链路（本机归档）、接入兼容性及隔离边界（本机归档）记录协议来源和历史差异。

2026-11-01 H5恢复修复：关闭的实时流与临时会话恢复失败均持续重试；已完成，见[恢复qdev](task/task-web-reconnect.md)。

## 多执行器设置和审计

明庭按执行器发现模型和档位，设置生效回执、工具、原审批决定、用量和上下文归入该次运行。执行器通过各自的 ACP 入口提供配置和指标，界面区分已确认、未上报和目录数据。Codex 原有工作区策略沿用，Grok、ZCode 和 DeepSeek 的可用工具与权限以各自入口及项目配置为准。

| 执行器 | 任务 Usage | 上下文 |
| --- | --- | --- |
| Grok | ACP prompt 元数据，包含可用的费用字段 | 流中占用，模型目录标称窗口 |
| ZCode | 一次原生会话的 Usage，保留上游会话 ID | 结束时原生会话占用与有效窗口，另存目录标称窗口 |
| DeepSeek | 官方 ACP 负责执行。适配器补读同一新会话的完整原生 v4 回合日志，按已提交步骤对账 | 官方 ACP 标准 `usage_update` 的占用和有效窗口 |

DeepSeek 以 `DeepSeek` 加入 `TASK_HARNESSES`。宿主需要可运行的 `dsh` 和项目内 `TASK_DEEPSEEK_HOME`，默认 `var/deepseek-local`。登录放在该目录的 `.credentials.yaml`，也可显式提供 `DEEPSEEK_API_KEY`。压缩 v4 日志由宿主已有的 `zstd` 解码。上游缺项保留为空，重试或日志缺失时保留待核实状态。Grok 可用 `TASK_GROK_HOME` 选择独立的项目内登录目录。

### 变更记录

- 2026-11-06 接入 Grok、ZCode 和 DeepSeek Harness 的统一运行审计。三家真实读取通过，ZCode 实测原生审批。正式启用待部署。[任务](task/task-multi-harness-acp.md)

## 离线回归

将真实运行证据提取为测试夹具，保留设置、可观测事件、用量字段与审批选项。回放通过本地 ACP 子进程驱动明庭连接器、适配器与 SQLite，供默认后端回归运行。执行 `npm run test:unit`，或用 `node --import tsx --test tests/acp-offline-replay.test.ts` 只跑五条录制用例。测试读取仓库中的夹具，模型与工具由录制结果提供。

- 2026-11-06 新增真实 ACP 运行离线回放，五条录制用例及默认后端回归通过。[任务](task/task-acp-offline-replay.md)
