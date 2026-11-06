# 真实 ACP 运行离线回放

[功能归属](../HARNESS-SUBSCRIPTIONS.md#离线回归)

## ① 需求与变更

把已保存的真实任务验收数据转成可随仓库运行的离线回归输入。涵盖 Codex、Grok、ZCode 和 DeepSeek，原始记录另存于各次验收报告。

## ② 精简技术设计

沿用多执行器的 D1–D3。将原始计量字段、可观测上下文、工具和审批从证据中按字段提取，按记录重建 ACP 帧。用本地测试子进程替代执行器，经真实明庭连接器、适配映射、HTTP 和 SQLite 回放，使用新会话和运行 ID。测试文件自动纳入默认后端回归。

## ③ 测试用例与变化

新增五条真实记录回放。Codex、ZCode 核对原审批选项和工具归属。Grok 核对费用及模型目录窗口。DeepSeek 以 low/high 两条原生日志核对总量与缺报。各用例核对发布设置、流式正文、计量与运行审计。补充一次计量篡改检查及静态与默认入口复核。

## ④ 技术实现

新增 `tests/fixtures/acp-run-recordings.json`、夹具加载与 ACP 子进程，以及 `tests/acp-offline-replay.test.ts`。沿用现有后端测试文件发现规则。

## ⑤ 验证结果

五条离线用例全部通过。默认后端 114 项通过，计量篡改按预期失败。交付对账和技术复核通过。 [统一测试报告](../../reports/acp-offline-replay/20261106/test-report.md)
