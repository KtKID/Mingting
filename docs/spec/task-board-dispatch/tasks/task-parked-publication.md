# 发布登记为待派发

> 归属 [feat01 发布登记为待派发](../spec.md)
> 状态 已完成 · 2026-11-14

## ① 需求与变更

明庭定位为任务中台：`new` 不填执行者只登记、不触发执行者。改动覆盖协议状态枚举、发布初始状态、投递事件生成与认领/取消/追加/审批等待的状态机适配。

## ② 精简技术设计

`taskStatusSchema` 新增 `awaiting_dispatch`；`store.publish()` 按是否携带 `targetHarness` 决定初始状态；`publication.publish()` 仅对 `queued` 任务产生投递事件；`runs.claim()` 显式拒绝待派发认领，`runs.cancel()` 白名单放行，`append()` 给出明确报错，`waitForApproval()` 活跃状态列表补齐。

## ③ 测试用例与变化

platform.test.ts 新增「中台登记」用例（无投递、认领 409、取消、countActive 为 0）；既有不填执行者却期望执行的用例改为显式派发（夹具 `publish` 默认 `targetHarness:"Codex"`，直连调用逐个补执行者与身份注册）；approval-replay 的无关任务断言改为 `awaiting_dispatch`。

## ④ 技术实现

见 [tech-design](../tech-design.md) 「发布与投递」「既有状态机适配」两节。涉及 `src/shared/protocol.ts`、`src/shared/host-wakeup.ts`、`src/server/storage/store.ts`、`src/server/tasks/{publication,runs,publisher-subscriptions}.ts`。

## ⑤ 验证结果

routing/streaming/task-turns/approvals/task-wakeups/host-wakeup/multi-harness/approval-replay 全部通过；platform.test.ts 与网页回归见 [task-regression-updates](task-regression-updates.md)。
