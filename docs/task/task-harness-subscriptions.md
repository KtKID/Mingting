> 2026-11-01 后续状态：ZCode 的模型选择与问候阻塞已在 [后续 qdev](task-zcode-model-selection.md) 修复，完整真实链路 succeeded。本文保留首次实现与当时验收的历史记录；当前功能以 [Harness 订阅](../HARNESS-SUBSCRIPTIONS.md) 为准。

# Harness 身份订阅与定向问候验证

> 归属：MCP 发布 / HTTP SSE 订阅连接器
> 功能文档：[Harness 订阅](../HARNESS-SUBSCRIPTIONS.md)
> spec：无，沿用 README 中的传输闭环
> 范围：H1–H4；设计：本文②；创建：2026-11-01；状态：部分完成；ZCode 模型执行阻塞

## ① 需求与变更

依据本次用户明确要求：在本项目部署；项目内安装依赖；复用现有 CLI 与登录；Codex、ZCode（已澄清 JCode 指 ZCode）、Grok 分别订阅身份；发布者可指定 harness；目标离线保持排队；真实任务只打招呼；保护电脑环境；代码修改走 x-qdev。

原始基线：`8ab0dcc`，可读旧功能文档保存在 `reports/subscription-smoke/README.before.md`。旧版只有 Codex ACP 和匿名 ownerId，MCP 只有 publish_task，尚缺身份路由。现有 21 项测试及构建在本机授权的网络/监听环境中通过；受限执行环境中的 Node 25 测试进程出现原生断言失败，后续 HTTP 测试使用可监听的环境。

新增 H1 身份在线登记，H2 目标定向与离线保留，H3 真实问候执行与结果，H4 项目内可启停部署。保持现有 SQLite 所有权、串行执行、审批和恢复语义。变更索引见功能文档。

## ② 精简技术设计

- D1/H1：共享 Zod 定义 harness 名称、订阅身份、可选 targetHarness 和 run.harnessName。SSE 请求携带 ownerId 与 harnessName；服务仅在连接存续期间登记身份。重复同身份连接使用计数，异名重绑定拒绝。在线列表通过 MCP list_harnesses 和浏览器 API 读取。
- D2/H2：服务端过滤 SSE 目标，并在原子 claim 内再次核对订阅身份；名称大小写无关。指定目标离线时保持 queued。观察者保留历史订阅功能，旧版无目标 claim 保留兼容。任务/运行仍存 SQLite，在线状态由活跃连接推导。
- D3/H3：Codex 保持现有 ACP；原生 CLI 使用相同执行接口桥接结果，分别标识 Grok/ZCode，只有有效最终结果才成功。Grok 关闭工具和子代理；ZCode 使用 plan 与工具限制。本次只验证问候，其他 CLI 工具和审批属于后续范围。启动命令由项目侧固定，任务文本通过独立参数传递。
- D4/H4：依赖、缓存、.env、日志、数据库、测试工作区放在项目内；现有 CLI 与登录只复用。临时进程环境处理失效代理与 ZCode 打包路径；独立项目启动/停止入口，禁止全局安装、改代理、改全局客户端配置。启动时明确配置订阅的 harness。

适用规范：R1 入口/传输/执行职责分开；R2 Zod 协议唯一源；R3 全部 TypeScript、跨语言仅调用现有 CLI 输出；R4 SQLite 存任务与运行、活跃 SSE 存在线状态；R5 harnessName/targetHarness 统一；R6 沿用 LIMITS 超时、容量与清理；R7 领取 fencing/报告序列及租约沿用，新增身份检查在服务端执行。采用现有 strict tsc、格式化与测试；本轮保持依赖清单和 lock 原样。

## ③ 测试用例与变化

