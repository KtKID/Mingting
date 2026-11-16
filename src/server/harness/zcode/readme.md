# ZCode 执行桥接

> 草稿，待用户检查。

## 功能描述

明庭通过桥接脚本运行 ZCode 原生进程。这个目录负责项目账号、进程通信、审批与进度转换，以及原生回报的用量映射。

## 设计理念

原生审批选项保留原 ID 和响应内容，明庭用户选中的决定可以准确交还给 ZCode。账户和模型设置使用项目内副本，短期凭据仅保留在内存。各处先核对会话或账号身份再处理请求，避免把另一轮审批或凭据串到当前运行。 [多执行器设计](../../../../docs/spec/harness-subscriptions/tasks/task-multi-harness-acp.md) · [账号绑定记录](../../../../docs/spec/harness-subscriptions/tasks/task-zcode-model-selection.md)

## 使用方式

按 [本机部署指南](../../../../docs/HARNESS-SUBSCRIPTIONS.md#使用本机部署) 准备 ZCode CLI、项目内账号和模型配置。以 ZCode 身份启动连接器后，[runtime()](../runtime.ts#L13) 会启动 [桥接脚本](../../../../scripts/zcode-acp.ts)。用明庭发一笔定向给 ZCode 的任务后，可以在详情看到执行身份、流式输出及收到的审批。离线验证见 [桥接测试](../../../../tests/zcode-bridge.test.ts) 和 [原生审批测试](../../../../tests/zcode-approval.test.ts)。

## 代码说明

- [zcode-native.ts](zcode-native.ts) 的 [ZcodeNative](zcode-native.ts#L130) 启动 `zcode app-server --stdio`，按请求 ID 配对结果。[request()](zcode-native.ts#L180) 发起有时限的请求，[receive()](zcode-native.ts#L225) 分发事件，并让读取循环在等待人审时继续工作。[mapZcodePermission()](zcode-native.ts#L51) 核对会话，转换允许和拒绝选项，保留每个选项的原始响应。进程异常或 [close()](zcode-native.ts#L275) 时，等待中的请求会收到失败。
- [zcode-account.ts](zcode-account.ts) 的 [loadZcodeAccount()](zcode-account.ts#L117) 加载项目模型配置和现有 BigModel OAuth Coding Plan 账号，给桥接器返回选模信息和请求期凭据入口。[readProjectJson()](zcode-account.ts#L73) 只接受项目内实体路径，[decryptZcodeCredential()](zcode-account.ts#L89) 解开凭据记录。[headers()](zcode-account.ts#L299) 按会话和账号身份获取短期凭据，并合并并发刷新。
- [zcode-stream.ts](zcode-stream.ts) 的 [translateZcodeLine(value, sessionId)](zcode-stream.ts#L26) 将原生正文、公开思考、工具状态、审批拒绝和最终结果转换为 ACP 更新或终态。无法识别的事件类型略过，已知事件缺必要字段时报告错误。
- [zcode-acp-mapping.ts](zcode-acp-mapping.ts) 的 [zcodeTelemetry.usage()](zcode-acp-mapping.ts#L30) 从桥接回包提取任务用量，标出计量来源、缺项与冲突。[modelWindow()](zcode-acp-mapping.ts#L67) 单独读取原生模型目录里的窗口，缺值时返回未知。

## spec 索引

| Spec 或功能记录                                                                                                         | 与模块的关系                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Harness 执行 H3](../../../../docs/HARNESS-SUBSCRIPTIONS.md#h3-执行)                                                    | ZCode 原生桥接、Read 权限和审批回传的功能说明。[接入记录](../../../../docs/spec/harness-subscriptions/tasks/task-multi-harness-acp.md)                                                                                        |
| [Codex 任务消耗与上下文](../../../../docs/spec/codex-task-settings-and-audit/spec.md#feat03-查看并对账任务消耗与上下文) | Codex 需求提供共用计量口径。ZCode 映射的交付依据是多执行器接入与 [离线回放记录](../../../../docs/spec/harness-subscriptions/tasks/task-acp-offline-replay.md)。技术设计中的自有桥回包描述是历史调研，当前实现见本页映射文件。 |
