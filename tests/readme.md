# 明庭测试模块

> 草稿，待用户检查。

## 功能描述

改了任务发布、审批、执行器接入或结果展示后，在项目根目录运行一次 `npm test`，就能检查从发布到审批、流式输出、落库和网页展示的主要流程。普通回归用本地测试数据模拟模型和工具，浏览器里的输入、点击与检查由 Playwright 自动完成。

| 层次 | 实际检查 | 使用的测试数据 |
| --- | --- | --- |
| 后端与接口 | 用真实的明庭服务、连接器和 SQLite 检查定向领取、审批回传、结果落库、重试与审计。纯规则也可直接在测试中调用 | 合成事件，以及从四家执行器真实验收中整理出的五条 ACP 记录 |
| 桌面与手机网页 | 自动填写发布表单、选择模型档位、看审批弹窗、点击同意或拒绝、检查结果并模拟断线 | 本地假 ACP 进程按场景回报，手机用例在浏览器里模拟手机尺寸和触控 |
| 审批专项网页 | 用十条场景检查发起方与用户的决定、十秒回退、刷新与取消，并逐步保存证据 | 仓库自带合成审批夹具。持有本地原始录制时可显式切换 |

ACP 是明庭与执行器交换会话、工具请求和回报的协议。离线回放能检查明庭怎样处理这些消息。上游登录、原生执行器的实时行为和实际模型用量，由单独的真实验收确认。 [离线回放任务](../docs/task/task-acp-offline-replay.md) · [真实验收要求](../docs/spec/codex-task-settings-and-audit/tech-design.md#live)

## 设计理念

**让默认入口自己选测试。** 后端、构建、通用网页和审批专项按顺序执行。两套浏览器测试共用测试端口，所以串行启动，各自使用独立数据库和工作区。通用网页阶段失败后，审批专项仍可给出独立结果，整个批次按失败处理。 [自动回归设计](../docs/task/task-automatic-regression.md)

**让明庭走真实路径，让输入可以重放。** 测试进程用实际 ACP 协议发消息，明庭照常校验、裁决和保存。固定场景方便模拟错会话、重复报告和中途退出。来自真实验收的记录用来核对各家的原始用量字段和审批选项，其中缺少的原始协议帧按保存的正文和审计记录重建。 [多执行器设计](../docs/task/task-multi-harness-acp.md) · [离线夹具来源](../docs/task/task-acp-offline-replay.md)

**让失败可以查回去。** 每次默认回归生成独立批次，保存输入、日志、网页结果、截图和审批步骤。网页阶段的结果单独保存，旧批次的阶段清单继续可读。 [批次留存约定](../docs/APPROVALS.md#a5-默认自动回归与批次留存)

## 使用方式

在仓库根目录准备 Node.js 24 或更新版本。首次安装依赖和测试浏览器后，日常只需执行最后一条命令。也可以用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指向现有 Chromium 可执行文件。 [命令定义](../package.json) · [浏览器配置](../playwright.config.ts)

```bash
npm ci --ignore-scripts
npm exec -- playwright install chromium
npm test
```

- **默认全跑**。 `npm test` 与 `npm run check` 走同一入口。浏览器阶段启动本机 `127.0.0.1:60391` 的测试服务，需要该端口空闲。构建成功后依次跑通用网页和审批专项。
- **定位问题**。 `npm run test:unit` 运行全部 `tests/*.test.ts`。 `node --import tsx --test tests/acp-offline-replay.test.ts` 只回放五条真实验收记录。 `npm run test:ui` 在已有网页构建产物时单跑桌面与手机。 `npm run test:approval-e2e` 自动构建并运行十条审批专项。
- **查看结果**。终端打印批次路径。到 `reports/approval-e2e/runs/<批次 ID>/` 看 `manifest.json` 和 `unit.log`、`build.log`、`ui.log`、`approval.log`。 `ui-playwright.json` 和 `ui-browser/` 保存通用网页结果与附件，`cases/` 保存审批专项的逐例结果和截图。使用当前版本的明庭时，也可从任务台进入“审批回放与测试记录”查看历史。 [最近一次本地测试报告](../reports/automatic-regression/20261106/test-report.md)
- **GitHub 自动运行**。工作流配置在 PR 和 `main` 更新时执行同一个 `npm test`，测试产物保留 14 天。本轮依据本地执行和工作流检查，云端执行待推送触发。 [工作流](../.github/workflows/tests.yml)

**新增用例**。后端文件按 `tests/*.test.ts` 自动发现。新增网页场景时，通用操作放进 `ui.spec.ts`，订阅者与用户的裁决组合维护在审批场景表。新增 ACP 录制时，在夹具里分别保留原始回报和预期结果，回放测试会按录制 ID 生成用例。 [后端入口](../package.json) · [审批场景表](../src/shared/approval-replay.ts) · [录制回放入口](acp-offline-replay.test.ts#L35)

本地默认回归已记录 **115 项后端、20 项桌面与手机网页、10 项审批回放**通过，构建退出码为 0。批次文件由测试生成。 [批次清单](../reports/approval-e2e/runs/aff04bc9-2cca-4393-adc8-3bd87da00322/manifest.json)

## 代码说明

覆盖 `tests/` 的全部测试和夹具，以及默认回归直接使用的根目录配置与 `scripts/` 入口。每条用例入口是文件内的 `test(...)`。表中的代码链接指向有独立职责的辅助函数、回放处理或代表性断言。

### 默认入口与归档

| 文件 | 怎样工作及取舍 |
| --- | --- |
| [run-regression.ts](../scripts/run-regression.ts) | [`runRegression(approvalOnly)`](../scripts/run-regression.ts#L102) 建批次、冻结输入，再启动后端、构建、网页和审批专项。专项模式只跑构建和审批。[`runStage`](../scripts/run-regression.ts#L24) 收到阶段名称、命令、环境和取消信号，把输出写入批次，记录子进程退出码。中断时停止子进程。统一入口可以保留失败阶段，而后续专项仍能给出自己的结果。 |
| [approval-archive.ts](../scripts/approval-archive.ts) | [`createApprovalArchive`](../scripts/approval-archive.ts#L83) 按批次 ID 创建清单和十条待执行记录。[`freezeApprovalInputs`](../scripts/approval-archive.ts#L145) 复制录制、核对来源哈希并写入代码基线。[`refreshApprovalCases`](../scripts/approval-archive.ts#L194) 读逐例文件更新通过、失败和未执行数量。[`finishApprovalArchive`](../scripts/approval-archive.ts#L218) 按阶段退出码和审批结果收口。[`atomicJson`](../scripts/approval-archive.ts#L15) 先写临时文件再替换，[`preserveManualReport`](../scripts/approval-archive.ts#L25) 为旧手工回放补历史入口。[`saveApprovalArchive`](../scripts/approval-archive.ts#L135) 校验并写出报告与清单。每批多保存一份输入，换取事后可查。 |
| [playwright.config.ts](../playwright.config.ts) | [`fakePlatform(database)`](../playwright.config.ts#L8) 以指定数据库启动本机假 ACP 平台，使用独立工作区与明确的测试环境。默认定义桌面和手机两种页面、单个测试工作进程。两组用例依序操作同一个测试服务，完整运行时间包含两组用例的等待。 |
| [playwright.approval.config.ts](../playwright.approval.config.ts) | 读取批次目录和审批库路径，复用 `fakePlatform`，只发现审批专项文件。单独保存浏览器跟踪与 JSON 结果，逐例证据可在报告页还原。 |
| [approval-replay-data.ts](../scripts/approval-replay-data.ts) | [`readRecordingInput` 与 `loadRecording`](../scripts/approval-replay-data.ts#L29) 默认读仓库审批夹具，可由 `APPROVAL_RECORDING_PATH` 指向本地录制。读取后校验结构，让浏览器测试与回放进程共用输入。 |
| [approval-replay-acp.ts](../scripts/approval-replay-acp.ts) | `session/prompt` 发送待审前的消息，向平台请求审批，再按实际选择发送允许或拒绝的录制结果。会话 ID 与工具调用 ID 在每次回放重新生成。模型和工具结果固定，审批往返由明庭实时完成。 |

### 浏览器用例

| 文件 | 怎样工作及取舍 |
| --- | --- |
| [ui.spec.ts](ui.spec.ts) | 通过真实页面操作模型档位、任务详情、审批弹窗、用量、审计、刷新和重连。[`publishApprovalTask(page, title)`](ui.spec.ts#L230) 先等网页连接，再用同一浏览器会话发测试任务并返回审批资料，让后续用例集中检查弹窗和裁决。[`test.afterEach`](ui.spec.ts#L7) 取消残留活动任务，避免后续用例被占用的队列影响。 |
| [approval-replay-ui.spec.ts](approval-replay-ui.spec.ts) | [按 `scenarios` 注册用例](approval-replay-ui.spec.ts#L25)，从 MCP 发布测试任务，运行真实审批流程并用浏览器完成用户操作。[`save`、`check`、`capture`](approval-replay-ui.spec.ts#L44) 分别写入用例状态、核对预期值和保存截图。十秒回退使用实际等待，代价是浏览器回归时间较长。 |

### 后端用例

| 文件 | 怎样工作及取舍 |
| --- | --- |
| [platform.test.ts](platform.test.ts) | [`fixture(authMethod, fakeEnv)`](platform.test.ts#L182) 建临时库、本机 HTTP 服务和假 ACP 连接器，提供请求、停机和清理入口。[`until(read, predicate)`](platform.test.ts#L252) 持续读取到符合条件或超时。用完整进程检查发布、领取、审批、重试、恢复、取消及 Codex 设置与用量，比直接调函数更接近真实链路。 |
| [routing.test.ts](routing.test.ts) | [`fixture` 与 `connect`](routing.test.ts#L18) 用不同名称、所有者和连接代次登记本地订阅，验证离线排队、定向通知与错身份拦截。直接控制连接，便于制造重复订阅和代次变化。 |
| [approvals.test.ts](approvals.test.ts) | [`fixture`](approvals.test.ts#L40) 准备运行、审批请求和选项；`deadline` 辅助核对审批窗口。覆盖订阅者与用户决定、十秒回退、超时、取消、权限和等待资源释放。规则用例可直接控制时间，真实倒计时另由网页专项核对。 |
| [streaming.test.ts](streaming.test.ts) | [A2 与 A3](streaming.test.ts#L11) 逐条提交思考、正文和工具变化，再从运行记录或网页事件流核对更新、断线补回和错会话拦截。逐条控制回报顺序，可以核对重复事件和审计写入失败。 |
| [approval-replay.test.ts](approval-replay.test.ts) | [`adapter()`](approval-replay.test.ts#L32) 创建指向录制子进程的 ACP 适配器。用例检查默认夹具可独立读取、允许与拒绝回传，以及回放连接器只领取指定任务。这里专注审批协议和领取，网页行为在专项中检查。 |
| [approval-archive.test.ts](approval-archive.test.ts) | [RA1–RA5](approval-archive.test.ts#L23) 创建临时归档并检查旧结果、中断、缺文件和子进程失败。另用三种网页阶段结果核对默认批次结论。直接构造归档状态，能稳定覆盖失败和历史兼容。 |
| [acp-offline-replay.test.ts](acp-offline-replay.test.ts) | [`waitFor(read, label)`](acp-offline-replay.test.ts#L25) 等待模型发现、审批和结束状态。每条录制走任务 API、真实连接器、厂商用量映射和临时库，然后把结果与录制期预期值对照。专门验证设置生效、结果流和同一运行下的审计。 |
| [multi-harness-acp.test.ts](multi-harness-acp.test.ts) | [三家参数化用例](multi-harness-acp.test.ts#L16) 直接向平台提交设置、工具、审批和上下文；后续用例单独核对 Grok 费用、ZCode 上游会话和 DeepSeek 步骤去重。输入可控，便于检查缺报、错会话和数据不一致。 |
| [acp-modes.test.ts](acp-modes.test.ts) | [A9](acp-modes.test.ts#L5) 用假 Grok 返回缺少会话模式的响应，核对启动计划模式和缓存登录方式的处理，同时验证 Codex 的工作区模式要求。对同一通信层发不同响应，能检查两家规则各自适用。 |
| [cli-adapter.test.ts](cli-adapter.test.ts) | [`adapter(code, harnessName)`](cli-adapter.test.ts#L12) 用指定代码替代 CLI 子进程，检查最终 JSON、无效输出、异常退出和强制终止。保留原生 CLI 路径的兼容证据。 |
| [local-path.test.ts](local-path.test.ts) | [A11](local-path.test.ts#L8) 在临时目录造出项目外路径、有效和悬空链接，调用项目路径检查确认拒绝。使用真实文件系统验证边界。 |
| [task-wakeups.test.ts](task-wakeups.test.ts) | [`fixture(fail)`](task-wakeups.test.ts#L25) 模拟可接收事件的聊天宿主，生成审批或完成事件并支持重开同一测试库。覆盖事件去重、失败、恢复、ACP 原会话加载与 MCP 取证。真实聊天可用性由独立验收确认。 |
| [zcode-account.test.ts](zcode-account.test.ts) | [`encrypt` 和 `fixture(origin)`](zcode-account.test.ts#L12) 构造隔离账户与模拟短期令牌响应，检查可信地址、账号变化、过期、无效数据和脱敏。通过替代网络响应检查账号规则，凭据用测试值。 |
| [zcode-approval.test.ts](zcode-approval.test.ts) | [`fixture()`](zcode-approval.test.ts#L21) 启动原生协议夹具和实际 ZCode ACP 桥。用临时标记文件检查仅允许时发生模拟操作，另验重复申请、错会话、取消和选项语义。 |
| [zcode-bridge.test.ts](zcode-bridge.test.ts) | [A10](zcode-bridge.test.ts#L8) 让原生夹具拆分中文字符并提前回报正文，检查桥接流能正确拼接，以及坏数据、退出和取消的处理。 |
| [zcode-local-config.test.ts](zcode-local-config.test.ts) | [`fixture()`](zcode-local-config.test.ts#L17) 生成测试凭据和模型配置，核对本地准备脚本只复制选定账户及其缓存，并拒绝歧义和越界输出。比较源文件与生成文件验证隔离。 |
| [zcode-runtime.test.ts](zcode-runtime.test.ts) | [Z5](zcode-runtime.test.ts#L8) 以项目测试账户启动子进程，从返回结果核对 `HOME` 和 ZCode 数据目录，同时看思考、工具和正文是否到达。使用原生夹具使目录和流的检查可重复。 |
| [zcode-stream.test.ts](zcode-stream.test.ts) | [N6、A7、A8](zcode-stream.test.ts#L7) 直接传入原生事件，核对拒绝后的工具状态、批量工具事件、畸形字段、老数据和长输出截断。逐项断言单个事件的转换。 |

### 测试进程与数据

| 文件 | 怎样工作及取舍 |
| --- | --- |
| [fake-acp.ts](fake-acp.ts) | [`options()`](fake-acp.ts#L17) 返回 A/B 模型和各自支持的档位；[`session/prompt`](fake-acp.ts#L87) 按提示中的场景标记发送输出、工具、审批或用量，也可提前退出、拒绝终止。用真实协议连接明庭，便于构造上游难以稳定复现的故障。 |
| [fake-wakeup-host.ts](fake-wakeup-host.ts) | ACP 的 `session/load` 记录原聊天会话，`session/prompt` 只接收同一会话并回报固定正文。可用 `FIXTURE_WRITER_BUSY=1` 模拟原聊天写入冲突。 |
| [zcode-fixture.ts](zcode-fixture.ts) | `fakeZcodeNative` 是写入临时可执行文件的脚本内容。[`event`、`permission`、`finish`](zcode-fixture.ts#L7) 产生原生事件、审批及回合终态，用于验证 ACP 桥的另一端。允许时会在临时工作区写出标记，便于检查实际收到的决定。 |
| [acp-run-recording.ts](fixtures/acp-run-recording.ts) | [`acpRunRecordings`](fixtures/acp-run-recording.ts#L59) 读五条录制、校验字段并用 ACP 校验器检查通知和审批结构。坏夹具在开始回放前会报错。 |
| [acp-run-replay.ts](fixtures/acp-run-replay.ts) | 按录制 ID 启动。[`options()`](fixtures/acp-run-replay.ts#L27) 提供录制模型和档位，`session/prompt` 等设置完成再逐条发送事件，并核对返回的审批选项。DeepSeek 会先把录制步骤写到临时日志，供实际适配器读用量。 |
| [acp-run-recordings.json](fixtures/acp-run-recordings.json) | Codex、Grok、ZCode 和 DeepSeek low/high 的五条脱敏录制。保留来源哈希、原始计量、可重放事件和核对预期，运行时只读仓库里的这份输入。 |
| [zcode-approval-recording.json](fixtures/zcode-approval-recording.json) | 默认十条审批场景共用的合成请求与三段事件，分别是等待审批、允许后和拒绝后。用例矩阵定义在共享场景表中。 [场景表](../src/shared/approval-replay.ts) |

另有几个独立入口用于专项取证。[`scripts/verify-codex-task-usage.ts`](../scripts/verify-codex-task-usage.ts) 读取已保存的真实证据，独立比对用量、上下文和回执顺序。[`npm run test:acp-session`](../scripts/verify-acp-session.mjs) 使用真实 Codex ACP 和本地模型替身检查原会话写入权交接。[`scripts/record-approval-fixture.ts`](../scripts/record-approval-fixture.ts)、[`scripts/approval-e2e.ts`](../scripts/approval-e2e.ts) 与 [`scripts/validate-approval-replay.ts`](../scripts/validate-approval-replay.ts) 支持有源记录时的提取、历史可见回放与报告检查，默认回归入口见上文。

## Spec 索引

### 已核对的 spec

| Spec | 定义与测试对应 | 依据 |
| --- | --- | --- |
| [Codex 模型和思考档位](../docs/spec/codex-task-settings-and-audit/spec.md#feat01-设置-codex-任务的模型和思考档位) | 发布时选择设置，实际回读成功再执行。对应 `platform.test.ts` 的设置顺序与失败用例、`ui.spec.ts` 的模型和档位选择。 | [设计 T2/T3](../docs/spec/codex-task-settings-and-audit/tech-design.md#t02) · [设置任务](../docs/spec/codex-task-settings-and-audit/tasks/task-codex-settings/dev-checklist.md) |
| [运行过程和工具审批](../docs/spec/codex-task-settings-and-audit/spec.md#feat02-查看运行过程和工具审批审计) | 检查实时正文与工具、原审批选项、同次运行归属和重试后旧审计。对应 `streaming.test.ts`、`approvals.test.ts`、`platform.test.ts` 和网页审计。 | [设计 T4/T5](../docs/spec/codex-task-settings-and-audit/tech-design.md#t04) · [审计任务](../docs/spec/codex-task-settings-and-audit/tasks/task-run-tool-approval-audit/dev-checklist.md) |
| [任务消耗与上下文](../docs/spec/codex-task-settings-and-audit/spec.md#feat03-查看并对账任务消耗与上下文) | 检查原始用量、会话占用、模型窗口、缺项与重试汇总。对应 `platform.test.ts`、`streaming.test.ts` 和网页用量视图。真实验收还需独立对账。 | [设计 T6–T10](../docs/spec/codex-task-settings-and-audit/tech-design.md#t06) · [计量任务](../docs/spec/codex-task-settings-and-audit/tasks/task-run-metering/dev-checklist.md) · [真实验收任务](../docs/spec/codex-task-settings-and-audit/tasks/task-codex-live-reconciliation/dev-checklist.md) |

### 其他已核对的功能定义

| 功能文档 | 与本模块的关系 |
| --- | --- |
| [审批 A1–A5](../docs/APPROVALS.md) | 定义用户与订阅者的裁决、十秒窗口、十条回放及批次保留。对应审批、归档和浏览器专项。 [默认回归任务](../docs/task/task-automatic-regression.md) |
| [执行器订阅与运行审计](../docs/HARNESS-SUBSCRIPTIONS.md) | 定义定向领取、实时过程、各家用量和离线夹具。对应路由、流、适配器与五条录制回归。 [多执行器任务](../docs/task/task-multi-harness-acp.md) · [离线回放任务](../docs/task/task-acp-offline-replay.md) |
| [网页重连](../docs/task/task-web-reconnect.md) | 页面自动恢复连接并保留已有过程，对应 `ui.spec.ts` 的断线与短时初始化失败用例。 |
| [当前聊天唤醒 W1–W3](../docs/CHAT-WAKEUPS.md) | 定义审批与任务完成怎样投递到原聊天，以及失败和回放的边界。对应 `task-wakeups.test.ts` 和假聊天宿主。 [唤醒任务](../docs/task/task-chat-wakeups.md) |

在 `docs/spec/` 中查到 Codex 设置、审计和计量的正式规格。默认回归编排、离线夹具和专项网页用例的功能来源目前由上表的模块说明与任务记录承载。
