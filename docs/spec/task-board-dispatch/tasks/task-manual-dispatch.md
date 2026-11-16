# 手动派发待派发任务

> 归属 [feat02 手动派发待派发任务](../spec.md)
> 状态 已完成 · 2026-11-14

## ① 需求与变更

待派发任务可由网页或 MCP `action:"dispatch"` 命令派发给指定执行者；派发必须解析出执行者，重复派发与终态派发被拒。派发后沿用既有定向投递、推送过滤与认领校验链路。

## ② 精简技术设计

`TaskPublication.dispatch()` 单事务校验状态（409）与执行者（400）、写回 `targetHarness` 并置 `queued`、生成投递事件，事务外触发 SSE 推送；队列上限在派发事务内校验。MCP 入口与网页 `POST /api/tasks/:id/dispatch` 各自记录 `dispatch` / `dispatch.response` 通信。

## ③ 测试用例与变化

platform.test.ts 新增两条用例：网页派发（缺执行者 400、派发后定向执行到完成、终态再派发 409、通信记录含 dispatch）；MCP dispatch 命令（登记不占队列、待派发取消、命令派发、重复派发报错）。

## ④ 技术实现

`src/server/tasks/publication.ts` `dispatch()`；`src/server/tasks/service.ts` `dispatchTask()`；`src/server/transport/browser-api/router.ts` 派发路由；`src/server/transport/mcp.ts` dispatch 分支的通信记录；`src/shared/host-wakeup.ts` `dispatchTaskSchema`。

## ⑤ 验证结果

单元用例通过（见 platform.test.ts「任务中台」两用例）；网页端到端见 [task-web-dispatch-ui](task-web-dispatch-ui.md)。
