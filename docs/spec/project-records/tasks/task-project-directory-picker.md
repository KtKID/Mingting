# 选择项目目录

> 所属 spec：[项目记录](../spec.md)
> 状态：已完成
> 执行者：GPT-6.1-Sol（开发）
> 创建：2026-11-16

## ① 需求与变更

用户要求在接入项目表单加入目录选择按钮，调用系统窗口选择本机目录，回填 Git 根目录和默认名称。承接 feat04 场景1–3、原 feat01 场景1及 C1/C2。保留手填和名称编辑。原 Spec 基线见测试报告附件。

## ② 精简技术设计

- D1 在已有本机 HTTP 会话和 CSRF 保护后挂载目录选择操作。macOS 通过系统目录选择窗口返回路径，窗口支持取消、超时和连接关闭时终止；同一服务只运行一个选择操作。
- D2 使用 Git 自带命令解析选中文件夹所在工作树根目录。通过独立进程参数传递路径并清理进程的 Git 覆盖变量。服务端只返回结果，共享 Zod 协议由网页解析。
- D3 浏览器将结果写入可编辑字段。默认显示 Git 根目录名称，用户手填名称优先。提交时使用表单显示的非空名称。重复接入同一根目录写回原记录。目录选择独立于普通 MCP 提交。

## ③ 测试用例与变化

| 用例 | 类型 | 回指                  | 步骤与期望                                                                                                 |
| ---- | ---- | --------------------- | ---------------------------------------------------------------------------------------------------------- |
| T1   | 新增 | feat04 场景1–2，D2    | 真实 Git 仓库、子目录与 worktree 得到对应根路径及名称；拒绝非 Git 目录。                                   |
| T2   | 新增 | feat04 场景2–3，D1/D2 | 复用真实 HTTP 会话及 CSRF，选择器结果由测试夹具提供；成功、取消、非 Git 及无权限状态不写入记录或执行任务。 |
| T3   | 新增 | feat04 场景1–3，D3    | 网页点选择，核对回填、手动改名、取消、错误提示和普通 MCP 最终写入。系统弹窗用测试响应替身。                |
| T4   | 新增 | feat04 场景1–2，D1    | 通过已启动的本机明庭打开系统窗口，实际选择子目录并核对表单回填，另核对取消。                               |

验收范围记录（2026-11-16）：T4 的真实选择与回填由用户确认通过；系统窗口的原生取消按钮保留为未实测项，取消后的协议与页面行为由 T2/T3 覆盖。本轮交付结论按此范围记录。

## ④ 技术实现

- `chooseMacProjectDirectory` 调用 macOS 系统选择器，`projectDirectoryFromGit` 解析真实工作树路径与目录名称。
- `projectRecordsRouter` 在现有浏览器会话与 CSRF 后挂载 `POST /api/project-records/choose-directory`，负责并发、超时、连接关闭和结果校验。
- `projectDirectoryChoiceSchema` 在服务端和网页共享选择与取消结果；`ConnectProjectForm` 显示选择按钮并维护字段草稿，提交经普通 MCP 同步。

## ⑤ 验证结果

- TypeScript 和构建通过，项目记录与选择器 Node 10/10，桌面和窄屏 Playwright 8/8。 [测试报告](../../../../reports/project-records/20261116-02/test-report.md)
- 2026-11-16 用户在真实系统窗口选择 `/Volumes/machub_app/proj/x-mingting/src/web`，确认正确回填根目录 `/Volumes/machub_app/proj/x-mingting` 和名称 `x-mingting`。 [用户验收记录](../../../../reports/project-records/20261116-02/evidence/19-user-native-acceptance.md)
- 取消、错误保留字段及正式保存由自动化回归覆盖；原生取消按钮尚未手动实测。以下截图来自自动化响应替身： [桌面表单](../../../../reports/project-records/20261116-02/evidence/folder-prefill-desktop.png) · [窄屏表单](../../../../reports/project-records/20261116-02/evidence/folder-prefill-mobile-dark.png)