| 用例   | 变化     | 范围     | 操作与预期                                                                 |
| ------ | -------- | -------- | -------------------------------------------------------------------------- |
| T1     | 新增     | H1/D1    | 两条同身份 SSE 同时在线；关闭一条仍在线，全部关闭后离线；异名重绑定拒绝    |
| T2     | 新增     | H2/D2    | 向离线 ZCode 发布任务，Codex 在线仍 queued；ZCode 上线后收到历史事件并完成 |
| T3     | 新增     | H2/D2    | 错误身份、匿名观察者领取指定任务被拒绝；大小写匹配目标；运行留存执行身份   |
| T4     | 新增     | H1/H2    | 真实 HTTP MCP 列出在线 harness 并发布带目标任务；SSE 只投递匹配目标        |
| T5     | 新增     | H3       | CLI 有效结束返回输出；进程失败、错误 JSON、缺少最终结果和超时均失败        |
| T6     | 新增人工 | H3       | Codex、Grok、ZCode 分别真实一句问候；逐项记录成功、失败与原因              |
| T7     | 新增人工 | H4       | 项目启动/状态/停止、浏览器在线身份与任务目标/结果可见                      |
| R1–R21 | 沿用     | 既有闭环 | 原 21 项 HTTP/SSE/ACP、审批/取消/恢复/安全测试逐项回归                     |

用例层面新增 7 项、沿用 21 项，修改 1 项既有工具发现断言、删除 0；框架实际展开数见⑤。单元替身只验证路由和错误处理；真实 CLI 结论单独取证。

## ④ 技术实现

D1/D2：`src/shared/protocol.ts`、`src/server/service.ts`、`src/server/http.ts` 定义/校验身份和目标；在活跃 SSE 登记 ownerId，关闭时注销；SSE 过滤与原子领取共同约束目标；`list_harnesses` 返回在线身份。旧任务字段采用可选/default，保持读取旧库兼容。

D3：`src/server/cli-adapter.ts` 桥接原生单轮 CLI 并校验最终 JSON，处理失败、取消、输出上限和强制进程组清理；`codex-adapter.ts` 保持 ACP 并增加启动 PID 日志；`runtime.ts` 固定 Codex/Grok/ZCode 入口及工具限制；`connector/*` 使用同一领取/心跳/顺序回传机制，SSE 带身份。

D4：`src/server/main.ts` 按 TASK_HARNESSES 启动独立连接器；`scripts/local-service.mjs` 项目内后台启停；`scripts/publish-task.ts` 增加可选目标；`src/web/main.tsx` 显示在线身份、目标、真实执行身份，表单可选目标；`index.html` 更新平台标题；`.gitignore` 增加项目缓存；`.env.example` 补配置。README 中英文、PROGRESS 和功能文档同步。

专项测试在 `tests/routing.test.ts`、`tests/cli-adapter.test.ts`。既有 `platform.test.ts` 仅修改工具发现预期，使其包含新增只读工具；其余断言保留。来源/实际文件基线：source-baseline.json（本机归档）。依赖清单及 lock 内容与 HEAD 相同。实现范围与②一致，额外的页面标题改动属于身份展示。

## ⑤ 验证结果

### 用户阅读：本次结果与全部用例

身份、定向、离线排队、Codex/Grok 真实执行和项目内部署已完成。ZCode 成功注册身份、领取并启动 CLI，随后报告模型选择错误。真实任务均为一句问候。最终自动测试 **28/28**，桌面/手机网页回归 **4/4**；模型联调 **Codex/Grok 2 项成功、ZCode 1 项失败**。功能成功结论分别记录。

