# 在任务详情查看 MCP 唤醒

> 归属模块：当前聊天的事件唤醒
> 功能文档：[W4 在任务详情查看 MCP 唤醒](../CHAT-WAKEUPS.md#w4-在任务详情查看-mcp-唤醒)
> spec: 功能源自模块说明 W4
> tech-design: 本文件②
> 创建：2026-11-06
> 状态：已完成（隔离验证）

## ① 需求与变更

用户本轮授权在截图中的任务详情基本信息加「唤醒目标」和「投递结果」，并解释 `originTurnId`。承接此前界定的 MCP 任务范围。旧版 [功能文档与代码快照](../../reports/task-web-wakeup-status/20261106/evidence/baseline/) 保存了任务开始前工作区内容与差异，基于 `a5540cf`。新增 W4，沿用 W1–W3 的绑定、投递和回合确认定义。[变更索引](../CHAT-WAKEUPS.md#changelog)

## ② 精简技术设计

D1 沿用鉴权后的浏览器 SSE 详情快照，扩展该快照的详情字段。从 Store 既有 MCP 唤醒绑定和事件派生浏览器可见字段。网页只读展示会话、发单轮次、各事件状态。保留既有通用详情与审批回执的边界，投递状态落库后触发已有变更通知。涉及共享 schema、Store、HTTP、任务详情。

R1、R2、R4、R5、R7 适用，由共享 Zod 契约和真实 SSE 验证数据路径。R3、R6 本次无需跨语言契约或新阈值。展示的 ID 受现有网页会话鉴权限制。既有 DSH 专用路径按 MCP 字段口径区分。

## ③ 测试用例与变化

| 用例 | 变化 | 依据与预期 | 入口 |
|---|---|---|---|
| T1 | 修改 | W4 / D1。鉴权快照返回绑定，开始暂无事件，投递更新可见。未授权请求被拒，常规详情保留原字段范围 | `tests/task-wakeups.test.ts` W9 |
| T2 | 新增 | W4 / D1。浏览器显示两项 ID 与事件状态，旧任务明确显示未绑定 | 隔离实例浏览器截图 |
| T3 | 沿用 | W1–W3。绑定校验、审批/完成、投递失败、确认去重与恢复 | 现有唤醒回归 |

## ④ 技术实现

- `src/shared/protocol.ts` 定义浏览器详情可选的唤醒摘要，复用既有绑定与事件字段。
- `src/server/http.ts` 的浏览器快照 `send` 按所选任务组装绑定与投递状态。
- `src/server/store.ts` 的 `saveWakeup` 在保存状态后通知页面刷新。
- `src/web/main.tsx` 的 `App` 在任务详情基本信息展示两项新增信息及空状态。
- `tests/task-wakeups.test.ts` 扩展 W9，检查鉴权、初始快照、实时状态和字段边界。隔离浏览器取证脚本随报告附带。

## ⑤ 验证结果

[统一测试报告](../../reports/task-web-wakeup-status/20261106/test-report.md) 记录 43 项后端测试、浏览器检查和改动覆盖。W4 与 T1–T3 已对账，D1 和适用技术规范通过。文档已同步。

[有绑定截图](../../reports/task-web-wakeup-status/20261106/evidence/wakeups-bound.png) 显示目标、发单轮次和两种投递结果。[无绑定截图](../../reports/task-web-wakeup-status/20261106/evidence/wakeups-unbound.png) 显示普通 MCP 任务的空状态。验收覆盖隔离构建及模拟唤醒宿主，日常服务的上线验证另计。
