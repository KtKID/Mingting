# 各 Harness ACP 与网页实时执行过程

> 功能：[Harness 订阅](../HARNESS-SUBSCRIPTIONS.md)，H3执行、H5实时过程（新增）
> spec：无，沿用模块说明；设计：本文②；创建：2026-11-01；状态：已完成

## ① 需求与变更

用户要求先确认 Grok/ZCode 的可用 ACP，能够接入则采用各自 ACP；将正文流、reasoning 和工具状态实时接到网页；代码走 qdev，配置和依赖仅在项目内，全局环境保持原样。沿用前轮简单问候，工具验证仅限读取项目测试文本。

基线 HEAD `3f2a1f9`，当时 Codex ACP、Grok/ZCode 最终JSON，网页1.2秒轮询，reasoning只有原始事件。实现前runtime/web/package/功能正文快照在 `reports/acp-streaming/*before*`。调查发现 Grok 官方原生 `grok agent stdio`；ZCode本机无原生ACP命令，候选 `zcode-acp-server 0.80.1` 桥接真实app-server（上游ab548e79）。候选依赖在调查阶段以ignore-scripts安装于项目，用于握手验证。

## ② 精简技术设计

- D1/H3：通过官方ACP SDK验证 initialize/session/new/prompt/update。Codex沿用适配器；Grok用原生ACP；ZCode用项目内ACP桥接原生stream-json CLI（第三方候选的兼容失败与变更依据见④），命令/模型/工作目录由项目配置固定。复用标准ACP通知、权限回调、取消与进程组清理；按各agent公布模式选择明确的受限/人工审批模式，默认保持现有安全边界。记录实际能力及协议来源。
- D2/H5：以共享Zod定义网页执行过程数据；从ACP原始事件归并正文增量、agent_thought_chunk和tool_call/tool_call_update（同toolCallId合并）。旧任务仍可读取；原始事件留存。reasoning只显示agent实际发出的内容，空状态如实显示。
- D3/H5：同源cookie保护的网页SSE提供初始化快照与状态更新；连接后先挂监听再读SQLite当前快照，重连/刷新重建当前任务，不重复追加。通过运行身份和状态过滤旧运行通知，关闭与背压清理，容量与节流沿用具名限制。列表/在线身份/审批及当前详情同步推送，保留单一SQLite事实来源。
- D4/H5：网页分别展示回答、思考、工具执行状态，工具显示标题/状态及可安全呈现的输入输出摘要；保留原始审批和取消，结束/失败有准确状态，长输出可滚动。真实CLI数据不足的事件类型用官方SDK测试子进程验证，同时记录真实模型支持边界。
- D5/H4：依赖及缓存均在项目，ZCode桥接器关闭安装脚本/自动升级/远端hub/后台goal等待，XDG和agent状态使用项目目录。原全局CLI、登录与配置只读或保留哈希对照；测试模型只用已有授权。源参考：Grok官方headless-scripting文档；ZCode桥接器README及源码，均在报告中定位。

规范：R1 transport/ACP执行/过程归并/UI职责分开；R2共享Zod+官方ACP schema，禁止另一套wire协议；R3平台TS与既有CLI以官方ACP桥接；R4 SQLite任务/事件为事实源，过程随同一事务中的有效通知持续归并，裁剪后的持久化投影作为续算基线；R5同名字段/工具ID一致；R6容量/节流/超时具名；R7有序回传/取消/重连/旧run隔离继续生效。采用dev-ts与项目现有strict/Prettier检查。初版方案及本次调整保留于 `reports/acp-streaming/task.design-history.md`。计划文件：server 的 runtime/codex-adapter/http/service/store、新增 progress/zcode-stream/local-path；shared/protocol；web main/style；scripts zcode-acp/prepare-harness-local；对应 tests、.env.example 和模块文档。

## ③ 测试用例与变化

