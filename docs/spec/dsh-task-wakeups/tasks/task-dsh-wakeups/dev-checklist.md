# task-dsh-wakeups · 开发清单

> spec: docs/spec/dsh-task-wakeups/spec.md  
> tech-design: docs/spec/dsh-task-wakeups/tech-design.md  
> 创建: 2026-11-06

| #   | 任务                                                                                                             | 场景回指                                               | 涉及文件                                                                                                                                              | 风险                             | 状态   |
| --- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------ |
| T1  | 先测后实现宿主鉴权发布、持久绑定、完成流及确认，回归旧投递和审批（C1–C3，D01–D03，用例 T2–T5，HTTP 集成）        | feat01 场景1, feat01 场景2, feat02 场景2, feat02 场景3 | `src/shared/{task-wakeup,dsh-wakeup,protocol}.ts`, `src/server/{http,service,store,dsh-wakeup}.ts`, `tests/dsh-wakeup.test.ts`                        | 高: 新鉴权与持久状态             | [x] 🟢 |
| T2  | 先测后实现孔明宿主插件、真实调用上下文绑定和原会话去重入队，校验跨仓契约（C1–C3，D01–D03，用例 T2–T5，宿主集成） | feat01 场景1, feat01 场景2, feat02 场景2, feat02 场景3 | `scripts/sync-dsh-wakeup-contract.mjs`, Kongming `packages/kmh-kongming/{package.json,cordis.patch.yml,README.md,src/mingting*.ts,test/mingting*.ts}` | 高: 任务发起权限与会话身份       | [x] 🟢 |
| T3  | 运行双会话逆序完成验收，检查生产配置就绪并移除固定编号入口（C1–C3，D02、D04，用例 T1、T5，真实 Web E2E）         | feat01 场景1, feat02 场景1                             | `.env.example`, `src/server/{main,kongming-wakeup}.ts`, `docs/CHAT-WAKEUPS.md`                                                                        | 高: 原会话自动触发与本机配置切换 | [x] 🟢 |

T3 已在正式明庭复验。沿用原孔明与已有测试会话，两条任务首次运行均成功，各自触发一轮，串投为零。[复验证据](../../../../../reports/task-dsh-wakeups/20261106-v2/test-report.md)

## 影响文件树

```text
x-mingting/
├── .env.example                      M  # 宿主连接配置
├── docs/CHAT-WAKEUPS.md               M  # 启用方式及验收入口
├── scripts/sync-dsh-wakeup-contract.mjs U # 生成并检查宿主消费契约
├── src/shared/protocol.ts             M  # 复用任务字段定义
├── src/shared/task-wakeup.ts          M  # 关联宿主契约及既有格式
├── src/shared/dsh-wakeup.ts           U  # DSH 边界契约
├── src/server/http.ts                M  # 挂载本机宿主路由
├── src/server/service.ts             M  # 鉴权后进入任务发布事务
├── src/server/store.ts               M  # 持久绑定、待收事件与确认
├── src/server/dsh-wakeup.ts           U  # 宿主事件流与鉴权
├── src/server/main.ts                 M  # 宿主配置和服务启动
├── src/server/kongming-wakeup.ts      D  # 固定孔明会话启动日志适配器
└── tests/dsh-wakeup.test.ts           U  # 宿主 HTTP 端到端测试
kongming-os/
└── packages/kmh-kongming/
    ├── package.json / cordis.patch.yml M  # 暴露独立插件入口
    ├── README.md                       M  # 配置与操作
    ├── src/mingting*.ts                 U  # 生成的契约、工具与宿主事件接收
    └── test/mingting*.ts                U  # 宿主插件测试
```
