# CI 测试与报告

GitHub Actions 在 PR 和 main 更新后执行后端测试、构建与十项审批回归。GitHub 显示检查状态。详细报告和原始证据通过本机运行保存。

默认审批回归使用仓库中的合成数据。原始录制可以通过 `APPROVAL_RECORDING_PATH` 指向本机文件。

## 本机运行

- `npm run test:ci:unit` 生成逐例结果和源码覆盖率。
- `CI_REPORT_DIR=reports/ci npm run test:ci:approval` 执行审批回归。
- `npm run test:ci:report` 根据 Git 基线、阶段状态、JUnit 和覆盖率输入生成 `reports/ci/test-report.md`。
- 审批操作记录与截图位于 `reports/approval-e2e/runs/`。这些目录作为本机归档保留。

覆盖率由 c8 采集。diff-cover 对比提交基线和被测版本的改动行。测试、构建或报告资料缺失会使检查失败。