| ID  | 类型       | 范围  | 操作与预期                                                                               |
| --- | ---------- | ----- | ---------------------------------------------------------------------------------------- |
| A1  | 新增真实   | D1    | 三个agent ACP握手、模式及简单问候；记录agentInfo与真实通知                               |
| A2  | 新增自动   | D2    | 正文、思考分段、工具新增/更新合并、截断、未知/旧事件处理                                 |
| A3  | 新增自动   | D3    | 网页SSE在运行结束前收到增量；断线重连快照一致、权限/取消同步、非法来源拒绝               |
| A4  | 新增浏览器 | D4    | 确认未结束时正文/思考/工具状态出现，结束后保留最终结果；桌面/手机宽度可读                |
| A5  | 新增真实   | D1/D4 | 简单读取项目HELLO文本并问候，记录真实工具状态与reasoning支持情况                         |
| A6  | 新增检查   | D5    | 项目内依赖/状态，隔离前后选定全局文件哈希一致；历史差异如实记录                          |
| A7  | 新增自动   | D1    | 原生batch保留为汇总，缺字段及异常结果拒绝；tests/zcode-stream.test.ts                    |
| A8  | 新增自动   | D2    | 老数据默认值、部分工具更新、思考/工具/摘要截断边界；tests/zcode-stream.test.ts           |
| A9  | 新增自动   | D1    | Grok cached_token/headless无modes；Codex继续要求workspace-write；tests/acp-modes.test.ts |
| A10 | 新增自动   | D1    | UTF-8分片、早于退出的部分输出、坏JSON/退出码和取消；tests/zcode-bridge.test.ts           |
| A11 | 新增自动   | D5    | 项目外路径及活/悬空符号链接拒绝；tests/local-path.test.ts                                |
| Z5  | 修改自动   | D1/D5 | 原最终JSON测试改为ACP，验证项目HOME、思考/工具/正文；tests/zcode-runtime.test.ts         |
| R   | 沿用回归   | D1–D4 | 原33项及网页4项按影响回归，审批/恢复/身份定向保持                                        |

## ④ 技术实现

调查变更（实现前记录）：Grok 原生 ACP 已真实问候成功。ZCode 0.17.1 没有原生 ACP；第三方 zcode-acp-server 0.80.1 握手成功但当前 OAuth 账号在模型注册/运行请求授权阶段失败。改用项目内的最小 ACP 桥接层驱动原生 `--output-format stream-json`（已真实读 HELLO 并问候，含 reasoning_delta/tool.updated）。候选依赖移除，复用已有官方 ACP SDK；桥接层限定一次文本回合、plan 模式和读取测试，显式关闭 Bash/Edit/Write/Glob/Grep/WebSearch/WebFetch/Task，权限升级不开放。该来源在网页执行器字段与报告中明确标注。

D1 改为 Codex 官方适配器 / Grok 原生 ACP / ZCode 项目 ACP 桥接原生流式 CLI；ZCode 事件仅映射经 Zod 验证的 model.streaming/tool.updated/result，结果须 idle 且子进程成功退出，取消会中止子进程。D5 补充：探测发现仅设置 ZCODE_HOME/DATA_BASE_DIR 仍会读用户级 `~/.zcode/cli/config.json` hooks；将各 harness 子进程 HOME/配置根设为项目内，ZCode 用显式继承原密文解密材料保持 OAuth 可用。源全局配置只读，测试只验证配置/安装哈希，不宣称整个电脑所有日志未变化。

实际实现：`codex-adapter.ts` 复用官方 ACP 握手、认证、模式、通知、权限与清理；`runtime.ts` 分配三个入口和项目根；`scripts/zcode-acp.ts` 驱动一次原生流式回合，`zcode-stream.ts` 用 Zod 校验其已观测原生消息后映射到官方 ACP 类型。第三方候选依赖已经移除，package/lock 最终与 HEAD 相同。`local-path.ts` 保护项目配置路径；`prepare-harness-local.ts` 仅在缺少项目登录副本时只读复制现有登录。

`progress.ts` 维护有界投影，`service.ts` 在通知通过会话/租约/序号校验后与事件一并事务保存；`store.ts` 只在事务提交后发变更信号。旧数据增加 reasoning/tools 默认值。`http.ts` 对同源网页会话推送完整快照，40ms 合并变化，慢连接等 drain 并有超时清理；`main.tsx` 用单一 EventSource 更新状态，移除了轮询和审批后的额外手动详情读取，防止旧响应覆盖新快照。

