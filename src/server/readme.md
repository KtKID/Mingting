# 明庭服务端

> 草稿，待用户检查。

## 功能描述

明庭接收网页和 MCP 发来的任务，把任务交给在线连接器执行，并保存进度、审批、结果和聊天唤醒记录。MCP 是聊天客户端调用明庭工具的接口。

## 设计理念

网页和 MCP 共用同一个任务服务，发单规则和持久记录集中维护。连接器作为独立进程订阅任务，服务重启后仍可从数据库找回排队任务。目录按入口、任务处理、存储、唤醒和执行器分组。 [目录迁移记录](../../docs/task/task-server-module-layout.md) · [订阅与运行说明](../../docs/HARNESS-SUBSCRIPTIONS.md)

## 使用方式

在仓库根目录安装依赖，执行 `npm run build` 生成网页，再执行 `FAKE_ACP=1 MINGTING_CODEX_WAKEUPS=0 npm start` 启动演示。打开终端打印的本机地址，默认是 `http://127.0.0.1:60390`。发布测试任务后，列表会出现任务并逐步更新状态。已有日常实例时，可用 `PORT`、`TASK_DB` 和 `TASK_WORKSPACE` 给演示指定独立端口、数据库和工作目录。完整自动回归入口是 `npm test`。 [快速试用](../../README.md#快速试用无模型的完整传输闭环)

## 代码说明

- [main.ts](main.ts) 从环境变量读取端口和数据库路径，创建平台，按配置启动连接器。启动代码调用 [runtime()](harness/runtime.ts#L13) 解析运行配置，再调用 [createPlatform()](transport/http.ts#L48) 组装服务。监听成功后启动去重后的连接器列表，`TASK_CONNECTOR=manual` 时由调用方自行启动连接器。[stop()](main.ts#L65) 先结束任务服务和连接器，再关闭监听与数据库。

| 目录                             | 从这里查什么                                   |
| -------------------------------- | ---------------------------------------------- |
| [transport](transport/readme.md) | 网页、MCP、连接器、订阅者和 DSH 宿主的接口     |
| [tasks](tasks/readme.md)         | 发布、认领、进度、审批、取消与重试             |
| [storage](storage/readme.md)     | SQLite、事件回放、审批归档                     |
| [wakeup](wakeup/readme.md)       | Codex 会话探测与审批、完成通知投递             |
| [harness](harness/readme.md)     | 执行器选择、进程与账号环境、ACP 和各执行器映射 |

## spec 索引

| Spec                                                                                | 与服务端的关系                                                                                                                                                   |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [统一发单与结果订阅](../../docs/spec/unified-task-publishing/spec.md)               | 网页和 MCP 共用发布逻辑，订阅者凭回执读结果。旧 DSH 专属入口退役是后续阶段，代码仍提供该入口。[技术设计](../../docs/spec/unified-task-publishing/tech-design.md) |
| [DSH 原会话唤醒](../../docs/spec/dsh-task-wakeups/spec.md)                          | 定义会话绑定、完成通知和去重要求，历史专属发单路径见 [技术设计](../../docs/spec/dsh-task-wakeups/tech-design.md)。                                               |
| [Codex 设置、审批审计和用量](../../docs/spec/codex-task-settings-and-audit/spec.md) | 从执行器设置回读和运行回报，到详情查询和审计记录。[技术设计](../../docs/spec/codex-task-settings-and-audit/tech-design.md)                                       |
