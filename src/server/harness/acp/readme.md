# 共用 ACP 执行

> 草稿，待用户检查。

## 功能描述

ACP 是明庭和执行器交换会话、输出及审批消息的协议。这个目录负责启动执行器、打开或恢复会话、提交任务，以及把运行回报交给连接器。

## 设计理念

共用流程负责会话、审批、取消和进程清理。各执行器提供自己的用量映射。任务要求指定模型或思考档位时，先读回实际设置，并等待连接器确认回执已保存，再提交任务文本。这样运行结果可以和实际生效的设置对应起来。 [设置回执与提交顺序](../../../../docs/spec/codex-task-settings-and-audit/tech-design.md#settings)

## 使用方式

执行器接入通过 [runtime()](../runtime.ts#L13) 构造适配器。连接器调用 `adapter.executeTask(text, signal, hooks, settings, acknowledge)`，通过 `hooks` 接收会话、进度与审批请求，最终取得结束原因和可用的用量。需使用已知会话时走 `execute()` 的会话 ID 参数。离线回归见 [录制回放测试](../../../../tests/acp-offline-replay.test.ts)。

### 运行诊断

本机服务日志按 `runId` 查找 `acp.request.started`、`acp.request.finished` 和 `acp.cleanup.finished`。每次请求记录 ACP 方法、连接内序号、预算、耗时和结果。进程收尾单独记录耗时及退出码或信号。空闲能力探测只有 ACP 进程编号，实际任务还带任务 ID 和轮次。日志字段限于执行元数据，执行器的原始错误流继续直接排空。

需要拆分 Codex 内部耗时时，用独立 Codex 状态目录和测试进程采集 `thread/start` 的请求、回复及 app-server 各阶段的开始与结束。Codex 0.165.0 支持通过 `LOG_FORMAT=json` 和定向 `RUST_LOG` 输出阶段日志。ACP 自带的 `APP_SERVER_LOGS` 会记录原始消息，仅用于受限隔离探测，探测止于会话创建。常驻服务使用上面的元数据日志。

## 代码说明

### [acp-adapter.ts](acp-adapter.ts)

`AcpAdapter` 通过标准输入输出与执行器进程交换消息，并限制协议请求耗时及消息大小。执行器退出、取消或回包异常时，会按情况停止任务并清理子进程。

| 方法                                                                              | 处理过程与结果                                                                                                     |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [execute()](acp-adapter.ts#L104)、[run()](acp-adapter.ts#L277)                    | 启动并握手，按配置认证，创建或加载会话，再发送任务文本。流式更新和权限请求回调给调用方，结束后返回原因并清理进程。 |
| [executeTask()](acp-adapter.ts#L112)                                              | 在正式任务前应用设置并等待回执，结束时用执行器映射提取用量。正常结束而用量缺失时，可调用执行器提供的补读逻辑。     |
| [probeSession()](acp-adapter.ts#L222)、[probeCapabilities()](acp-adapter.ts#L240) | 前者验证指定会话可加载并返回握手信息，后者探测各模型可选档位。探测只读配置或切换测试会话的模型。                   |
| [withEvidence()](acp-adapter.ts#L93)                                              | 返回带记录回调的适配器，便于收集回读和终态的诊断证据。                                                             |

### 其他文件

- [acp-settings.ts](acp-settings.ts) 的 [selectOption()](acp-settings.ts#L4) 和 [choices()](acp-settings.ts#L12) 从会话配置读取选项并展开分组。[applySettings()](acp-settings.ts#L23) 先设模型，再用该模型提供的选项设档位，读回不符时终止。
- [acp-usage.ts](acp-usage.ts) 的 [normalizeUsage()](acp-usage.ts#L7) 接收计数字段和来源，标记完整、部分或缺失，并检查总量和分项是否冲突。保留明确回报的零值和未知值，便于对账。
- [acp-validation.ts](acp-validation.ts) 的 [validateAcp()](acp-validation.ts#L8) 使用 SDK 提供的 ACP 消息定义校验初始化回包、会话通知和审批请求。按消息类型复用已编译的校验规则，供任务服务与离线回放调用。

## spec 索引

| Spec 或功能记录                                                                 | 与模块的关系                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Codex 设置与审计](../../../../docs/spec/codex-task-settings-and-audit/spec.md) | 定义选项回读、审批、用量与上下文的交付约束。[设置设计](../../../../docs/spec/codex-task-settings-and-audit/tech-design.md#settings) · [用量设计](../../../../docs/spec/codex-task-settings-and-audit/tech-design.md#metering) |
| [Harness 执行 H3](../../../../docs/HARNESS-SUBSCRIPTIONS.md#h3-执行)            | 四种执行器的共用流程在此实现，各自计量规则由映射提供。[多执行器任务](../../../../docs/spec/harness-subscriptions/tasks/task-multi-harness-acp.md)                                                                                                         |
