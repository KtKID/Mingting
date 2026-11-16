# 选择项目目录测试报告

- 需求 [项目记录 feat04](../../../docs/spec/project-records/spec.md) · [增量 Task](../../../docs/spec/project-records/tasks/task-project-directory-picker.md)
- 比较基线 [实施前 Spec](evidence/spec-before-directory-picker.md) · [Git HEAD](evidence/head.txt) · [实施前工作区](evidence/before-status.txt)
- 工作目录 `/Volumes/machub_app/proj/x-mingting`。自动化测试使用临时 SQLite、回环 HTTP、macOS Chrome 和实际 Git 命令。浏览器测试仅替换系统选择端点响应，正式同步仍走真实 MCP。

| 执行 | 检查 | 结果 |
| --- | --- | --- |
| E01 | `node --import tsx --test tests/project-directory-picker.test.ts` | 实现前携带正确 Origin、会话和 CSRF 的请求返回 404。 [原始输出](evidence/03-http-red-with-origin.log) |
| E02 | Playwright 桌面项目，筛选 `system directory result` | 实现前找不到「选择文件夹」。 [原始输出](evidence/02-ui-red.log) |
| E03 | Playwright 桌面项目，筛选 `submitting the displayed` | 修复前正式同步丢失表单显示的默认名称；失败于相应名称标签未选中。 [原始输出](evidence/10-default-name-red.log) |
| E04 | `npm run build` | TypeScript 和 Vite 通过。 [原始输出](evidence/11-build-green.log) |
| E05 | `node --import tsx --test --experimental-test-coverage tests/project-directory-picker.test.ts tests/project-records.test.ts`（spec/LCOV 输出） | 10/10，含原项目记录 7 项。 [原始输出](evidence/12-node-final.log) · [LCOV](evidence/13-node-final.lcov) |
| E06 | `npx --no-install playwright test project-records-ui.spec.ts --reporter=list`（指定本机 Chrome 及本批证据目录） | 8/8，桌面和窄屏各四项。 [原始输出](evidence/14-ui-final.log) |
| E07 | `/usr/bin/osacompile -o /private/tmp/mingting-directory-picker.scpt /private/tmp/mingting-directory-picker.applescript` | 从生产常量提取原脚本，允许访问 macOS Standard Additions 的本机会话编译成功。 [受限环境编译日志](evidence/07-osacompile.log) · [会话编译 stderr](evidence/08-osacompile-user-session.log) |
| E08 | 用户通过真实网页和系统目录窗口选择 `x-mingting/src/web` | 用户确认回填根目录 `/Volumes/machub_app/proj/x-mingting` 和名称 `x-mingting`。本项依据用户亲自操作后的反馈。 [用户验收记录](evidence/19-user-native-acceptance.md) |
| E09 | 更新文档后只读核对正式 SQLite 快照 | 周期同步已将「选择项目目录」记录为 `phase: completed`，状态依据指向 Task 第 4 行；同步错误为空。 [同步结果](evidence/20-live-acceptance-status.json) |

## 场景核对

- T1 / D2，E05。实际 Git 项目从带空格和中文目录名的子目录定位正确根部。在链接 worktree 的子目录中返回该 worktree 的根部和名称。
- T2 / D1–D2，E05。缺 Cookie 或 CSRF 时返回 403，选择器调用次数为零；取消返回 cancelled，非 Git 返回 422。并发第二请求返回 409，断开第一请求向选择器传递取消，随后可重新打开。数据库没有新增项目、执行任务、运行或投递。
- T3 / D3，E06。新表单目录为空且可手填，选择后回填根路径和名称。手填名称优先，取消与错误保留两字段。提交默认值能新建记录，也能按同一根路径更新既有名称；提交手填名称后可见对应项目。 [桌面表单](evidence/folder-prefill-desktop.png) · [窄屏表单](evidence/folder-prefill-mobile-dark.png)
- T4 / D1–D2，E08 确认真实系统窗口选择子目录与 Git 根目录、默认名称回填通过。E07 验证系统脚本可编译，E05/E06 的测试替身覆盖取消返回后的协议和页面行为。原生取消按钮尚未手动实测。

## 独立验收与交付结论

主负责人将既有本机 60390 服务更新为本批代码，恢复 `TASK_CONNECTOR=manual MINGTING_CODEX_WAKEUPS=0`，执行器列表为空。通过原有网页打开接入表单，确认项目目录初始为空、选择按钮可见。首次点击后按钮显示“选择中…”，电脑工具无法绑定 `osascript` 独立进程的窗口；整应用截图被自动审核拦截，原因是可能包含无关私密会话。操作等待超时后网页显示可重试提示，随后交由用户完成实际选择。

2026-11-16 用户回复“已正确回填根目录和名称”，确认在系统窗口选择 `/Volumes/machub_app/proj/x-mingting/src/web` 后，表单根目录与默认名称符合预期（E08）。后续只读查看时接入表单已收起，未追加现场回填截图；E08 的证据来源明确为用户亲自验证。Task 和 Spec 变更记录已更新为已完成。

主负责人只读核对存储路径为本仓库 `var/tasks.sqlite`，接入项目保存在 `project_records`。服务更新前原数据为 1 个项目记录、45 个执行任务、47 个运行；[核对快照](evidence/live-before.json)仅包含路径、名称及计数。业务代码与[本批实现基线](evidence/18-picker-baseline-sha256.txt)的校验和匹配，`git diff --check` 通过。

`x-verify-spec` 交付对账：feat04 场景1的真实选择与回填由 E08 确认，默认名称及自定义名称的正式保存由 E06 覆盖；场景2的取消、错误保留表单由 E05/E06 覆盖；场景3的选择无写入及普通 MCP 最终同步由 E05/E06 覆盖。`x-verify-tech` 技术对账：D2 的真实 Git 路径解析和 D3 的回填/正式保存已由独立代码复核及 E05/E06 核对；D1 的原生成功交互由 E08 确认，会话、CSRF、并发和请求关闭部分有 E05 实际 HTTP 证据。本轮交付记录为已完成。原生取消按钮的人工验证仍属于覆盖限制，未计入实际系统窗口验收通过范围。

本批最终自动化证据已通过 `PROJECT_RECORDS_EVIDENCE_DIR` 隔离。首轮自动化运行覆盖了上批部分 T6 截图及原始浏览器覆盖 JSON，上批报告已记录受影响范围；两批的原始日志及上批 `live-*` 证据均保留。

## 覆盖

- Node 使用 E05 实测 LCOV。新目录选择模块 61/93 行、7/10 分支，选择端点与其接线分别列出采集范围、命中和未覆盖位置。选择器默认系统窗口运行段未由自动化集成覆盖。 [分母与未覆盖位置](evidence/16-picker-node-coverage.log)
- 浏览器使用 E06 主包实际执行数据与同字节源码映射，`ConnectProjectForm` 源码中 92/92 个有映射的行有执行片段。前端分支和 CSS 未采集。 [前端覆盖](evidence/17-picker-web-coverage.log)

Git 归档范围包含两批验收报告、报告引用的日志、LCOV、截图、状态快照和用户验收记录。浏览器原始覆盖 JSON 继续保存在本机批次目录。文档基线快照保留采集时原文，其中的相对链接按原 Spec / Task 位置解释。

原生实现基于 macOS Standard Additions 的文件夹选择命令与 Git 自带的工作树根解析。 [Apple 目录选择参考](https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/PromptforaFileorFolder.html) · [Git rev-parse](https://git-scm.com/docs/git-rev-parse.html)
