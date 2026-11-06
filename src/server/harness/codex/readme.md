# Codex 执行映射

> 草稿，待用户检查。

## 功能描述

这里为 Codex 装配共用执行流程，并将 Codex 回报的用量和模型窗口转成明庭的记录格式。

## 设计理念

任务用量以主回合回包为准。模型标称窗口单独保存来源，方便和实际会话占用区分。字段缺失时保留未知，有口径差异的指标各自标注。 [用量与上下文口径](../../../../docs/spec/codex-task-settings-and-audit/tech-design.md#metering)

## 使用方式

正常连接器通过 [runtime()](../runtime.ts#L13) 创建 Codex 适配器。接入侧可用 `new CodexAdapter(config)` 提供进程命令、工作目录和环境，再调用 [共用执行方法](../acp/readme.md#使用方式)。真实运行前按 [Codex 接入指南](../../../../README.md#真实-codex-acp) 准备账号副本和工作目录。

## 代码说明

- [codex-adapter.ts](codex-adapter.ts) 的 [CodexAdapter](codex-adapter.ts#L10) 给共用 `AcpAdapter` 装上 Codex 用量和窗口映射。进程、会话和审批由共用代码负责，Codex 专有字段集中在映射文件。
- [codex-task-mapping.ts](codex-task-mapping.ts) 的 [codexUsage()](codex-task-mapping.ts#L16) 从主回合 `result.usage` 读取有效分项，返回标准化用量和可核对字段。只有 quota 别名时会标明用量缺失。[codexModelWindow()](codex-task-mapping.ts#L62) 返回源码中登记的 `gpt-6.1-sol` 标称窗口及日期和来源，其他模型返回未知。

## spec 索引

| Spec                                                                                                                    | 与模块的关系                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Codex 任务消耗与上下文](../../../../docs/spec/codex-task-settings-and-audit/spec.md#feat03-查看并对账任务消耗与上下文) | Codex 终态用量与模型窗口映射。运行中的上下文观测走共用适配器。[本期 Codex 映射](../../../../docs/spec/codex-task-settings-and-audit/tech-design.md#本期-codex-映射) |
