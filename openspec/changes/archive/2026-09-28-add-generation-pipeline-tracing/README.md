# add-generation-pipeline-tracing

**2026-09-28：轻量版已实现并通过本地验收，按用户要求归档。正式规格见 openspec/specs/generation-pipeline-tracing/spec.md；发布状态以 Git 与 CI 为准。**

目标：生图链路的阶段与自有业务函数耗时。启动器 --DEBUG 决定构建能力；startPipelineTrace()/stopPipelineTrace() 控制录制，默认 off。正式构建裁剪本次 Trace，DEBUG/off 只留轻量判断。

仅保留本地记录、阶段/函数列表、次数/累计/平均/最大耗时和普通 JSON。不再接入 Perfetto、硬件采样、诊断数据库/上传或刷新续传。

- [提案](proposal.md)、[设计](design.md)、[规格](specs/generation-pipeline-tracing/spec.md)：当前有效范围，共 7 条要求。
- [任务](tasks.md)：15 项按新版重新验收，旧勾选不继承。
- [覆盖清单](coverage.md)：23 个明确业务函数及阶段/Worker 接入，非全仓自动插桩。
- [ADR](adr.md)、[实施状态](implementation-status.md)：新旧范围与限制。
- [工作区清单](work-inventory.md)：旧实现恢复时的分类，不是新版文件数量目标。

启动方式：`corepack pnpm dev:4517 --DEBUG`，右下角“函数计时”显式开始/停止。普通启动省略 --DEBUG；刷新默认关闭。业务算法、像素、分辨率、QA、Command/CAS、ownership 和既有 Performance Lab 保持。
