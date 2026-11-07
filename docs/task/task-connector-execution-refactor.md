# 按运行顺序整理任务连接器

> 功能文档：[明庭任务连接器](../../src/connector/readme.md#connectorts)
> 技术依据：[设置回执顺序](../spec/codex-task-settings-and-audit/tech-design.md#settings) · [同次运行归属](../spec/codex-task-settings-and-audit/tech-design.md#audit) · [审批裁决](../APPROVALS.md#a3-用户优先与十秒窗口)
> 创建：2026-11-07
> 状态：已验证

## ① 需求与变更

用户要求拆出回报队列和审批轮询，让 `execute()` 可以按实际执行顺序阅读，并给关键时序补注释。既有领取、续租、取消、回报和审批行为是验收基线。功能变更数为 0，调整归属为连接器的代码说明及变更条目。

修改前版本为 `1bd80a7b0302451b2a71f68352cb341152238bc3` 中的 `src/connector/connector.ts`（blob `1f4cc383db2b9823068520e7e66a8501c7770f6a`）和模块说明（blob `50d35640e9068d9552e3355e2e1ecbf7994d6ed5`）。开始时 `AGENTS.md`、`TODO.md`、任务模块说明及其他未跟踪文件已有工作区改动，与本次范围分别记录。

## ② 精简技术设计

- D1 `execute()` 直接组织首次心跳、调用执行器和收尾。用模块内函数封装每次运行的心跳、回报队列和审批处理，通过同一个领取凭据及运行取消信号关联三者。
- D2 回报队列拥有唯一的 `seq` 和待提交链。设置回执遇到传输异常时沿用原序号补发一次。终态等待既有回报尝试结束，即使队列失败也继续尝试提交。
- D3 审批回调等待触发时已排队的回报，按现有协议登记并轮询，响应运行与审批取消。心跳保持独立，收尾按原顺序清理计时器、提交终态。

R1/R4/R5/R7 通过检查函数边界、唯一队列状态、名称及调用顺序验收。R2/R6 沿用共享 schema、`LIMITS` 和现有 HTTP 传输层。R3 涉及的协议实现为同一 TypeScript 源。

## ③ 测试用例与变化

| 用例 | 类型 | 依据 | 验收内容 |
| --- | --- | --- | --- |
| T1 `platform.test.ts` 设置回执用例 | 沿用回归 | D1、D2 | 回执先于提示词，确认丢失重发原序号，失败分支阻止执行 |
| T2 `platform.test.ts` 领取和租约用例 | 沿用回归 | D1–D3 | 顺序回报去重，等审批时继续续租，取消后释放下一任务 |
| T3 `approvals.test.ts` P10 和 `approval-replay.test.ts` AR2 | 沿用回归 | D3 | ACP 子进程等待用户裁决，返回原选项，真实记录回放覆盖允许与拒绝 |
| T4 `execute()` 代码走读 | 静态检查 | D1–D3 | 主流程显示首次心跳、运行、排空回报和收尾，定时与回调边界有注释 |

测试用例新增、修改、删除均为 0。通过现有行为回归验证重构。

## ④ 技术实现

- `src/connector/connector.ts` 将 `execute()` 从 200 行缩到 109 行。入口按建立运行状态、启动心跳、检查运行配置、调用执行器、判断结果和清理的顺序排列。
- `createRunReports()` 统一持有回报序号、积压计数和待提交链。`createPermissionHandler()` 等待已排队的回报后登记并轮询审批。`createRunHeartbeat()` 把单个在途心跳和平台取消状态封装在一起。
- [连接器说明](../../src/connector/readme.md#connectorts) 同步函数入口和变更条目。原有功能定义继续作为行为依据。

## ⑤ 验证结果

[测试报告](../../reports/connector-execution-refactor/20261107-01/test-report.md) 汇总了 120 项 Node 回归、13 项专项复跑、TypeScript 检查、覆盖率和证据。回归与专项均通过，交付对账与技术检查已核对。专项覆盖率的缺口单列在报告中。
