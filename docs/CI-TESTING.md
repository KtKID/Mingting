# CI 测试与报告

每次 pull request、main 更新及手动运行，GitHub Actions 执行后端单元测试、TypeScript/Vite 构建与现有十项审批浏览器回归。统一报告展示逐条用例、当次新增/修改行覆盖率、未覆盖位置与整文件分支指标；原始证据随 Actions 运行归档。

测试使用仓库的隔离夹具和临时 SQLite，真实聊天/模型验收继续按各功能文档执行。用例预期与操作以测试源码和审批场景定义为主定义。

## 产物与验收

`reports/ci/test-report.md` 是本轮阅读入口。`evidence/` 集中保存 JUnit、coverage 原生数据、各阶段输出与审批回放附件；同一份报告发布到 Actions Summary，JUnit 同时发布到 PR Checks。Artifacts 按 commit、run、attempt 识别，保存 30 天；重要验收可下载归档。

覆盖率由 c8 采集 `src/` 与 `scripts/` 的 TS/TSX，diff-cover 根据 PR base 与被测 head 比较改动行。分支指标注明整文件范围，浏览器客户端覆盖和真实模型验收另列边界。测试、构建、报告资料完整性失败都会使 CI 失败；覆盖率门槛按项目约定配置，试点先收集实际基线。

## Changelog

| 日期       | 变化                                        | 任务                                 | 状态   |
| ---------- | ------------------------------------------- | ------------------------------------ | ------ |
| 2026-11-03 | Actions、用例结果、改动覆盖率与统一报告试点 | [任务](task/task-ci-test-reports.md) | 开发中 |
