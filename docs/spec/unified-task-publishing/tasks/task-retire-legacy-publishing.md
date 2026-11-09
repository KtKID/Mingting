# 通过唯一 MCP 入口发布和续接任务

> 归属 [统一发布 feat01 场景 2、3](../spec.md#feat01-用统一规则发布任务并取得回执)
> 创建 2026-11-08 · 明庭隔离验证通过

## ① 需求与变更

用户确认仅改明庭，先退役两条独立发布接口。所有新建与续接统一调用 `/mcp` 的 `mcp-mingting-tool`。网页继续提供发布表单，宿主继续收取并确认已有任务通知。唤醒模型通用化独立安排。修改前版本为 `1419b8c:docs/spec/unified-task-publishing/spec.md`，工作区基线及并行改动见[附件](../../../../reports/retire-legacy-publishing/20261108-01/evidence/baseline.txt)。

## ② 精简技术设计

- D1 · 退役 `POST /wakeup-host/publish` 和 `POST /api/tasks`，删除 DSH 专用发布实现。沿用 MCP 的 `new`、`append`、事务和宿主去重记录。
- D2 · 网页通过同源 MCP 发单。网页路由把带浏览器来源标记的 MCP POST 交给同一会话和 CSRF 校验，随后转交 MCP 路由。客户端解析 MCP 回执并打开对应详情。
- D3 · 宿主流、确认及历史数据沿用原契约。D1、D2 复用 MCP 与 Zod 协议边界和现有数据写入服务。跨语言生成、配置与数据迁移在本次差异之外。

## ③ 测试用例与变化

- T1 · 修改旧 DSH 发单用例，校验旧接口返回 404 且任务数不变。装入已受理旧任务夹具，继续验证网页审批、补投和确认。
- T2 · 修改网页发布与安全用例，验证旧网页接口返回 404、同源 MCP 需要会话和 CSRF、普通 MCP 发单仍可用，页面表单可执行并打开详情。
- T3 · 沿用普通和已认证宿主 MCP 发布、重试回执、多轮追加、审批和结果订阅回归。

## ④ 技术实现

- [宿主路由](../../../../src/server/transport/dsh-wakeup.ts)、[任务服务](../../../../src/server/tasks/service.ts)、[发布逻辑](../../../../src/server/tasks/publication.ts)与[共享契约](../../../../src/shared/dsh-wakeup.ts)删除旧 DSH 建单处理和专用输入输出。现有 `publishCommand` 按动作选择新建或追加。
- [网页路由](../../../../src/server/transport/browser-api/router.ts)移除网页独立建单处理，并在 MCP 请求来自网页时复用已有会话校验。[网页表单的 publish](../../../../src/web/main.tsx#L413)调用 MCP、解析回执并打开任务详情。
- 更新 DSH、平台和浏览器用例。并行修改涉及宿主事件流、MCP 审批等待及平台测试，合并时按不同代码段保留。

## ⑤ 验证结果

74 项相关回归、10 项桌面浏览器用例、构建和格式检查通过。专项 5 项复跑通过。需求对账与技术行为检查通过，改动行覆盖证据有缺项。[测试报告与截图](../../../../reports/retire-legacy-publishing/20261108-01/test-report.md)
