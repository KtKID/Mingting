# 明庭任务中台：发布登记与手动派发

明庭先作为任务中台运行：发布任务与查看任务保留，发布默认不触发任何执行者。发布时填写执行者即立即派发（沿用原「定向发布」链路）；不填执行者的任务登记为「待派发」，可由网页或 MCP `dispatch` 命令在之后派发给指定执行者。

## 本次目标与完成条件

- **本次目标与范围**　把「是否派发」与「是否选择执行者」绑定：`new` 不填 `targetHarness` 只登记（新状态 `awaiting_dispatch`），填写则按原链路立即投递。新增手动派发入口（网页按钮与 MCP 命令），派发时必须能解析出执行者。
- **验证证据**　单元与平台回归覆盖登记不投递、认领拦截、派发后定向执行、重复派发拒绝、待派发取消、队列上限不占位；网页 Playwright 覆盖待派发徽标与详情派发流程。
- **完成条件**　不填执行者的任务发布后：无投递事件、无执行者被触发、直接认领被拒；经网页或 MCP 派发后按原定向发布链路执行并完成。填写执行者的发布行为与既有回归一致。
- **关联范围**　[定向发布语义](../../docs/HARNESS-SUBSCRIPTIONS.md) H2 的「派发触发条件」由本需求更新；[领取流程](../../docs/TASK-CLAIM-FLOW.md) 增加待派发前置状态。

## 关键约束（用户已确认）

| 编号 | 约束与适用范围 | 可观察判据与禁止结果 | 确认依据 / 关联场景 |
| --- | --- | --- | --- |
| C1 | 发布不指定执行者时只登记，不派发 | 任务状态为 `awaiting_dispatch`；`deliveries` 不新增；在线执行者收不到 `task.available`；认领返回 409「任务尚未派发」 | 用户定位明庭为任务中台，feat01 场景1–2 |
| C2 | 发布指定执行者时立即派发，行为与原定向发布一致 | 任务 `queued` + 投递事件 + 定向推送/认领校验沿用既有链路；既有定向回归不回退 | 用户要求保留「可选择执行者的模式」，feat01 场景3 |
| C3 | 待派发任务可手动派发，派发必须解析出执行者 | 网页按钮与 MCP `action:"dispatch"` 都能派发；命令未带执行者且任务无执行者时返回 400；非待派发状态返回 409 | 用户确认本阶段提供手动派发入口，feat02 场景1–3 |
| C4 | 待派发任务可取消，且不占执行队列上限 | `awaiting_dispatch` 可取消为 `cancelled`；`countActive` 不统计待派发任务，登记数量不受执行队列 100 上限挤压 | 派发/取消对称性要求，feat01 场景4、feat02 场景4 |
| C5 | 待派发任务不支持追加轮 | `append` 对 `awaiting_dispatch` 返回明确的 409「任务尚未派发」，不再误报「原执行尚未释放」 | 追加语义依赖已完成执行，feat02 场景5 |

## feat01: 发布登记为待派发

**场景1　不填执行者发布**

- GIVEN 明庭服务已启动且有执行者在线
- WHEN 发布者通过 MCP `new` 提交任务，不填 `targetHarness`
- THEN 任务创建成功并返回常规回执，状态为 `awaiting_dispatch`；不产生投递事件，在线执行者不收到任何通知

**场景2　待派发任务不可被认领**

- GIVEN 存在 `awaiting_dispatch` 任务，目标执行者在线
- WHEN 执行者直接调用 `POST /connector/claim`
- THEN 认领被拒（409「任务尚未派发」），任务保持 `awaiting_dispatch`，不产生运行

**场景3　填写执行者立即派发**

- GIVEN 目标执行者在线
- WHEN 发布者通过 MCP `new` 提交任务并填写 `targetHarness`
- THEN 任务 `queued`、产生投递事件并被目标执行者领取执行，与既有定向发布回归一致

**场景4　待派发任务取消**

- GIVEN 存在 `awaiting_dispatch` 任务
- WHEN 用户在网页点击「取消任务」
- THEN 任务转为 `cancelled`，无运行残留

## feat02: 手动派发待派发任务

**场景1　网页派发**

- GIVEN 存在 `awaiting_dispatch` 任务，目标执行者在线
- WHEN 用户在任务详情填写执行者并点击「派发」
- THEN 任务转为 `queued` 并记录派发通信，目标执行者收到 `task.available`、领取执行直到完成；执行者名下记录 `harnessName`

**场景2　MCP 派发命令**

- GIVEN 存在 `awaiting_dispatch` 任务
- WHEN 发布者调用 `mcp-mingting-tool`，`action:"dispatch"`，携带 `taskId`（可选 `targetHarness` 覆盖）
- THEN 派发成功回执包含任务编号与轮次；无 `targetHarness` 且任务未指定时返回 400「派发需要指定执行者」

**场景3　重复派发与终态派发被拒**

- GIVEN 任务已派发（`queued`/`running`/…）或已结束
- WHEN 再次调用派发
- THEN 返回 409「任务已派发或已结束」，任务状态不变

**场景4　待派发不占队列上限**

- GIVEN 执行队列已有任务运行
- WHEN 连续登记多条不带执行者的任务
- THEN 登记不受 `LIMITS.queue` 挤压（`countActive` 不统计 `awaiting_dispatch`），派发时才校验队列上限

**场景5　待派发任务追加被明确拒绝**

- GIVEN 存在 `awaiting_dispatch` 任务
- WHEN 原发布会话调用 `append`
- THEN 返回 409「任务尚未派发；请先派发或取消后重新发布」
