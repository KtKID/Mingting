0.2 订阅实现完成状态（2026-10-31 UTC）

已实现：持久 task.available 通知、HTTP SSE 历史/实时订阅、Last-Event-ID 续传、原子领取和 owner/claim fencing、独立 Codex 连接器、心跳租约、顺序幂等回传、HTTP ACP 审批桥接、取消/超时/重启恢复。原直接执行队列已移除，MCP 仍仅 publish_task。

21 个服务端/HTTP订阅/ACP子进程测试及 TypeScript/Vite 构建通过；4 个桌面/手机浏览器交互用例全部通过，最终结果见 TEST-REPORT.md。未真实登录或调用模型；未改 Mac、MadeMe 或既有 Site。源码包替换和提交信息由最终回复提供。
