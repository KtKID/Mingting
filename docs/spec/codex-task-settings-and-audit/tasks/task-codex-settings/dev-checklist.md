# task-codex-settings · 模型、思考档位与生效回执

> Spec [feat01](../../spec.md#feat01-设置-codex-任务的模型和思考档位)
> 技术设计 [D01/D02/D04](../../tech-design.md#settings)
> 测试用例 [T2 默认设置](../../tech-design.md#t02) · [T3 回执顺序](../../tech-design.md#t03) · [T10 公共回归](../../tech-design.md#t10)
> 创建于 2026-11-05

**状态**　`[ ] ⏳` 未开始 / `[ ] ▶️` 进行中 / `[x] 🟢` 验证通过 / `[!] 🔴` 验证失败

<a id="tasks"></a>

| # | 任务 | 场景回指 | 涉及文件 | 风险 | 状态 |
|---|---|---|---|---|---|
| T1 | 先测按模型发现档位及连接代次隔离，再实现临时 ACP 会话探测、连接器上报和现有 harness 查询投影。覆盖任务优先、无 prompt、断线失效、超限、错误身份和浏览器来源（C1，D01/D02，设计用例 T3/T10，集成） | feat01 场景1 | `src/shared/protocol.ts`, `src/server/codex-adapter.ts`, `src/server/codex-task-mapping.ts`, `src/connector/connector.ts`, `src/connector/transport.ts`, `src/server/service.ts`, `src/server/http.ts`, `tests/fake-acp.ts`, `tests/routing.test.ts` | 高: 新连接器入口的鉴权及探测与认领并发 | [x] 🟢 |
| T2 | 先测 Web 和 MCP 发布入口，再接通公共请求设置、Codex 目标校验和快照缺失时的发布行为。按现有任务记录保存请求，覆盖缺省、仅选档位、已知选项 ID 及重试沿用（C1/C3，D01/D02，设计用例 T2/T3，集成） | feat01 场景1, 场景2, 场景3 | `src/shared/protocol.ts`, `src/server/http.ts`, `src/server/service.ts`, `tests/platform.test.ts` | 高: 任务设置写入及旧请求兼容 | [x] 🟢 |
| T3 | 先测真实连接器线序、正式会话的设置回读和故障注入，再实现按模型、档位顺序设置及等待持久回执。覆盖默认、拒绝、回读不符、提交失败和确认丢失后的原序号重发。保留原 ACP 执行入口给独立唤醒调用（C1/C3，D02/D04，设计用例 T2/T3，集成） | feat01 场景1, 场景2, 场景3 | `src/server/codex-adapter.ts`, `src/server/codex-task-mapping.ts`, `src/connector/connector.ts`, `src/server/service.ts`, `tests/fake-acp.ts`, `tests/platform.test.ts` | 高: 回执持久化、重复报告与 prompt 发出顺序 | [x] 🟢 |
| T4 | 先测网页正常入口，再接通模型和对应档位选择、默认与快照缺失状态、同次运行的请求值和生效回执视图（C1/C3，D02，设计用例 T2/T3，浏览器 E2E） | feat01 场景1, 场景2, 场景3 | `src/web/main.tsx`, `tests/ui.spec.ts` | None | [x] 🟢 |
| T5 | 执行并汇总设计用例 T2/T3 的平台集成和浏览器证据，对照 ACP 请求顺序、回执行与实际 prompt 数量。真实回读与流式过程由独立验收任务执行（C1/C3，D01/D02/D04，设计用例 T2/T3，集成与浏览器 E2E） | feat01 场景1, 场景2, 场景3 | 无源码改动 | None | [x] 🟢 |

## 影响文件树

```text
x-mingting/
├── src/
│   ├── shared/protocol.ts M  # 设置、选项快照与报告边界
│   ├── connector/connector.ts M  # 空闲探测与回执提交确认
│   ├── connector/transport.ts M  # 订阅连接代次与建立回调
│   ├── server/
│   │   ├── codex-adapter.ts M  # 探测及正式会话设置流程
│   │   ├── codex-task-mapping.ts U  # Codex 私有选项与回读映射
│   │   ├── http.ts M  # 发布入口与能力上报
│   │   └── service.ts M  # 在线快照、发布与回执持久化
│   └── web/main.tsx M  # 设置表单与回执视图
└── tests/
    ├── fake-acp.ts M  # 分模型档位、回读及失败夹具
    ├── routing.test.ts M  # 能力上报与连接代次
    ├── platform.test.ts M  # 发布兼容与回执屏障
    └── ui.spec.ts M  # 正常入口与回执呈现
```

T5 汇总设计用例 T2/T3 的证据。设计用例 T1 对本 feat 的观察由 [真实任务验收](../task-codex-live-reconciliation/dev-checklist.md#tasks) 承接。T1 行的探测回归并入最终设计用例 T10。
