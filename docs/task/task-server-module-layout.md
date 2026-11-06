# 服务端脚本分组迁移

> 归属 [服务端源码布局](../../README.md#服务端源码布局)
> 比较基线 `main@f343948`，切换并快进后工作树干净
> 方案与用例基线见本页②③
> 日期 2026-11-06
> 状态 已完成

## ① 需求与变更

用户确认目录树，授权切换到 `main`、分两批迁移、更新引用和运行 `npm test`。本次调整源码位置，保留启动入口、路由、任务事务、数据和协议定义。变更索引见 [服务端源码布局](../../README.md#服务端源码布局)。

## ② 精简技术设计

- D1 先迁移 `harness/` 的 15 个脚本，同步连接器、测试和脚本引用。ZCode 账号校验继续以模块位置定位仓库根目录。
- D2 再迁移 `transport/`、`tasks/`、`storage/`、`wakeup/` 的 8 个脚本，同步审批回归的文件哈希清单。`main.ts` 保留根目录。
- R1、R5 按目录职责移动，保留文件名、导出名及依赖关系。R2–R4、R6、R7 沿用现有协议、配置、持久化和状态流程。

## ③ 测试用例与变化

| 编号 | 类型 | 检查与预期 |
| --- | --- | --- |
| T1 | 路径检查 | 两批目的地匹配确认的目录树，引用可解析，ZCode 路径边界仍生效（D1、D2） |
| T2 | 沿用回归 | `npm test` 完成后端、构建、桌面和移动网页以及审批回放四阶段（D1、D2） |

沿用既有自动化用例，更新导入，保留用例预期和断言。

## ④ 技术实现

- 第一批将 15 个脚本移入 `harness/`。[`readProjectJson()`](../../src/server/harness/zcode/zcode-account.ts#L73) 根据新目录深度定位原仓库根目录，再校验 ZCode 账户文件的实体路径。
- 第二批将 8 个脚本移入 `transport/`、`tasks/`、`storage/`、`wakeup/`。[`freezeApprovalInputs()`](../../scripts/approval-archive.ts#L145) 按新路径读取任务服务和 HTTP 源码并归档哈希。
- 更新 `main.ts`、连接器、执行及回归脚本、测试导入和当前技术设计中的源码引用。[源码差异与文件清单](../../reports/server-module-layout/20261106/evidence/source-diff.patch)。

## ⑤ 验证结果

[测试报告](../../reports/server-module-layout/20261106/test-report.md) 汇总路径检查、回归和覆盖证据。

- T1 路径核对、TypeScript、Prettier 和 ZCode 专项通过。
- T2 完整 `npm test` 退出 0，后端 118/118、网页 20/20、审批回放 10/10，构建通过。
- 变更索引、交付对账与技术验收已核对。
