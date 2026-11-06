# task-run-tool-approval-audit · 实时过程与工具审批审计

> Spec [feat02](../../spec.md#feat02-查看运行过程和工具审批审计)
> 技术设计 [D01/D04](../../tech-design.md#audit)
> 测试用例 [T4 工具和审批](../../tech-design.md#t04) · [T5 重试隔离](../../tech-design.md#t05) · [T10 公共回归](../../tech-design.md#t10)
> 创建于 2026-11-05

**状态**　`[ ] ⏳` 未开始 / `[ ] ▶️` 进行中 / `[x] 🟢` 验证通过 / `[!] 🔴` 验证失败

<a id="tasks"></a>

| # | 任务 | 场景回指 | 涉及文件 | 风险 | 状态 |
|---|---|---|---|---|---|
| T1 | 先测工具更新、缺终态、超长内容和写入故障，再在现有报告事务按 `runId/sessionId/toolCallId` 归档工具补丁及摘要。保留现有实时正文、公开思考和工具投影，验证提交后发布 SSE（C1/C3/C5，D01/D04，设计用例 T4/T5/T10，集成） | feat02 场景1, 场景2, 场景3 | `src/server/service.ts`, `src/server/progress.ts`, `tests/streaming.test.ts` | 高: 审计写入、流式发布与回报顺序 | [x] 🟢 |
| T2 | 先测审批先于工具更新、拒绝选项、用户优先和订阅者窗口，再在原裁决事务记录 `resolvedAt`，查询时用运行、会话和工具调用关联原请求与决定（C3/C5，D04，设计用例 T4/T5，集成） | feat02 场景1, 场景2, 场景3 | `src/server/service.ts`, `tests/approvals.test.ts` | 高: 审批裁决持久化和并发决定 | [x] 🟢 |
| T3 | 先测旧运行翻页、跨任务访问及跨运行游标，再接通按运行审计查询和网页历史。展示原选项、最终决定、工具与任务各自状态、缺报和截断。验证同名工具跨运行隔离，近期流裁剪后仍可查（C1/C3/C5，D01/D04，设计用例 T4/T5，集成与浏览器 E2E） | feat02 场景1, 场景2, 场景3 | `src/server/http.ts`, `src/shared/protocol.ts`, `src/web/main.tsx`, `tests/platform.test.ts`, `tests/ui.spec.ts` | 高: 审计查询归属校验 | [x] 🟢 |
| T4 | 执行设计用例 T4/T5，核对真实审批服务的原选项回传、旧决定隔离及两次运行的审计页面和快照（C1/C3/C5，D04，集成与浏览器 E2E） | feat02 场景1, 场景2, 场景3 | 无源码改动 | None | [x] 🟢 |

## 影响文件树

```text
x-mingting/
├── src/
│   ├── server/
│   │   ├── service.ts M  # 工具更新与裁决事务
│   │   ├── progress.ts M  # 工具审计摘要和实时投影
│   │   └── http.ts M  # 按任务和运行查询审计
│   ├── shared/protocol.ts M  # 审计分页响应契约
│   └── web/main.tsx M  # 流式过程、工具及历史审批视图
└── tests/
    ├── streaming.test.ts M  # 工具与流式事务
    ├── approvals.test.ts M  # 原选项和审批裁决
    ├── platform.test.ts M  # 分页归属和重试隔离
    └── ui.spec.ts M  # 运行级工具及审批历史
```

T4 汇总设计用例 T4/T5 的证据。设计用例 T1 的真实工具及审批观察由 [真实任务验收](../task-codex-live-reconciliation/dev-checklist.md#tasks) 承接。T1 行的回滚观察并入最终设计用例 T10。
