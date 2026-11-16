# 回归用例适配与存量修复

> 归属 [feat01](../spec.md) / [feat02](../spec.md)
> 状态 已完成 · 2026-11-14

## ① 需求与变更

发布默认语义从「发布即派发（广播领取）」改为「指定执行者才派发」，所有依赖默认派发的既有用例需要显式化；顺带修复一条早于本需求就已失败的存量用例。

## ② 精简技术设计

测试夹具层给 `publish` 辅助默认 `targetHarness:"Codex"`（显式传 `undefined` 可回到登记路径）；直连 `service.publish` + `service.claim` 的用例同时补执行者与 `registerHarness` 身份注册，保持「认领者即目标执行者」的既有校验语义。

## ③ 测试用例与变化

- platform.test.ts：夹具默认值；崩溃前排队任务补执行者。
- approvals.test.ts：`prepare()`、P9、审批等待配置用例补执行者与身份；排队等待窗口用例改用离线执行者保持 `queued`。
- streaming.test.ts、task-wakeups.test.ts（夹具与 W9）、host-wakeup.test.ts（标准 MCP 与 legacy 排队）：同模式适配。
- approval-replay.test.ts：无关任务断言 `awaiting_dispatch`。
- acp-offline-replay.test.ts：存量修复——`POST /api/tasks` 已随统一 MCP 发单退役，改走 `service.publish`。
- ui.spec.ts：A4/发布审批/拒绝重试用例补填执行者。

## ④ 技术实现

仅测试文件改动，无产品代码变化（`waitForApproval` 的状态白名单修复归属 [task-parked-publication](task-parked-publication.md)）。

## ⑤ 验证结果

`npm run test:unit` 全量通过；网页与完整回归见总验证记录。