| 用例     | 准备 → 操作                                                         | 预期与实际                                                               | 证据                                                     |
| -------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------- |
| T1       | 同 owner 的 Codex SSE 连接两次、关闭一条/全部、尝试改名             | 在线计数保持，全部关闭下线；异名 409，通过                               | routing-green.log / final-check.log                      |
| T2       | Codex 在线时为离线 ZCode 发任务，再启动 ZCode 订阅                  | 保持 queued；恢复后重放并领取，通过（执行结果替身）                      | final-check.log                                          |
| T3       | 错误/匿名身份领取指定任务；zcode 小写领取 ZCode                     | 错误身份 403；正确身份成功，run 保存身份，通过                           | final-check.log                                          |
| T4       | 真实 HTTP MCP 查询在线身份并发目标任务，重放跨过 201 条别的目标事件 | list_harnesses、定向投递和游标分页通过                                   | final-check.log                                          |
| T5a      | Node 真实子进程输出最终 JSON，参数包含 shell 特殊字符               | 原文按参数传递、会话/文本完整，通过                                      | final-check.log                                          |
| T5b      | 子进程输出错误 JSON、非 end_turn、退出 7                            | 全部报告失败，通过                                                       | final-check.log                                          |
| T5c      | 中断正在运行的子进程                                                | 停止原执行并报告取消，通过                                               | final-check.log                                          |
| T5d      | 子进程忽略 SIGTERM 后中断                                           | 约 2 秒后强制清理，通过                                                  | final-check.log                                          |
| T6 Codex | 真实 Codex CLI 临时接入 MCP，发布指定 Codex 的问候                  | 平台自动唤起 ACP/CLI，succeeded，输出“你好，我是 Codex。”，通过          | live-evidence.json                                       |
| T6 Grok  | 同一 Codex 发布者指定 Grok 问候                                     | 平台自动唤起 grok，succeeded，输出“你好，我是 Grok。”，通过              | live-evidence.json / grok-result.png                     |
| T6 ZCode | 同一 Codex 发布者指定 ZCode 问候                                    | 身份/领取/唤起通过；执行 failed：Select a model before sending a message | live-evidence.json / zcode-error.png                     |
| T7a      | 项目服务 stop → status → start                                      | 停止成功、已停止状态、重新启动三个身份，通过                             | service-lifecycle.log                                    |
| T7b      | 浏览器打开平台，查看 Grok/ZCode 详情，重启后刷新                    | 在线三身份、发布者 Codex、目标/实际执行者与结果一致，通过                | platform-results.png / grok-result.png / zcode-error.png |

以下原 21 个服务回归用例逐一运行；R1 的工具列表预期按本次新增接口调整，其余 20 项沿用。完整执行记录为 final-check.log（本机归档）：

| 回归                  | 操作与应看到的结果                                          | 实际                 |
| --------------------- | ----------------------------------------------------------- | -------------------- |
| R1 发布到执行         | HTTP MCP 发布，经 SQLite/ACP 子进程和网页审批，串行得到结果 | 通过                 |
| R2 拒绝与非法审批     | 原始拒绝选项传回，错误会话/选项拒绝                         | 通过                 |
| R3 取消重试           | 取消使旧回调失效，重试产生新运行/审批                       | 通过                 |
| R4 持久化重启         | 重启后任务保留，旧运行中断、审批过期                        | 通过                 |
| R5 本机安全           | 错 Host/Origin/CSRF/未知字段及 MCP 审批访问被拒绝           | 通过                 |
| R6 执行进程异常       | 原进程退出，当前失败、下一任务继续                          | 通过                 |
| R7 错误会话审批       | 异会话权限请求被取消                                        | 通过                 |
| R8 崩溃恢复           | 排队任务恢复，旧会话保持中断                                | 通过                 |
| R9 审批截止           | 超时取消并阻止迟到决定                                      | 通过                 |
| R10 显式认证协商      | 测试适配器发现并接受所选认证方式                            | 通过（替身）         |
| R11 取消后关闭        | 重启保留 cancelled                                          | 通过                 |
| R12 发布前订阅        | SSE 得到持久可用事件，任务仍需领取                          | 通过                 |
| R13 离线发布后订阅    | 重启及晚订阅重放后经 ACP 执行                               | 通过（ACP 模型替身） |
| R14 断线重放          | 游标续传按序，游标 0 可重投                                 | 通过                 |
| R15 并发/重复领取报告 | 单个 run、所有权 fencing、seq 幂等/缺口拒绝                 | 通过                 |
| R16 两订阅者          | 重复事件下仅一个 run 执行                                   | 通过                 |
| R17 审批期间租约      | 心跳有效；取消停止后释放队列                                | 通过                 |
| R18 连接器进程死亡    | 所有权/审批失效，新订阅者继续后续任务                       | 通过                 |
| R19 SSE 非法来源/游标 | 拒绝浏览器 Origin/无效游标，转交 ACP 负载用官方 schema      | 通过                 |
| R20 错误工作区/模式   | 连接器在启动 ACP 前报告失败                                 | 通过                 |
| R21 顽固 ACP 子进程   | 取消强制清理，后续队列可继续                                | 通过                 |

既有网页回归也运行全量四项，见 ui-tests.log（本机归档）：

