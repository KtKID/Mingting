2026-11-01 ZCode 闭环修复

按 qdev 修复 ZCode 原生 CLI 的账户绑定与项目内运行环境。注册表恢复 GLM-5.3 / GLM-5.3-Flash；真实 Codex CLI 经 MCP 发布任务 036e0903-a80d-4afc-97d4-0de3030e913f，ZCode 订阅/领取/唤起/回传成功，输出“你好，我是 ZCode。”，平台为 succeeded。33 项自动测试及构建通过；原安装、全局登录及配置文件校验保持一致。详细记录见 [qdev](task/task-zcode-model-selection.md)。

以下为前轮执行历史。

2026-11-01 本机身份订阅扩展

按 x-qdev 实现身份登记、targetHarness 定向通知/领取、MCP list_harnesses、Grok/ZCode 原生 CLI 桥接与项目内服务启停。真实 Codex MCP 发布三个问候任务：Codex、Grok 成功；ZCode 已订阅、领取及唤起，模型选择错误阻塞执行。28 项服务/原生 CLI 测试和构建通过，4 项网页回归通过。功能与证据见 [Harness 订阅](HARNESS-SUBSCRIPTIONS.md) 和 [qdev 记录](task/task-harness-subscriptions.md)。

下面保留原 0.2 历史记录。

0.2 订阅实现完成状态（2026-10-31 UTC）

已实现：持久 task.available 通知、HTTP SSE 历史/实时订阅、Last-Event-ID 续传、原子领取和 owner/claim fencing、独立 Codex 连接器、心跳租约、顺序幂等回传、HTTP ACP 审批桥接、取消/超时/重启恢复。原直接执行队列已移除，MCP 仍仅 publish_task。

21 个服务端/HTTP订阅/ACP子进程测试及 TypeScript/Vite 构建通过；4 个桌面/手机浏览器交互用例全部通过，最终结果见 TEST-REPORT.md。未真实登录或调用模型；未改 Mac、MadeMe 或既有 Site。源码包替换和提交信息由最终回复提供。
