# 项目记录测试报告

- 功能定义 [项目记录 Spec](../../../docs/spec/project-records/spec.md)
- 任务与设计 [项目记录 Task](../../../docs/spec/project-records/tasks/task-project-records.md)
- 比较基线 [开发前工作区](evidence/baseline.json)，Git HEAD `38bcc87a3193541c9f9585bd751420eb742a28c4`。2026-11-16 用户确认 C 布局、左侧竖直导航、项目内多个同时存在的 Spec 及其独立任务、同一 Spec 统一卡片前缘色。
- 工作目录 `/Volumes/machub_app/proj/x-mingting`。测试使用临时 SQLite、回环监听、Chrome、真实 MCP 协议和真实浏览器页面。执行回归使用仓库自带隔离夹具；Codex Spec 样本直接读取本仓库文档。

## 执行记录

| 执行 | 命令与检查 | 结果 |
| --- | --- | --- |
| E01 | `PLAYWRIGHT_CHROMIUM_EXECUTABLE=… npx --no-install playwright test project-records-ui.spec.ts --grep 'connects two projects' --reporter=list` | 修改前桌面与窄屏都在导航链接 x 坐标断言失败。 [浏览器红灯](evidence/06-layout-red.log) |
| E02 | `node --import tsx --test --test-name-pattern='completion requires' tests/project-records.test.ts` | 修改前 2/2 的旧报告将当前三项清单误判为完成。 [状态红灯](evidence/07-status-red.log) |
| E03 | `npm run build` | TypeScript 和 Vite 构建通过。 [构建原始输出](evidence/14-build.log) |
| E04 | `node --import tsx --test --experimental-test-coverage tests/project-records.test.ts` | 7/7。 [记录集成](evidence/09-records-green.log) |
| E05 | `PLAYWRIGHT_CHROMIUM_EXECUTABLE=… npx --no-install playwright test project-records-ui.spec.ts --reporter=list` | 4/4，桌面和窄屏暗色各两个用例。 [项目记录浏览器测试](evidence/08-board-green.log) |
| E06 | `PLAYWRIGHT_CHROMIUM_EXECUTABLE=… npm test` | 首轮 Node 143/144，完整 MCP 工具清单断言缺新工具。浏览器 26/26、审批回放 10/10。已更新 Node 预期并重跑。 [首轮回归](evidence/10-regression.log) |
| E07 | `npm run test:unit` | 144/144；包含实际 MCP、SQLite、ACP 子进程、审批和串行队列。 [第二轮 Node 回归](evidence/13-unit-regression.log) |
| E08 | `PLAYWRIGHT_CHROMIUM_EXECUTABLE=… npx --no-install playwright test project-records-ui.spec.ts --grep 'connects two projects' --reporter=list` | 筛选计数修复前，桌面和窄屏均在待关注下显示待开始 1，实际卡片为 0。 [筛选计数红灯](evidence/16-filter-red.log) |
| E09 | `npm run build` | 筛选计数修复后的 TypeScript 和 Vite 构建通过。 [构建输出](evidence/17-filter-build.log) |
| E10 | `PLAYWRIGHT_CHROMIUM_EXECUTABLE=… npx --no-install playwright test project-records-ui.spec.ts --reporter=list` | 4/4。搜索和待关注下五个列头逐项等于当前可见卡片数，全项目摘要仍为 8 Task。 [筛选计数绿灯](evidence/19-filter-green.log) |
| E11 | `node --import tsx --test --experimental-test-coverage --test-reporter=spec --test-reporter=lcov tests/project-records.test.ts`（分别指定报告路径） | 7/7；采集当前 Node 行和分支覆盖。 [运行结果](evidence/22-node-coverage.log) · [LCOV 原始数据](evidence/23-node-coverage.lcov) |
| E12 | 主负责人通过实际 `http://127.0.0.1:60390/` 网页进入项目记录，接入本仓库，再打开任务与交付报告 | 6 个 Spec / 17 个 Task；Codex 样本为 5 Task / 19 步骤。实际页面支持左侧导航、独立 Spec 行及对应任务来源。 [页面原始状态](evidence/live-final.ax.txt) · [实际页面截图](evidence/live-final.jpg) |
| E13 | 保持实际页面打开，开发文档由进行中更新为待验收，页面持续观察；随后重新加载最终构建，搜索“项目记录” | 自然同步后该 Task 进入待验收；无需点击刷新记录。最终构建搜索结果仅一张卡，待验收列头为 1，其他列为 0，摘要仍为 17 Task。 [自然同步状态](evidence/live-auto-sync.ax.txt) · [同步截图](evidence/live-auto-sync.jpg) |
| E14 | 实际网页接入框输入本仓库的 `docs/spec/project-records` 子目录作为错误项目根目录 | 网页反馈源目录读取 ENOENT；原有明庭项目及其 17 Task 保留。此项验证接入失败反馈；已接入项目离线后的快照保留由 E04/E11 的真实 SQLite 用例验证。 |
| E15 | 主负责人只读检查日常 SQLite，并运行 `npx --no-install tsc --noEmit`、`git diff --check` | 原任务数量 45、运行数量 47，与接入前相同；项目记录表为 1 条。类型检查及差异检查退出码均为 0。 [持久化核对](evidence/live-persisted-state.json) |