| 回归                       | 操作与应看到的结果                                           | 实际 |
| -------------------------- | ------------------------------------------------------------ | ---- |
| UI1 桌面发布/允许          | 表单 → 三字段列表 → 原始权限上下文 → 允许 → 结果，无页面错误 | 通过 |
| UI2 桌面拒绝/取消/重试     | 拒绝结果、取消后旧审批失效、新运行可再次审批                 | 通过 |
| UI3 手机暗色发布/允许      | 同 UI1，并检查手机宽度/暗色对比                              | 通过 |
| UI4 手机暗色拒绝/取消/重试 | 同 UI2                                                       | 通过 |

### AI 复查记录

项目根目录 `/Volumes/machub_app/proj/x-mingting`，复用 Node 25.6.1、npm 11.9.0；依赖由 npm ci --ignore-scripts 安装至 node_modules，缓存 .cache/npm，保持 package.json/package-lock.json 原样。现有 ChatGPT 登录用于 Codex，Grok 使用原账户；平台配置、数据库、日志均在项目内，CLI 自带账户/会话状态沿其已有目录管理。复用现有 Chrome 运行网页测试。

红灯 `routing-red.log` 为 3 个框架测试因缺身份/targetHarness/list_harnesses 失败；实现后绿灯通过。首次受限执行环境测试发生 Node 原生断言错误，后续所有 HTTP/SSE 测试在允许本机监听的执行环境通过。首次 Codex MCP 发布受 CLI never 审批策略阻挡，数据库核实尚无新增任务后，使用 CLI 自带自动审批成功执行，三个目标各发布一次。用户已授权这些问候。

命令与退出码：`npm run check` → 0（28 执行/28 通过/0 失败/0 跳过，含 tsc 与 Vite 构建）；`PLAYWRIGHT_CHROMIUM_EXECUTABLE=<现有Chrome> TASK_HARNESSES=Codex npm run test:ui` → 0（4/4）；技术验收专项 → 0（7/7）；独立 tsc → 0、输出为空。对应日志在 `reports/subscription-smoke`。本次未采集覆盖率，仓库已有命令没有覆盖率门槛。

实际真实联调早于最后的 stderr 首行截断、代理显式继承和网页标题整理；本机 TASK_DIRECT_NETWORK=1 使实际传输路径保持直连。身份/路由、命令、最终结果校验机制保持相同。最终代码独立专项、完整回归及构建通过，服务重新启动运行最终版本；模型成功证据只支持已实际完成的两个 harness。

### 公共验收回执

- x-verify-spec：依据本文①、功能正文 H1–H4、实现前 README 快照、③用例以及逐例执行记录进行九项对账。结构、来源、映射、变更索引和测试记录可核查；ZCode 成功执行的预期仍有实际失败，整体 **对账未完成**。具体回执见 verify-spec.md（本机归档）。
- x-verify-tech：独立运行 7 项专项及 tsc，审查 D1–D4/R1–R7；路由、数据归属、配置和清理项通过；ZCode 成功返回 JSON 的真实兼容性 **未验证**。整体 **未验证**，回执见 verify-tech.md（本机归档）。

### 结论与未决

本次完成 H1/H2/H4 与 H3 的 Codex/Grok 真实路径。逻辑新增用例 7 项，新增框架测试 7 个，修改既有测试 1 个、沿用 20 个，网页沿用 4 个。目标离线保持排队与错误身份拒绝在真实 HTTP/SSE、持久存储和领取路径上验证，执行模型使用替身；真实跨 harness 发布/执行另有三条任务证据。

ZCode 0.17.1 先有打包配置定位问题，已用本进程环境指向原应用文件；独立项目模型配置仍得到 `Select a model before sending a message`，当前账户可用模型状态待进一步恢复。平台已正确保留失败结果并继续处理 Grok。该问题涉及现有 ZCode CLI/账户可用性，保持个人配置与登录原样，作为明确未完成项交接。下一步恢复 ZCode CLI 的可用模型，再重跑同一条问候，核实最终 JSON 兼容性。

网页失败任务的空输出区域仍沿用既有“等待执行器返回内容”占位，错误与 failed 状态清楚可见；该文案作为后续小修记录。当前服务后台运行，按需通过项目脚本停止。全部变更保持本地可审查；本 task 整体尚未通过，未创建提交或远端发布。
