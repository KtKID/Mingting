# ZCode 模型选择与问候回传

> 归属：Harness 连接器 H3；功能：[Harness 订阅](../HARNESS-SUBSCRIPTIONS.md#h3-执行)
> spec：无，沿用模块功能文档；设计：本文②；创建：2026-11-01；状态：已完成

## ① 需求与变更

用户要求继续跑通 ZCode 身份订阅、唤起和一句问候回传；代码继续走 qdev；配置、依赖及临时文件保持项目内，全局环境保持原样。用户截图确认桌面端有 GLM-5.3、GLM-5.3-Flash，本次采用 GLM-5.3。

前轮路由、领取、CLI 启动成功，执行报 `Select a model before sending a message`。基线：HEAD 8ab0dcc 加已有工作区；变更前功能、runtime 和 CLI adapter 快照在 `reports/zcode-model-selection/*before*`。本轮范围仅 H3/ZCode 成功完成及运行隔离，前轮其他变更保留。功能变更索引在模块文档本轮条目。

## ② 精简技术设计

- D1：先定位 CLI 实际加载的模型注册表、provider 与模型选择。只读取本机现有安装；项目内诊断副本输出 provider/model/reasoning 等非敏感信息，凭据读取封装为只读，任何刷新写入由诊断拒绝。诊断已确认：configuredDefault 含 GLM-5.3，registry.providers 为空；现有 bigmodel OAuth 存在、CLI 所需 identity/auth-source 绑定缺失。现有个人 Coding Plan 凭据可精确按 providerId 唯一定位。
- D2：平台仍经现有 SSE 订阅/原子领取/CLI 执行/顺序回传。沿用 shared Zod、现有 CLI 单参数启动与退出/取消处理；修复边界限定 runtime/CLI 输出解析及必要的项目内配置。
- D3a：新增显式项目初始化脚本，读取明确指定的现有凭据文件，只为所选 provider 提取唯一账户标识与现有 OAuth 登录凭据，保持登录凭据密文，写入项目私有目录并补 identity/auth-source=oauth。来源只读、目标权限0600、目录0700，输出仅显示路径/模型；配置和运行凭据位于忽略的 var 内，设置 ZCODE_DATA_BASE_DIR 指向该隔离账户根。缺少/多条匹配时停止并明确报错，其他账户记录保留原位。原手动 key 在真实模型调用中返回401；隔离绑定使用现有 OAuth，原生 CLI 正常取得项目令牌，真实 GLM-5.3 问候成功（返回 idle、原 sessionId、原文本）。复制的只是用户已授权复用的现有登录密文，平台不会读取源凭据；显式初始化脚本负责这一动作。
- D3：平台与 ZCode 运行配置/数据库/日志/cache 指向项目目录；现有登录只读复用；项目侧新增配置明确区分模型选择、模型定义与账户身份。全局安装、全局配置、代理和原始 CLI 文件保持原样。
- 规范：R1 保持 runtime/执行器/传输职责；R2 CLI 边界 Zod 校验并推导类型；R3 外部 CLI 输出依实际协议核对；R4 任务结果 SQLite 单一存储，模型定义与选择保持明确来源；R5 沿用 harnessName/targetHarness；R6 沿用 LIMITS；R7 失败保留状态，收到有效最终结果后报告成功。沿用 dev-ts、strict tsc、Prettier 与现有测试。

## ③ 测试用例与变化

| 用例 | 变化          | 依据   | 操作与预期                                                              |
| ---- | ------------- | ------ | ----------------------------------------------------------------------- |
| Z1   | 新增诊断      | D1/H3  | 读取 CLI 注册表，确认 GLM-5.3 可选择及其 provider/reasoning，输出无凭据 |
| Z2   | 修改/新增自动 | D2/H3  | 有效 ZCode 最终 JSON 得到原始会话/文本；错误/缺结果保持失败             |
| Z3   | 新增真实      | D2/H3  | MCP 发布指定 ZCode 的一句问候；实际订阅、领取、唤起与回传 succeeded     |
| Z4a  | 新增自动      | D3a/H4 | 唯一凭据绑定成功且保留原密文；缺失/多账户拒绝；源文件原样；目标0600     |
| Z4   | 新增隔离检查  | D3/H4  | 本项目配置生效，选定全局配置/安装前后哈希一致，测试数据位于项目         |
| R    | 沿用回归      | D2     | 前轮28项自动测试及构建；按实际代码影响复用网页检查                      |

诊断和测试的实际代码、红灯、计数与真假执行边界在⑤记录。

| Z5 | 新增自动 | D3/H4 | 原生子进程收到项目内 ZCODE_DATA_BASE_DIR / ZCODE_HOME，HOME保持原值 |

## ④ 技术实现

- `scripts/prepare-zcode-local.ts`：显式初始化脚本，Zod 校验输入及源账户记录；按 provider 精确匹配唯一账户，复用对应 OAuth 密文，写入项目隔离身份绑定和本地模型/内置配置；拒绝越界与符号链接路径，原始账户文件只读，输出文件0600、目录0700。
- `src/server/runtime.ts`：本轮只补 `ZCODE_DATA_BASE_DIR`、`ZCODE_HOME` 两项原生环境转发。前轮身份、路由、领取、回传实现保持原样。
- `tests/zcode-local-config.test.ts` 新增3项，`tests/zcode-runtime.test.ts` 新增1项，`tests/cli-adapter.test.ts` 新增1项 ZCode 真实结果形状回归。
- 项目忽略目录 `.env`、`var/zcode-local`、`var/zcode-provider.json`、测试工作区配置已更新；源码中的 `.env.example`、README 中英文、PROGRESS、功能正文和前轮历史记录入口同步。
- 原诊断尝试使用旧手动 key 得到401；实际方案使用现有 OAuth 登录密文，并由 CLI 原生流程获取有效项目令牌。该依据在产品代码修改前写入②。正式初始化脚本自动完成已手工验证的配置步骤，保留同样源/目标权限和绑定语义。

文件内容基线见 [source-baseline.json](../../reports/zcode-model-selection/source-baseline.json)，实现前快照在相同目录的 `*before*`。本轮没有新增依赖或修改依赖清单/lock。

## ⑤ 验证结果

### 用户阅读：结果与全部专项

ZCode 使用 GLM-5.3 完成真实问候回传。本轮新增5个自动测试，加原有28个，共 **33/33通过**，构建通过；独立技术验收专项 **9/9通过**，独立 tsc 通过。浏览器显示发布者 Codex、执行者/目标 ZCode、状态已完成，结果“你好，我是 ZCode。”。读取的原安装与全局登录/配置6个文件前后哈希一致。

| 用例                 | 准备与操作                                                                                       | 应看到与实际结果                                                                     | 证据                                          |
| -------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------- |
| Z1 注册表            | 用项目内诊断副本、只读源凭据读取 CLI 注册表，再加入项目绑定                                      | 原 providers=[]；项目绑定后恢复 GLM-5.3、GLM-5.3-Flash，reasoning=low/high/max；通过 | registry-diagnostic.json、registry-bound.json |
| Z2 最终结果          | Node真实子进程输出 ZCode idle JSON，另输出running JSON                                           | idle保留sessionId和中文文本，running拒绝；通过                                       | check.log、verify-tech-tests.log              |
| Z3 跨 harness 真链路 | 另一个真实 Codex CLI 经MCP查询在线身份，唯一一次publish指定ZCode                                 | 任务自动订阅/领取/启动zcode，succeeded，end_turn，原文本回传；通过                   | live-evidence.json、zcode-success.png         |
| Z4a 隔离初始化       | 临时源含现有加密登录和无关字段，初始化并重跑                                                     | 只选定账户OAuth密文及绑定写入；源原样；文件0600、目录0700；通过                      | check.log                                     |
| Z4a 非法来源         | 缺失账户、缺失OAuth、多个账户                                                                    | 全部拒绝，输出账户目录保持未创建；通过                                               | check.log                                     |
| Z4a 输出范围         | 项目外路径、符号链接目录                                                                         | 全部拒绝，源原样；通过                                                               | check.log                                     |
| Z4 全局与私有状态    | 调用前后校验CLI、内置配置、credentials/provider_config/config/setting，共6文件；检查实际落盘权限 | 6文件哈希一致；运行账户在var/zcode-local；凭据0600、目录0700；通过                   | global-before.json、global-after.json         |
| Z5 环境传递          | 测试bin中的zcode子进程输出收到的目录和HOME                                                       | 修改前只收到原HOME（有效红灯）；修改后收到项目账户根/ZCODE_HOME且HOME原样；通过      | runtime-red.log、check.log                    |
| 浏览器               | 刷新平台会话 → 查看“ZCode GLM-5.3 问候回归”详情                                                  | 显示Codex发布、ZCode执行、已完成、1次执行/end_turn和原问候；通过                     | zcode-success.png                             |

用例变化：新增逻辑用例Z1–Z5（Z4含Z4a）；框架新增5个（初始化3、环境1、结果1），保留原有28个，修改/删除既有断言0。初始化自动化用例采用已手工验证的配置行为作为基线；环境转发先取得有效红灯。33个框架测试与逻辑/人工用例分别计数。

### 既有功能回归（本轮实际执行）

原有28个自动测试完整重跑，逐例清单与前提/预期沿用 [前轮记录⑤](task-harness-subscriptions.md#⑤-验证结果) 的 R1–R21、T1–T5；本轮结果以 [check.log](../../reports/zcode-model-selection/check.log) 为准，28项全部通过：MCP发布/工具发现，人工允许/拒绝/取消/重试，持久化/崩溃恢复，HTTP/SSE安全，原子领取/seq/fencing，离线重放和游标分页，多订阅者互斥，工作区/模式检查，ACP及原生CLI进程退出/强制清理，原生有效/错误JSON等。新结果测试新增而保留原CLI断言。

前轮4项桌面/手机网页回归作为历史证据，本轮产品UI源码保持原样，采用实际ZCode成功任务详情复查。未把前轮网页4项计作本轮重新执行。复杂任务、CLI工具审批和Flash模型独立调用属于范围外，本轮真实模型只做问候。覆盖率没有仓库门槛，本轮未采集。

### 执行与复查附件

工作目录 `/Volumes/machub_app/proj/x-mingting`；Node25.6.1、现有zcode0.17.1，模型GLM-5.3/high，provider为个人bigmodel Coding Plan。原文件只读、项目内显式初始化。诊断副本和含原始诊断stderr的临时材料位于忽略的var；公开本地报告只保存无凭据的模型列表、状态、哈希和问候证据。原临时手动key调用返回401，OAuth隔离绑定后的直接问候及平台问候均成功；历史失败如实保留于investigation.json。

- `node --import tsx --test tests/zcode-runtime.test.ts` 修改前退出1，1执行/0通过/1失败，原因为子进程缺少两个隔离目录变量；日志runtime-red.log。
- `npm run check` 退出0，33执行/33通过/0失败/0跳过，含strict tsc和Vite构建；日志check.log。
- 技术验收独立专项命令 `node --import tsx --test tests/zcode-local-config.test.ts tests/zcode-runtime.test.ts tests/cli-adapter.test.ts` 退出0，9/9；独立 `tsc --noEmit` 退出0，stdout/stderr为空；verify-tech-tests.log与verify-tech-types.log。
- MCP任务 `036e0903-a80d-4afc-97d4-0de3030e913f`，执行run和session见live-evidence.json。Codex工具调用只有一次目标发布，ZCode启动PID33081，平台接收原文本并记录succeeded/end_turn。
- 源/目标权限与环境不变量经新测试和实际文件检查；global-after.json记录6文件allUnchanged=true。package.json/package-lock.json保持原内容，配置、复制的内置定义及唯一登录密文在项目var内。

### 公共验收与结论

x-verify-spec 对本文①–⑤、模块H3/H4、前后基线、完整回归日志、隔离测试、真实MCP/模型/网页证据进行交付对账：**对账通过**。回执保存在 [verify-spec.md](../../reports/zcode-model-selection/verify-spec.md)。

x-verify-tech 根据②D1–D3a及R1–R7审查源码并独立运行9项专项和tsc，核对真实原生CLI结果与全局文件哈希：**技术验收通过**。回执保存在 [verify-tech.md](../../reports/zcode-model-selection/verify-tech.md)。

本轮范围已完成，ZCode成功订阅、唤起和问候回传；功能正文/changelog/README已同步，前轮阻塞以历史记录保留并链接至本轮修复。隔离OAuth过期时由显式初始化命令更新项目快照；当前CLI升级后的兼容性应按新版本再验证。原安装、系统代理和个人配置保持原样，既有其他工作区变更保留。本轮源码与记录保持本地，未创建提交或推送。
