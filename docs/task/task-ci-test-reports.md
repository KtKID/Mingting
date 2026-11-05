# CI 自动测试与统一报告试点

> 功能文档：[CI 测试与报告](../CI-TESTING.md)
> spec: 无，功能来源见功能文档
> 范围：Actions 自动执行、用例发布、diff coverage、Artifacts

> 后续隐私调整。GitHub 保留自动检查状态，详细报告和原始证据在本机保存。下文记录初版试点。
> tech-design: 本文件②
> 创建：2026-11-03
> 状态：试点通过，草稿 PR 待审阅

## ① 需求与变更

用户要求在 x-mingting 试点 Actions＋用例结果发布＋diff-cover＋Artifacts，取得实际运行记录。基线 `5ca8a1150987551073349fc9f5f9550959dbd89f`，在独立 checkout 开发，原目录的聊天唤醒实验保持原样。功能定义位于 [CI 测试与报告](../CI-TESTING.md)。

## ② 精简技术设计

沿用 Node 24+、node:test、现有审批归档与 Playwright 回归。增加 c8 和标准 JUnit XML 解析器；CI 的 Python 只负责调用 diff-cover。统一报告从实际 JUnit、覆盖率、阶段状态与 Git 基线生成，输出集中到 reports/ci，业务实现保持当前版本。

D1：Actions 负责编排与阶段结果留存，测试失败后继续发布报告与附件。D2：c8 采集源码覆盖，diff-cover 对照精确 base/head 输出改动行缺口。D3：报告生成器解析标准数据，逐例列结果，缺资料明确失败。D4：Checks 与 Artifacts 使用同一批结果，分支与运行编号支持追溯。

共用规范：复用现有模块/测试入口；报告边界采用 Zod 校验；覆盖配置作为采集范围来源；各阶段退出与限制如实留存。业务协议、数据归属保持原定义。

## ③ 测试用例与变化

新增 CI 报告聚焦测试：Node/Playwright JUnit 嵌套用例及状态、XML 非法输入、缺用例/覆盖资料、失败阶段与报告结论、Markdown 转义及改动覆盖资料定位。沿用全部后端测试、构建与十条审批浏览器回归。覆盖率采集新报告脚本与本次修改的可执行代码，文档/工作流/测试配置列适用性说明。

## ④ 技术实现

计划：.github/workflows/tests.yml、.c8rc.json、package.json/lock、playwright.approval.config.ts、scripts/ci-report.ts、tests/ci-report.test.ts、文档与忽略规则。

## ⑤ 验证结果

- 统一测试报告：`reports/ci/test-report.md`；CI 发布到运行摘要与同批 artifact。
- 本地实际执行：后端 87/87、构建通过、审批浏览器 10/10，合计 97 条通过、0 失败、0 跳过。
- 改动行覆盖：报告脚本 311/315（98.7%）；未覆盖 182–183、193–194 为报告读取异常的处理分支。整文件分支 67/77（87.01%），原始数据与口径在报告附件。
- 工具检查：TypeScript、改动文件 Prettier、actionlint 与 diff 检查通过。
- GitHub 实测：[PR #1](https://github.com/KtKID/Mingting/pull/1)、首轮运行（批次 41615472697，本机归档）成功，87 后端 + 10 审批用例通过，Checks 发布成功，报告/原始证据 artifact 已上传，保存期 30 天。
- x-verify-spec：对账通过。本轮对照用户范围、D1–D4、6 项新增用例与沿用回归，读取统一报告及原始 JUnit/覆盖数据，97 项结果、比较基线、未覆盖位置和实际 CI 状态一致。
- x-verify-tech：通过。本轮实际执行 TypeScript、格式、actionlint、后端/浏览器与 diff-cover；云端复跑覆盖 Ubuntu/Node 24，D1–D4 的执行、失败留存与发布路径可定位。整文件分支与浏览器前端覆盖边界按报告列明。
- 未决：草稿 PR 审阅及合入 main；默认分支保护规则按后续项目门禁约定设置。
