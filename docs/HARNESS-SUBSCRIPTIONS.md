# Harness 订阅

状态：Codex、Grok、ZCode 的身份订阅与真实问候均已通过。任务记录：[身份订阅与问候验证](task/task-harness-subscriptions.md)、[ZCode 修复](task/task-zcode-model-selection.md)。

## H1 身份

常驻连接器通过本机 HTTP SSE 携带 harnessName 与 ownerId 登记在线身份。连接关闭后对应订阅下线。MCP `list_harnesses` 提供当前在线列表，运行历史保存实际执行身份。当前目标为 Codex、ZCode、Grok；身份是可信本机进程的自报名称。

## H2 定向发布

MCP `publish_task` 可携带 targetHarness。服务对通知和领取同时匹配目标名称，大小写无关。指定目标离线时任务保持排队，目标恢复订阅后回放。省略目标沿用原来的可用连接器领取方式。既有单任务串行槽位与所有权校验继续生效。

## H3 执行

Codex 使用项目内 Codex ACP 与其兼容 CLI；Grok/ZCode 使用各自现有 CLI。当前新增原生 CLI 接入限于简短文字问候，CLI 工具审批和复杂任务留待专项验证。MCP 负责发布/查询身份，SSE 负责常驻任务通知与身份注册；CLI 在成功领取后启动，完成输出回传平台。

## H4 部署

运行目录、依赖、缓存、数据库和日志位于本项目。复用现有 Node 与 CLI 登录，进程环境覆盖仅作用于本项目启动。服务只监听 127.0.0.1，提供项目内启动、停止、状态入口。

## Changelog

| 日期       | 类型 | 内容                                           | 记录                                       | 状态                         |
| ---------- | ---- | ---------------------------------------------- | ------------------------------------------ | ---------------------------- |
| 2026-11-01 | 新增 | H1–H4 身份订阅、目标领取、真实问候与本机部署   | [task](task/task-harness-subscriptions.md) | 部分完成，ZCode 模型执行阻塞 |
| 2026-11-01 | 修复 | H3 ZCode 账户绑定、隔离环境与 GLM-5.3 完整问候 | [qdev](task/task-zcode-model-selection.md) | 已完成                       |

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
  "name": "publish_task",
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

前轮任务 ID、模型会话 ID、MCP 调用与启动 PID 见 [历史证据](../reports/subscription-smoke/live-evidence.json)。本轮 ZCode 账户绑定与项目隔离修复后的 [完整证据](../reports/zcode-model-selection/live-evidence.json) 对应任务 `036e0903-a80d-4afc-97d4-0de3030e913f`，原生 idle 最终结果成功回传。历史失败任务保留原始结果。

## ZCode 项目内模型与登录配置

当前 CLI 0.17.1 需要 provider 账户绑定与有效 OAuth 登录。支持 GLM-5.3、GLM-5.3-Flash；本次选择 `account:bigmodel-individual-coding-plan / GLM-5.3 / high`。

显式初始化（`--source` 只读，传入本机已有登录文件路径）：

```bash
node --import tsx scripts/prepare-zcode-local.ts --source /absolute/path/to/.zcode/v2/credentials.json --builtin /Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json
```

脚本从所选 provider 的唯一账户记录提取标识，仅复制对应 OAuth 登录的原始密文，补齐 CLI 所需 identity/auth-source 绑定。输出位于忽略的 `var/zcode-local` 和 `var/zcode-provider.json`；私有凭据文件 0600、目录 0700。脚本拒绝项目外输出、符号链接目标、缺失/多账户和未加密登录输入。输出只含路径和模型名称。原账户文件保持只读，平台仅访问项目内的隔离账户。

项目 `.env` 设置 `ZCODE_DATA_BASE_DIR=.../var/zcode-local`，`ZCODE_STORAGE_DIR` 和 `ZCODE_HOME` 指向其 `.zcode`，`ZCODE_SESSION_DB_PATH` 指向其中的会话库；`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 指向复制后的内置配置，`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 指向 `var/zcode-provider.json`。真实 HOME 保持原值。

初始化依赖唯一的个人 Coding Plan 账户记录。隔离 OAuth 过期后，在原客户端完成正常登录，再显式重跑初始化命令更新项目快照。CLI 升级后应重新核对模型注册表和原生输出。本次核对的原安装、全局登录及配置文件哈希一致。

平台依赖、npm 缓存、配置和数据库保存在项目内。CLI 复用已有账户存储，各 CLI 自带的会话/账户运行状态由其现有目录管理。进程环境清除代理使用 `TASK_DIRECT_NETWORK=1`；本次保持系统代理和个人客户端配置原样。