## ⑤ 验证结果（本轮最终记录）

全量自动测试40/40通过，网页6/6通过，构建通过；真实三 harness 的 MCP 发布、身份领取、ACP 唤起、问候回传和网页 SSE 均通过。A1/A5复用同三个真实读文件问候，统计为3个真实任务。自动用例新增7、修改1（Z5）、沿用32、删除0；网页新增2、沿用4、删除0。没有配置覆盖率门槛，本轮未采集覆盖率。早期红灯及后续调查失败保留，当前执行0失败/0跳过。

| 用例     | 准备与操作                                                                   | 预期与本轮实际                                                                                                                         | 证据                                                 |
| -------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| A1/A5    | MCP列在线身份，然后分别定向发布“读项目HELLO并问候”；旁路订阅网页SSE          | 三个身份独立领取，三个任务succeeded，均有已完成读取工具；Codex/Grok/ZCode分别10/9/46帧，结束前均有正文与工具事件；Grok/ZCode还提供思考 | live-evidence.json、online.json、service-status.json |
| A2       | 经真实SQLite服务依次回传思考、工具三状态、正文、重复序号、取消和错会话       | 思考保留、同一工具一张卡、正文一次；重复/取消晚到/错会话隔离；通过                                                                     | tests/streaming.test.ts，check.log                   |
| A3       | 无cookie/恶意来源访问SSE；合法cookie打开；运行中回传半段文字；断线重新连接   | 前两类403，合法200；endedAt仍null时看到半段文字；重连快照恰好一次；无效任务ID400；大于128KiB的真实SSE帧排空后仍能收到后续更新；通过    | tests/streaming.test.ts，check.log                   |
| A4       | 桌面1440和手机390宽，假ACP输出回答/思考/工具后停在审批；网络切换；允许并刷新 | 结束前可见三类内容；结束后工具完成；刷新工具仍一张；网页0异常、无横向溢出；2/2通过                                                     | ui.log、ui-*.png                                     |
| A6       | 对照项目登录副本、隔离HOME和10个全局文件哈希                                 | 项目内根生效；隔离验证前后10项哈希一致。与上一轮相比setting.json早于本次基线已有变化，保留差异，不归因、不回写                         | global-before/after.json，compatibility.md           |
| A7       | 喂入真实形状batch、未知事件、缺字段、异常idle结果                            | batch不伪造工具；已知坏事件拒绝；通过                                                                                                  | zcode-batch-red.log、check.log                       |
| A8       | 老run数据、超长思考、101个工具、超长摘要、null patch                         | 默认值兼容；64000字符/100工具/8000字符限额有效，null不覆盖已有状态；通过                                                               | check.log                                            |
| A9       | 官方SDK子进程宣告cached_token且省略modes，分别用Grok/Codex策略               | headless认证通过；Grok按启动plan执行，Codex拒绝缺失workspace-write；通过                                                               | check.log                                            |
| A10      | 假原生CLI将中文JSON拆字节写出，延迟最终结果；再测坏JSON、退出7与挂起取消     | 部分文字早于退出至少100ms且UTF-8完整；异常拒绝；取消清理；通过                                                                         | check.log                                            |
| A11      | 项目外目录、指向外部的链接、悬空链接与普通项目目录                           | 前三类拒绝，实体项目目录允许；通过                                                                                                     | isolation-tests.log、check.log                       |
| Z5       | PATH前置测试CLI，经真实ACP桥接返回HOME/账户根并发思考/工具                   | HOME、账户根均在项目内，三类ACP事件齐全；通过                                                                                          | check.log                                            |
| 真实网页 | 用本机现有Chrome打开真实服务，逐一查看三个任务，再看390宽ZCode               | 正文、思考空态/实际内容、已完成工具与协议来源对应，0 pageerror，无横向溢出；通过                                                       | browser-live.json、live-*.png                        |

以上证据均位于 `reports/acp-streaming/`。真实 Codex 本次reasoning为0字符；Grok为34字符，ZCode为1580字符。网页按实际事件显示，模型未提供时显示空态。ZCode项目桥接保持一次文本回合、plan下只读问候测试的范围，复杂任务与权限升级留在后续专项范围。

