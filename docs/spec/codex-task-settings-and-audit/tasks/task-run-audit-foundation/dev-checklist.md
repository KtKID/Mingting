# task-run-audit-foundation · 运行归属与存储底座

> Spec [需求与约束](../../spec.md)
> 技术设计 [v0.2 已确认](../../tech-design.md)
> 测试用例 [T10 事务与兼容性](../../tech-design.md#t10)
> 创建于 2026-11-05，公共技术支撑

**状态**　`[ ] ⏳` 未开始 / `[ ] ▶️` 进行中 / `[x] 🟢` 验证通过 / `[!] 🔴` 验证失败

| # | 任务 | 场景回指 | 涉及文件 | 风险 | 状态 |
|---|---|---|---|---|---|
| T1 | 先测旧记录解析及公共字段校验，再补共享 Zod 契约。定义请求设置、设置回执、`RunUsage`、上下文观测、运行审计条目和可空的审批裁决时间。沿用任务、运行、会话和报告标识（D01/D03/D04，设计用例 T10 的契约检查，集成） | None | `src/shared/protocol.ts`, `tests/platform.test.ts` | None | [x] 🟢 |
| T2 | 先用既有库结构创建隔离库验证升级与事务回滚，再在现有 Store 增加 `run_audit` 和按 `runId/seq` 的存取、分页及最近上下文查询。使用现有 `tasks`、`runs`、`approvals` 的 JSON 记录，验证旧记录可读、原近期事件裁剪规则仍生效（D04，设计用例 T10 的存储检查，集成） | None | `src/server/store.ts`, `tests/platform.test.ts` | 高: 既有 SQLite 库结构与事务 | [x] 🟢 |

## 影响文件树

```text
x-mingting/
├── src/shared/protocol.ts M  # 公共记录与兼容字段
├── src/server/store.ts M  # 审计表和运行级存取
└── tests/platform.test.ts M  # 旧库、契约及事务集成检查
```

本任务交付共享结构与持久化接口。报文转译、业务写入和视图由各功能任务承接。设计用例 T10 的全量执行由 [task-run-metering/T5](../task-run-metering/dev-checklist.md#tasks) 负责。