## 用例与证据

| 用例 | 覆盖范围 | 实际证据 |
| --- | --- | --- |
| T1 | feat03 场景1，C2/C3，D1/D2 | E04 从本仓库 Codex Spec 解析 5 个已完成 Task、19 项验证通过的步骤和共享报告引用。 |
| T2 | feat03 场景1，C3，D2 | E02/E04 检查明确进行中、阻塞、未知状态；报告 2/2、2/3 对三项清单均停留待验收，报告 3/3 才推断完成；任务头标为完成且 T1 验证失败，展示待核对和冲突原因。 |
| T3 | feat01 场景2–3、feat03 场景2，C2–C4，D1/D3 | E04 核对不同项目 ID、内容变更与相同任务 ID、重复同步、显式循环刷新、DB 重开和源目录失效后保留上次成功快照。 |
| T4 | feat01 场景1/3，C1/C4，D3/D4 | E04 两根目录通过普通 MCP 同步，以实际 HTTP 功能读同一快照；任务、未完运行、投递及可领事件数均为零；无会话 HTTP 查询返回 403。 |
| T5 | feat02 场景3、feat03 场景2，C3/C4，D2/D4 | E04 用越界路径和越界符号链接确认拒绝；已登记的任务来源可通过 HTTP 获取。 |
| T6 | feat01 场景1–2、feat02 场景1–2，D4/D5 | E05 界面接入两项目、切换、搜索、待关注、任务详情、来源原文、更新为已完成；窄屏页面宽度保持在视口内。真实 Codex 样本显示 5 张 Task 卡、详情 3/3 及统一报告入口。E08/E10 补证两个筛选入口的列头数及全项目摘要。 |
| T7 | C1，D4/D5，既有任务台流程 | E06/E07，按下方整体结果汇总。 |
| T8 | feat01 场景3、feat02 场景1，C2/C4，D1/D5 | E01/E04/E05 核对左栏布局、每项目 2 个 Spec 和相同 Task 名、8 个唯一任务 ID、独立状态与来源；同 Spec 卡片的前缘颜色跨阻塞和阶段切换保持一致，相邻 Spec 用另一种颜色。 |

## 覆盖

Node 分母为专项集成 E11 的 LCOV `DA` 行和 `BRDA` 分支。新增文件使用全量记录，既有文件与 Git HEAD 对比后取 diff 新增侧行。合计行 548/571，分支 161/190。 [逐文件未覆盖行及分支](evidence/24-node-diff-coverage.log)

| 文件 | 行命中/分母 | 分支命中/分母 |
| --- | --- | --- |
| `src/server/records/importer.ts` | 283/298 | 107/129 |
| `src/server/records/service.ts` | 66/71 | 24/28 |
| `src/server/records/transport.ts` | 67/70 | 9/11 |
| `src/shared/project-records.ts` | 93/93 | 18/19 |
| `src/server/storage/store.ts` | 20/20 | 1/1 |
| `src/server/transport/browser-api/router.ts` | 4/4 | 1/1 |
| `src/server/transport/http.ts` | 8/8 | 1/1 |
| `src/server/transport/mcp.ts` | 4/4 | 0/0 |
| `src/server/transport/web-assets.ts` | 3/3 | 0/0 |

修复后 E10 四个浏览器用例产生六份主包覆盖记录，实际主包与用于提取源码映射的主包字节一致。分母为源码映射覆盖的 TSX 行，任一映射片段执行即记命中。新增 `page-nav.tsx` 12/12、`project-records.tsx` 494/542，既有 `main.tsx` 新增侧 3/10。 [新增 TSX 未覆盖位置](evidence/20-filter-browser-coverage.log) · [main.tsx 未覆盖及无映射位置](evidence/25-web-main-diff-coverage.log)

前端分支覆盖未采集。CSS、Playwright 配置和测试文件不计入业务代码覆盖分母。布局、滚动、位置和颜色使用当前界面断言及截图核验。同步丢失来源时，SQLite 保留快照由 E04/E11 验证；E13/E14 补充实际浏览器自然定时更新与接入失败反馈。已接入项目离线的错误横幅、高负载刷新及全部输入容量上限未单独进行浏览器验证。

## 浏览器截图

