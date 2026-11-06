# task-dsh-wakeups · 开发交付记录

开发清单与本次测试报告分别记录任务状态和实际证据。2026-11-06。[开发清单](dev-checklist.md) · [统一测试报告](../../../../../reports/task-dsh-wakeups/20261106-v1/test-report.md)

## 本次结果

- 开发清单 3 行通过。发布会话绑定、同事件去重和正式连接已验证。正式明庭复验中，两个已有会话的任务各运行一次，各自开启一轮，串投为零。[正式复验与截图](../../../../../reports/task-dsh-wakeups/20261106-v2/test-report.md)
- 明庭回归 116 项通过。孔明包回归 44 项通过、1 项失败、1 项跳过。[用例明细](../../../../../reports/task-dsh-wakeups/20261106-v1/test-report.md#用例明细)
- 已采集改动行覆盖率 95.5%，相关分支覆盖率 79.6%。服务启动入口用正式连接探测验证，未计入自动覆盖率。[覆盖率与缺口](../../../../../reports/task-dsh-wakeups/20261106-v1/test-report.md#改动覆盖率)
- 本轮执行了 x-req 与 x-dev。独立交付对账、技术验收和 QA 未执行。

## 未决与交付状态

- T3 · 首批 A 的 ZCode 授权故障已通过更新同账号的项目登录副本解决。第二批在正式明庭使用两条独立新任务验收，结果已通过。[首批明细](../../../../../reports/task-dsh-wakeups/20261106-v1/test-report.md#用例明细) · [正式复验](../../../../../reports/task-dsh-wakeups/20261106-v2/test-report.md)
- O03 · 孔明已有的冻结记忆恢复用例在独立执行时同样失败，测试进程未加载本次明庭插件。[旧用例独跑](../../../../../reports/task-dsh-wakeups/20261106-v1/evidence/kongming-optional-memory-baseline.log)