### 全部沿用回归（32项）

每行均由实际测试代码准备隔离SQLite/官方SDK子进程或原生CLI替身，操作与观察见对应测试正文；本轮实际全部通过。共同执行日志 `reports/acp-streaming/check.log`，包含逐例名称和耗时。

| 回归                   | 准备→操作                                     | 应看到与实际结果                               |
| ---------------------- | --------------------------------------------- | ---------------------------------------------- |
| R01 CLI正确JSON        | 原生CLI替身输出有效最终JSON                   | 文本、会话与end_turn保持，通过                 |
| R02 CLI坏结果          | 分别输出坏JSON、非end_turn及退出7             | 均拒绝，通过                                   |
| R03 ZCode旧idle结果    | 输入0.17.1最终JSON形状                        | 会话及回答保留，通过                           |
| R04 CLI取消            | 启动后中止                                    | 原进程终止，结果不报成功，通过                 |
| R05 CLI顽固进程        | 忽略TERM后中止                                | 超时升级KILL并清理，通过                       |
| R06 MCP到审批结果      | HTTP MCP发布两任务，经ACP请求审批并允许       | SQLite与结果一致，串行执行，通过               |
| R07 拒绝选项           | 提交原始拒绝、伪选项和错会话                  | 拒绝原样传回，后两类失败，通过                 |
| R08 取消后重试         | 等审批、取消、显式重试                        | 旧回调失效，新run/审批独立，通过               |
| R09 正常重启           | 有运行/审批时关闭并重建                       | 持久任务中断，审批失效，通过                   |
| R10 本机访问防护       | 假Host、恶意Origin、无CSRF、额外字段、MCP审批 | 拒绝对应请求，通过                             |
| R11 子进程异常退出     | 第一任务进程退出，第二任务等候                | 第一失败，第二继续，通过                       |
| R12 错会话审批         | ACP返回另一session审批                        | 自动取消，网页不产生审批，通过                 |
| R13 崩溃恢复           | 保留崩溃SQLite与排队任务后重建服务            | 旧会话中断，排队继续，旧运行不自动恢复，通过   |
| R14 审批超时           | 推进审批截止时间                              | 运行取消，审批过期，迟到决定拒绝，通过         |
| R15 API-key认证        | SDK替身发现并选择认证方法                     | 发送已选方法，不触及真实凭据，通过             |
| R16 取消紧接关机       | 取消后立即关闭重启                            | cancelled保持，通过                            |
| R17 先订阅后发布       | 常驻SSE后用HTTP MCP发布                       | 收到耐久task.available，接收不直接标成功，通过 |
| R18 离线发布恢复       | 无连接时发布并重启，随后订阅                  | 回放任务并经ACP执行，通过                      |
| R19 游标重连           | 断线期间发布再携Last-Event-ID连接             | 顺序回放，游标0重新投递，通过                  |
| R20 领取竞争与报告序号 | 并发领取、重复领取、重复/缺号报告             | 唯一run、幂等/拒绝符合预期，通过               |
| R21 双订阅             | 两个连接器接同一可用事件                      | 一次执行，通过                                 |
| R22 审批保活与取消     | 审批等待期间保持心跳后取消                    | 领取有效，取消确认后下一项继续，通过           |
| R23 连接器死亡         | 杀掉真实测试连接器进程，再新订阅              | 租约和审批失效，下一任务继续，通过             |
| R24 订阅防护/ACP校验   | 浏览器来源、非法游标、坏ACP消息               | 对应拒绝，官方schema生效，通过                 |
| R25 工作区模式一致     | 连接器使用不同工作区或fake/real               | 停止执行，通过                                 |
| R26 顽固ACP清理        | 忽略TERM的ACP子进程后取消                     | 强制清理，后续队列继续，通过                   |
| R27 身份连接计数       | 同owner重复连接、冲突身份和逐个关闭           | 绑定一致、计数正确，通过                       |
| R28 指定目标离线       | 发布给离线目标，错owner领取，目标迟到         | 保持排队、错领拒绝、回放并记录目标身份，通过   |
| R29 MCP身份路由        | 查询在线并发布给目标，订阅跨过他人事件        | 名单正确、目标过滤且游标继续，通过             |
| R30 隔离OAuth初始化    | 从唯一加密OAuth绑定准备项目配置               | 仅复制授权账户密文，源哈希保持，通过           |
| R31 异常账户输入       | 缺失/多账户/缺密文登录                        | 写入前失败，通过                               |
| R32 初始化路径边界     | 外部路径与符号链接目标                        | 拒绝，通过                                     |

