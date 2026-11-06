# task-run-metering · Usage、上下文与任务汇总

> Spec [feat03](../../spec.md#feat03-查看并对账任务消耗与上下文)
> 技术设计 [D03](../../tech-design.md#metering) · [D04](../../tech-design.md#audit)
> 测试用例 [T6 Usage 映射](../../tech-design.md#t06) · [T7 上下文](../../tech-design.md#t07) · [T8 缺项与取消](../../tech-design.md#t08) · [T9 汇总](../../tech-design.md#t09) · [T10 公共回归](../../tech-design.md#t10)
> 创建于 2026-11-05

**状态**　`[ ] ⏳` 未开始 / `[ ] ▶️` 进行中 / `[x] 🟢` 验证通过 / `[!] 🔴` 验证失败

<a id="tasks"></a>

| # | 任务 | 场景回指 | 涉及文件 | 风险 | 状态 |
|---|---|---|---|---|---|
| T1 | 先测 Codex 原始终态、quota 别名、上下文帧、目录窗口与异常字段，再在适配层转换成 `RunUsage` 和上下文观测。保留原总量、来源、明确零和不一致标记。核对缓存、思考及别名的计数口径，并为隔离验收准备设置回读、线序、终态及上下文的脱敏证据采集（C1/C2，D01/D03/D05，设计用例 T6/T7/T8，适配与集成） | feat03 场景1, 场景2, 场景3 | `src/server/codex-adapter.ts`, `src/server/codex-task-mapping.ts`, `tests/fake-acp.ts`, `tests/platform.test.ts` | None | [x] 🟢 |
| T2 | 先测错会话、旧租约、取消宽限、终态失败回滚及重复或迟到报告，再在连接器和服务接通计量。上下文按 seq 追加，最终 Usage 和运行、任务、审批收口同一事务；取消只接受宽限内原 prompt 的已确认用量（C2/C3，D03/D04，设计用例 T6/T7/T8/T9/T10，集成） | feat03 场景1, 场景2, 场景3, 场景4 | `src/connector/connector.ts`, `src/server/codex-adapter.ts`, `src/server/http.ts`, `src/server/service.ts`, `tests/fake-acp.ts`, `tests/platform.test.ts`, `tests/streaming.test.ts` | 高: 终态事务、序号、取消与迟到回包 | [x] 🟢 |
| T3 | 先测重试、重复读取、缺项及安全整数边界，再从已结束运行按指标和相同口径推导任务汇总。验证每个 run 一笔消耗、历史结果独立、仅已知分项计入对应汇总（C2/C3，D03/D04，设计用例 T8/T9，集成） | feat03 场景3, 场景4 | `src/server/store.ts`, `src/shared/protocol.ts`, `tests/platform.test.ts` | None | [x] 🟢 |
| T4 | 先测浏览器与 SSE，再接入同次运行的最新及历史上下文、有效与标称窗口、最终 Usage、来源和任务汇总。对照同一回合消耗与占用下降的页面证据（C1/C2/C3，D03/D04，设计用例 T6/T7/T8/T9，集成与浏览器 E2E） | feat03 场景1, 场景2, 场景3, 场景4 | `src/web/main.tsx`, `tests/ui.spec.ts` | None | [x] 🟢 |
| T5 | 执行设计用例 T6–T9 并汇总各层证据。统一执行 T10，复查探测、事务与序号回滚、公共层导入边界和 Grok/ZCode、审批、聊天唤醒回归，同时检查 strict tsc 与改动范围格式（C1/C2/C3/C5，D01/D03/D04，集成、浏览器 E2E 与审查） | feat03 场景1, 场景2, 场景3, 场景4 | 无源码改动 | None | [x] 🟢 |

## 影响文件树

```text
x-mingting/
├── src/
│   ├── shared/protocol.ts M  # 公共计量与任务汇总视图
│   ├── connector/connector.ts M  # 有序回传与终态计量
│   ├── server/
│   │   ├── codex-adapter.ts M  # 主回合回包、上下文、取消宽限与验收取证
│   │   ├── codex-task-mapping.ts M  # 扩展校验和数值、目录来源映射
│   │   ├── http.ts M  # 重连后的领取代次校验
│   │   ├── service.ts M  # 上下文、终态提交与领取代次
│   │   └── store.ts M  # 由已结束运行推导同口径汇总
│   └── web/main.tsx M  # 实时上下文、运行消耗和任务汇总
└── tests/
    ├── fake-acp.ts M  # 原回包、上下文及取消夹具
    ├── platform.test.ts M  # 事务、计量口径和任务汇总
    ├── streaming.test.ts M  # 上下文帧与 SSE
    └── ui.spec.ts M  # 缺项、历史上下文与汇总展示
```

T5 是设计用例 T6–T10 的执行和汇总责任行。T10 收录前置任务的契约、旧库、能力探测及工具审计回滚观察，基于本阶段同一版本统一回归。设计用例 T1 的真实指标核对由 [真实任务验收](../task-codex-live-reconciliation/dev-checklist.md#tasks) 承接。
