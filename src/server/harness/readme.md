# Harness 执行入口

> 草稿，待用户检查。

## 功能描述

Harness 指接手任务的本地执行器。这个目录根据连接器身份选择 Codex、Grok、ZCode 或 DeepSeek，准备工作目录与进程环境，并把各执行器的回报转成明庭能保存的数据。

## 设计理念

四种执行器通过共同的 ACP 执行流程接入。ACP 是连接器和执行器之间交换消息的协议。执行器各自保留进程参数、账号隔离规则和用量口径。账号副本和运行状态使用项目内目录，便于把明庭执行与日常工具环境分开。 [执行与部署](../../../docs/HARNESS-SUBSCRIPTIONS.md#h3-执行) · [多执行器接入记录](../../../docs/task/task-multi-harness-acp.md)

## 使用方式

[连接器入口](../../connector/main.ts) 调用 `runtime()` 得到 `workspace`、`adapter`、`mode` 和 `harnessName`。按 [部署指南](../../../docs/HARNESS-SUBSCRIPTIONS.md#h4-部署) 准备环境后，通过 `TASK_HARNESS` 选择连接器身份。用 `FAKE_ACP=1` 可以运行项目自带的测试执行器，成功后连接器会登记并领取对应任务。

## 代码说明

- [runtime.ts](runtime.ts) 的 [runtime()](runtime.ts#L13) 校验工作目录、认证方式和执行器名称，按身份组合命令、环境和数据映射。显式选择假执行器时运行测试脚本，真实模式按身份使用项目内的运行配置。
- [local-path.ts](local-path.ts) 的 [projectPath(value)](local-path.ts#L5) 逐级检查候选路径，拒绝项目外路径和符号链接。[projectDirectory(value)](local-path.ts#L24) 通过检查后创建目录并返回路径。准备脚本和运行配置使用同一边界。
- [cli-adapter.ts](cli-adapter.ts) 的 [CliAdapter.execute(text, signal, hooks)](cli-adapter.ts#L32) 启动一次性 CLI，限制时间和输出大小，退出后校验最终 JSON，再上报会话与结果。当前默认运行入口使用 ACP，此适配器的独立调用有 [测试](../../../tests/cli-adapter.test.ts)。
- [grok-acp-mapping.ts](grok-acp-mapping.ts) 的 [grokTelemetry](grok-acp-mapping.ts#L20) 分别用 `usage()` 读取终态用量，`modelWindow()` 读取模型目录窗口，`context()` 读取上下文占用。来源和口径分别保留，缺少的分项保留未知。
- [deepseek-acp-mapping.ts](deepseek-acp-mapping.ts) 的 [deepseekTelemetry(home, workspace)](deepseek-acp-mapping.ts#L164) 在终态回包缺用量时尝试读取同一会话的本地记录。[mapDeepSeekLog(text, missing, workspace)](deepseek-acp-mapping.ts#L44) 只接受能匹配工作目录、会话及单个完整回合的记录。缺失或无法确认时保留未上报状态。

共用实现和执行器细节见 [ACP](acp/readme.md)、[Codex](codex/readme.md) 和 [ZCode](zcode/readme.md)。

## spec 索引

| Spec 或功能记录                                                              | 与模块的关系                                                                                                                                                                |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Codex 设置和计量](../../../docs/spec/codex-task-settings-and-audit/spec.md) | 连接器的适配器在此选定，随后按共同流程回读设置和采集用量。[技术设计](../../../docs/spec/codex-task-settings-and-audit/tech-design.md)                                       |
| [Harness 订阅与执行 H1–H5](../../../docs/HARNESS-SUBSCRIPTIONS.md)           | Grok、ZCode、DeepSeek 和 Codex 运行选择的功能记录。[多执行器接入](../../../docs/task/task-multi-harness-acp.md) · [离线回放](../../../docs/task/task-acp-offline-replay.md) |
