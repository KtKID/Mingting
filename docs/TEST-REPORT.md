# MVP 验证报告

验证日期：2026-10-31。执行位置：独立云目录 `/workspace/task-platform-mvp`。未访问、修改或恢复已暂停的 MadeMe；未使用用户 Mac；未真实登录、读取现存凭据或调用模型。

## 环境与依赖

- Node `v24.19.0`，npm `11.9.0`。
- 应用 ACP SDK `2.2.0`，MCP SDK `1.32.2`，Codex ACP `2.5.0`，React `19.3.1`，Vite `8.3.5`，TypeScript `7.0.2`。
- 依赖从官方 npm registry 安装，安装时使用 `--ignore-scripts`，保留 `package-lock.json`。
- SQLite 使用 Node 内置 `node:sqlite`，没有自制数据库协议。
- Playwright Chromium 下载被环境网络域名策略返回 403；没有绕过或重复人工请求下载。使用环境已有 `/usr/bin/chromium` 完成浏览器测试。

## 服务端：11 项通过

命令：`npm test`。最终结果 **11 passed / 0 failed**，约 10.5 秒。

1. 官方 MCP HTTP 客户端列出唯一 `publish_task`；调用不存在的审批工具返回错误；发布后落 SQLite，经真实 ACP 测试子进程产生审批，浏览器 API 决策后收到结果；下一任务在前一任务结束前保持排队。
2. 拒绝回传原始 `reject-once` optionId；伪造选项、错误 run、错误 session 均被拒绝。
3. 取消使旧审批失效；重复决策返回 409；重试创建不同运行和新审批。
4. 服务停止、重启后任务保留，旧运行 `interrupted`，旧审批 `expired`，旧回调无法复活。
5. 恶意 Host、跨站 Origin、缺失 CSRF/会话、无效字段、客户端自传 cwd 被拒绝。
6. ACP 子进程异常退出使当前运行失败，队列继续处理下一任务。
7. 不匹配当前 session 的 ACP 权限请求直接返回 `cancelled`，不登记、更不批准。
8. 重构崩溃时的持久记录后启动服务，恢复旧运行/审批状态；重启前排队任务继续，旧会话不自动恢复。
9. 用测试时钟触发审批 10 分钟截止，取消运行并使迟到决策返回 409。
10. 显式认证方法通过官方 ACP SDK 协商；测试方法没有真实密钥或登录行为，默认路径不自动 authenticate。
11. 取消后立刻关停再重启，保留 `cancelled` 状态，不误改为 `interrupted`。

这些测试通过真正的 HTTP 和新建子进程 stdio 交换协议，**不是仅 stub 一个函数**。`tests/fake-acp.ts` 使用官方 SDK，不执行展示的 shell 命令，不调用任何模型。

核心闭环先写测试，在缺少服务模块时观察到失败，再实现。关停状态回归测试先复现 `cancelled → interrupted` 的错误，再修复并通过。测试开发中出现的定位/夹具问题已修正，以上为最后通过的运行结果。

## 构建与网页

`npm run build`（`tsc --noEmit && vite build`）通过。构建完成 111 个模块，静态网页产物在 `dist/web/`；源码包不附带生成目录，需要接收者重新构建。

浏览器命令：

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:ui
```

测试范围：桌面浅色 `1440×1000`、手机暗色 `390×844`。两种尺寸各测试一次发布→三字段列表→详情上下文→批准→结果；再各测试拒绝、取消、显式重试。还检查页面脚本错误、横向溢出与暗色根节点对比。内部截图审查发现并修复暗色文字/背景对比；截图仅用于本地 QA，未上传为交付物。

最终浏览器结果见本报告结尾的完成记录。

## 真实适配器握手（不调用模型）

`node node_modules/@agentclientprotocol/codex-acp/dist/index.js --version` 返回 `@agentclientprotocol/codex-acp 2.5.0`。

另外在全新临时目录内，通过官方 ACP SDK 对**真实**适配器执行一次 `initialize`。`HOME`、`CODEX_HOME` 都指向临时空目录；未转发 API key 或任何现存凭据。响应：

```json
{
  "protocolVersion": 1,
  "agentInfo": {
    "name": "@agentclientprotocol/codex-acp",
    "title": "Codex",
    "version": "2.5.0"
  },
  "authMethods": ["api-key"]
}
```

握手后终止子进程组并删除临时目录。没有发送 `authenticate`、`session/new` 或 `session/prompt`。这证明真实入口可启动且能完成初始化，**不证明真实任务执行或真实审批已经联调通过**。

## 尚未验证和部署边界

- 真实账户登录、API key 认证成功、真实模型调用、真实 Codex 工具审批尚未执行，待用户在本机测试。
- 用户 Mac / Apple Silicon 原生环境未运行；当前实际测试环境是云 Linux。
- 没有公网部署，没有可供用户远程访问的预览 URL，没有隧道。浏览器 QA 访问的是云环境内部 loopback。
- 响应式手机尺寸已验证，真实手机跨设备访问未实现，当前服务仅绑定 loopback。
- 未做多用户鉴权、授权矩阵、数据库多实例锁、日志清理/分页、负载压测或所有错误场景的完整证明。只能用于可信本机单用户 MVP。
- 任务 `succeeded` 仅指 ACP `end_turn`；业务验收仍需用户检查。Codex 沙箱内未要求审批的操作不会凭空出现在网页审批列表。

## 最终完成记录

最后一轮 `npm run check`：**11 / 11 服务端测试通过**，TypeScript 检查和 Vite 构建通过。最后一轮浏览器测试：**4 / 4 通过**，约 20.6 秒。源码、锁文件、中文 README 和本报告随源码包一并交付。
