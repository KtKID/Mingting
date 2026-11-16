# 任务中台登记与手动派发 · 技术设计

> 草稿，待用户检查。

## 设计要点

派发与否由发布请求是否携带 `targetHarness` 决定，不引入独立的派发开关字段；「待派发」以任务状态 `awaiting_dispatch` 承载，认领、追加、取消、审批等待等既有状态机消费点按白名单各自适配。

## 状态与协议

- `src/shared/protocol.ts` `taskStatusSchema` 新增 `awaiting_dispatch`（置于 `queued` 之前）。任务/运行共用该枚举，终态集合不变。
- `src/shared/host-wakeup.ts` 新增 `dispatchTaskSchema`（`action:"dispatch"` + `taskId` + 可选 `targetHarness`），并入 `taskCommandSchema` 与 `mcpTaskCommandSchema`；MCP 发现 schema 的 `description` 改为可选以兼容 dispatch 分支。
- 状态含义：`awaiting_dispatch`＝已登记未派发（无投递事件、不可认领）；`queued`＝已派发待领取。

## 发布与投递

- `store.publish()`（src/server/storage/store.ts）：初始状态 `input.targetHarness ? "queued" : "awaiting_dispatch"`，`saveTurn` 沿用。
- `TaskPublication.publish()`（src/server/tasks/publication.ts）：事务返回的 `event` 仅在 `task.status === "queued"` 时调用 `store.deliver()`；登记路径不产生投递事件，`available` 回调不触发。
- `countActive()` 不统计 `awaiting_dispatch`：登记不受执行队列上限挤压，派发时在 `dispatch()` 事务内校验 `LIMITS.queue`。

## 手动派发

`TaskPublication.dispatch(command)`（publication.ts）单事务完成：

1. 任务存在（404）且状态为 `awaiting_dispatch`（否则 409「任务已派发或已结束」）。
2. 解析执行者：命令 `targetHarness` ?? 任务既有值；两者皆无则 400「派发需要指定执行者」。
3. 写回 `targetHarness`、置 `queued`、`saveTask`（自动同步最新轮次状态）、`store.deliver()`；事务外 `available(event)` 触发 SSE 定向推送。

调用入口两个，通信记录各自负责（`dispatch()` 本身不写通信）：

- MCP：`mcp.ts` 对 `action === "dispatch"` 先记 `receive`（`dispatch`），回执记 `dispatch.response`。
- 网页：`POST /api/tasks/:id/dispatch`（browser-api/router.ts），body 经 `dispatchTaskSchema.omit({action, taskId})` 校验，走 `taskExchange` 记 `dispatch` / `dispatch.response`。

## 既有状态机适配

| 消费点 | 适配 |
| --- | --- |
| `runs.claim()` | `awaiting_dispatch` 显式 409「任务尚未派发；不能认领」，先于通用 `!== "queued"` 检查，避免误报「已领取或已结束」 |
| `runs.cancel()` | 白名单加入 `awaiting_dispatch`，待派发任务可取消 |
| `publication.append()` | `awaiting_dispatch` 返回 409「任务尚未派发；请先派发或取消后重新发布」 |
| `publisher-subscriptions.waitForApproval()` | 活跃状态列表加入 `awaiting_dispatch`，否则待派发任务被当作已结束、等待立即返回 |
| `runs.retry()` | 仅终态可重试，无需改动；已派发任务重试沿用原执行者重新投递 |
| SSE 推送过滤（transport/connector.ts） | 派发后任务必有 `targetHarness`，过滤逻辑不变；历史遗留的无执行者 `queued` 任务仍广播（向后兼容） |

## 网页（src/web/main.tsx）

- 状态标签 `awaiting_dispatch: "待派发"`；列表筛选新增「待派发」标签页。
- 详情弹窗对 `awaiting_dispatch` 任务显示「派发任务」区（执行者输入 + 派发按钮，datalist 复用在线执行者与受审计名单），派发成功后由实时快照刷新状态。
- 取消按钮的可用状态列表加入 `awaiting_dispatch`。
- 发布弹窗与流程文案更新：留空执行者＝登记待派发，不触发执行者。

## 兼容与迁移

- 数据库无表结构变更：新状态是 `tasks.data` JSON 的取值扩展，旧库无需迁移。
- 旧的无执行者 `queued` 任务（广播语义）不受影响，重启后仍可被认领。
- `npm run publish` 不传执行者时登记为待派发（脚本注释已更新）。