- [桌面 C 布局](evidence/board-desktop.png) 展示左侧导航、两个项目、两个 Spec、五个阶段、统一任务色条和红色阻塞提示。
- [窄屏暗色布局](evidence/board-mobile-dark.png) 展示左侧导航、窄屏看板、定位到进行中列时的相同色条和独立阻塞提示。
- [真实 Codex Task 详情](evidence/real-detail-desktop.png) 展示真实文档的状态来源、步骤与统一报告链接。 [窄屏详情](evidence/real-detail-mobile-dark.png)

## 交付对账

功能 Spec 的三个 feat、四项共享约束、D1–D5 和 T1–T8 已回指。各阶段最终证据为 Node 144/144（E07）、构建通过（E03）、浏览器 26/26 与审批回放 10/10（E06）。E06 的批次处于失败状态，唯一失败发生在已由 E07 重跑通过的 Node 阶段。业务代码在两轮间一致；第二轮只更新既有测试的完整工具清单断言。

筛选计数修复在 E06/E07 之后。修复涉及看板的列头统计、浏览器断言与 Store 注释，当前基线重跑受影响的构建与专项浏览器测试（E09/E10），另外通过专项集成复采 Node LCOV（E11）。 [当前源文件校验和](evidence/21-filter-baseline-sha256.txt)

## 独立技术与交付回执

开发由用户指定的 `gpt-6.1-sol` 完成；主负责人使用 `x-verify-spec` 与 `x-verify-tech` 复核用户确认、Spec、qdev 设计、当前代码、测试原始记录及实际页面。E12–E15 为主负责人新增的实际验收证据。业务代码采用 E09–E11 对应版本；最后只更新交付文档状态。[独立验收元数据](evidence/27-independent-verification.json)、[最终校验和](evidence/26-accepted-baseline-sha256.txt)、验收前 [Spec](evidence/spec-before-acceptance.md) 和 [Task](evidence/task-before-acceptance.md) 已归档。

| 设计与规范 | 方法、观察与判断 |
| --- | --- |
| D1，R2/R5 | 代码审查从 `shared/project-records.ts` 追至 Store 校验、MCP SDK 输出和页面解析；E04/E11 检查实际协议结果，E12 经真实网页读取同一协议。通过。 |
| D2，R1/R4/R7 | 阅读导入器与 T1/T2/T5 的实际结果。Task 来自各自来源路径，内部步骤单独保留；显式状态、清单及报告规则保持可追溯；跨根路径与符号链接逃逸由真实文件夹具拒绝。通过。 |
| D3，R1/R4/R6/R7 | 代码审查新表、周期核对与关闭路径；E04/E11 覆盖重复同步、SQLite 重开及失败快照，E13 补证服务周期核对与网页轮询的自然更新。通过。 |
| D4，R2/R4/R7 | 真实 MCP 与 HTTP 访问由 E04/E11 验证；E12 通过用户网页入口接入；E15 确认日常库原任务/运行数量保持 45/47。新记录写入独立表。通过。 |
| D5，R5/R7 | E10 验证两个项目各自多个 Spec、同名 Task、身份色与列头筛选计数；E12/E13 核对实际页面及文档来源。通过。 |
| R3 | 本轮前后端同为 TypeScript，共用同一 Zod 模块；跨语言协议同步不适用。 |

R1 的模块依赖采用代码审查：HTTP 组合记录服务，记录服务通过 Store 公共方法读写，Store 只依赖共享协议；页面通过 HTTP/MCP 访问。此次未新增仓库级依赖图工具。R6 的文件/项目/任务容量和同步周期来自 `RECORD_LIMITS`，网页轮询来自 `REFRESH_MS`；高负载边界保留为上述验证局限。

**x-verify-tech：通过，范围为 D1–D5 及本轮适用规范。** 来源、协议、存储和 UI 核查均有对应实际证据，局限按覆盖节保留。

**x-verify-spec：qdev 对账通过。** 本 task 承接用户确认的 C 布局及项目记录范围；3 个 feat 的 8 个场景、C1–C4、D1–D5、T1–T8 回指及 E01–E15 执行记录已核对。对账步骤复用已执行记录，证明交付记录闭合；独立行为证据见 E12–E15。既有回归保留原批次和后续修复的版本边界。

实际服务原先停止，主负责人以 `TASK_CONNECTOR=manual MINGTING_CODEX_WAKEUPS=0` 启动本机 60390，执行器列表为空。项目接入经普通网页/MCP 入口完成。

## 后续批次的证据保留说明

2026-11-16 的目录选择增量任务首次运行浏览器测试时沿用了测试文件的默认附件目录，覆盖了本目录中的自动化 T6 截图与 `browser-coverage/` JSON。历史执行日志、已计算覆盖汇总、来源校验和及 `live-*` 实际验收证据保持原样。被覆盖附件现在反映后续测试状态，无法作为本批原始字节重放；本报告历史执行结论仍以原日志和汇总记录为依据。后续批次已通过 `PROJECT_RECORDS_EVIDENCE_DIR` 指定独立证据目录。
