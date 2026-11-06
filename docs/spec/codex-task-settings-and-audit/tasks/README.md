# Codex 任务设置与审计 · 开发与验收顺序

**[查看完整测试用例 T1–T10](../tech-design.md#test-cases)**。每条用例列出输入、执行步骤、预期结果和证据位置。测试代码在 `x-dev` 按清单编写，执行结果进入当批测试报告。

- [Spec](../spec.md) 已确认，SHA-256 `c8c57813315cd04de932aaa97959c99572f7e72bc2cfd9ec7f870cf870876680`。
- [技术设计 v0.2](../tech-design.md) 已确认，确认时的 SHA-256 为 `00b7ecb3c760f141266d3c0c203045079ab9a67c6609574cf03e8f0a212f42b5`。现文档的用例已按步骤展开，沿用确认版的技术决策、用例编号和验收口径。
- 每个自动化实现行先落测试，再确认新增断言因预期原因失败。独立验收行使用前置实现的可运行版本取证。开发及真实验收已执行，实际结果见[本次统一测试报告](../../../../reports/codex-task-settings-and-audit/20261105-delivery/test-report.md)。

| 顺序 | 开发清单 | 功能归属 | 行数 | 高风险行 |
|---|---|---|---:|---|
| A | [运行归属与存储底座](task-run-audit-foundation/dev-checklist.md) | 公共契约、现有 SQLite 与 `runId` | 2 | T2 |
| B | [模型、档位与生效回执](task-codex-settings/dev-checklist.md) | feat01 | 5 | T1–T3 |
| C | [实时过程与工具审批审计](task-run-tool-approval-audit/dev-checklist.md) | feat02 | 4 | T1–T3 |
| D | [Usage、上下文与任务汇总](task-run-metering/dev-checklist.md) | feat03 | 5 | T2 |
| E | [真实任务流式验收与用量对账](task-codex-live-reconciliation/dev-checklist.md) | 跨 feat 验收 | 3 | T1–T2 |

从 A 到 E 依次交给 `x-dev`。先建立公共契约与运行级存储，再接通设置和审计。D 在同一交付版本上完成计量集成及兼容回归。E 使用前四项的交付版本实跑。每项交付的 `dev-report.md` 链接本项本批唯一的 `test-report.md`，位于设计约定的 `reports/codex-task-settings-and-audit/<batch-id>/`。批次标识带 task 名以区分各项，原始证据放同批 `evidence/`。

## 场景、用例与执行责任

下表的 `T1–T10` 指技术设计用例。`A/T2` 等指上表任务及其清单行。开发和验收共享用例时，执行责任以此表为准。每条场景仅归属一个开发任务，E 承接跨任务的真实观察。

| Spec 场景 | 全部承接用例 → 责任行 |
|---|---|
| feat01 场景1 | [T1](../tech-design.md#t01) → E/T1–T3；[T3](../tech-design.md#t03) → B/T5，B/T1–T4 提供证据 |
| feat01 场景2 | [T2](../tech-design.md#t02) → B/T5，B/T2–T4 提供证据 |
| feat01 场景3 | [T3](../tech-design.md#t03) → B/T5，B/T2–T4 提供证据 |
| feat02 场景1 | [T1](../tech-design.md#t01) → E/T2–T3；[T4](../tech-design.md#t04) → C/T4，C/T1–T3 提供证据 |
| feat02 场景2 | [T4](../tech-design.md#t04) → C/T4，C/T1–T3 提供证据 |
| feat02 场景3 | [T5](../tech-design.md#t05) → C/T4，C/T1–T3 提供证据 |
| feat03 场景1 | [T1](../tech-design.md#t01) → E/T1–T3；[T6](../tech-design.md#t06) → D/T5，D/T1–T2、T4 提供证据 |
| feat03 场景2 | [T7](../tech-design.md#t07) → D/T5，D/T1–T2、T4 提供证据 |
| feat03 场景3 | [T8](../tech-design.md#t08) → D/T5，D/T1–T4 提供证据 |
| feat03 场景4 | [T9](../tech-design.md#t09) → D/T5，D/T2–T4 提供证据 |
| 公共技术回归 | [T10](../tech-design.md#t10) → D/T5；A/T1–T2、B/T1、C/T1、D/T2 承接各自检查 |

## 关键约束覆盖

| Spec 约束 | 技术设计 | 用例 → 责任行 |
|---|---|---|
| C1 明庭公共管理与适配边界 | D01/D02/D04 | T1 → E/T1–T3；T2/T3 → B/T5；T4/T5 → C/T4；T8/T9/T10 → D/T5 |
| C2 Usage 与上下文口径独立 | D03/D04 | T1 → E/T1–T3；T6–T9 → D/T5 |
| C3 同次运行归属与重试隔离 | D02/D04 | T1 → E/T1–T3；T2/T3 → B/T5；T4/T5 → C/T4；T8/T9/T10 → D/T5 |
| C4 真实任务验收 | D05 | T1 → E/T1–T3 |
| C5 工作区、审批和取消边界 | D04 | T1 → E/T1–T3；T3 → B/T5；T4/T5 → C/T4；T8/T9/T10 → D/T5 |