网页沿用4项：桌面和手机分别发布任务、查看原始审批并允许；分别拒绝、取消及显式重试。实际均通过，详见 ui.log 与 tests/ui.spec.ts。

### 执行附件与边界

- cwd为本项目；Node25.6.1/npm11.9，HEAD `3f2a1f9` 加本轮工作区差异；最终源文件哈希见 source-baseline.json。设计初稿及变更在 task.design-history.md 与本文④，可读功能旧正文在 feature.before.md。
- 有效红灯：red.txt的A2思考丢失、A3合法SSE返回404；zcode-batch-red.log的原生batch被错误要求toolCallId。初期受限制环境的监听失败与临时目录真实路径别名导致的桥接测试失败均先排除，未冒充功能红灯。
- 开发验证：`npm run check` exit0，40执行/40通过/0失败/0跳过（check.log）；随后加强A3大帧背压断言，8项验收专项重新通过（verify-tech-tests.log）；源码最后变更仅移除前端冗余刷新，重新`npm run build` exit0（build.log），网页6/6重新通过（ui.log）。
- 格式检查通过（format-check.log）；`git diff --check` exit0、输出为空。项目没有现成ESLint命令，本轮沿用strict tsc和Prettier，没有宣称执行ESLint。
- 真实任务证据来自HTTP MCP Client发布、服务和真实CLI；自动测试使用官方ACP SDK子进程、原生CLI替身、真实SQLite/HTTP。CUA浏览器入口不可用，实际页面验证使用项目已有Playwright与现有Chrome，结果按此来源记录。
- 安装调查用依赖时使用项目npm缓存和ignore-scripts，候选移除后package/lock与HEAD相同。配置、登录副本、数据库和缓存均在忽略的var/.cache/.env，继续复用现有Node/CLI可执行文件。
- 早期原生流探测读到了用户级hooks；该发现触发HOME隔离修正，原生逐行诊断留在忽略目录。全局文件哈希只证明选定文件在隔离验证前后稳定；全局ZCode setting.json相对上一轮哈希不同，mtime为2026-11-01T03:03:52.707Z，来源未判定，保留现场。没有写回/恢复任何全局文件。

### 公共验收回执

- x-verify-spec：qdev对账通过。已核对五段唯一结构、用户本轮范围、H3/H4修改和H5新增、旧正文与设计调整、A1–A11/Z5/R回指、全部开发/网页/真实证据、文件范围和结论。读取red.txt、zcode-batch-red.log、check.log、build.log、ui.log、verify-tech-tests.log、global前后摘要、live-evidence.json与browser-live.json。新增7/修改1/回归32、网页新增2/回归4与执行40/6一致；A1/A5复用3真实任务；没有遗漏、悬空或未决交付项。本阶段复查已有记录，未重跑测试，结论仅为记录对账。
- x-verify-tech：通过，适用D1–D5与R1/R2/R4–R7共11项，R3跨语言生成按纯TS范围不适用。独立运行8/8专项、strict tsc、格式检查；复查最后前端变更后的6/6网页、真实3任务与代码链路。完整证据与审查边界见技术回执（本机归档）。
- 功能正文H3–H5、changelog与本task双向关联、状态一致。当前交付范围为真实问候/只读工具和网页实时展示；性能压力、复杂任务、ZCode权限升级继续按范围边界保留。历史setting文件差异已如实披露，当前隔离前后哈希一致。

qdev完成：本轮功能、变更与用例对应，开发验证及回归通过，交付对账通过，技术验收通过。
