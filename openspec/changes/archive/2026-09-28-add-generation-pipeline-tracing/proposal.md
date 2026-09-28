# Proposal

## Why

需要定位生图链路中各阶段、各业务函数的耗时。旧方案扩展为跨端性能诊断系统，改动和维护成本过大。2026-09-28 按用户要求缩减范围，并增加 --DEBUG 编译能力门与默认关闭的运行时开关。

## What Changes

- 记录应用内阶段和覆盖清单内每个自有业务函数的开始、结束、耗时、调用次数和成功/失败/取消状态；人工和自动化共用埋点。
- 启动器 --DEBUG 在构建前开启 Trace；普通构建默认关闭，正式发布强制关闭并裁剪本次 Trace。
- DEBUG 中统一用 startPipelineTrace() / stopPipelineTrace()，默认 off，不新增独立可写的 trace 布尔变量。
- 仅保留应用内阶段/函数列表、次数/累计/平均/最大耗时和普通 JSON 下载。
- 移除本次新增 Perfetto、CPU profiler、GPU 时间戳、内存台账、跨端校准、服务器诊断 API/SQL、上传队列和刷新续传；既有 Performance Lab 独立保持。

## Capabilities

### New Capabilities

- `generation-pipeline-tracing`：默认关闭、可编译裁剪的本地阶段与业务函数计时。

### Modified Capabilities

无已归档能力；本次重写未归档提案，不把旧草案作为生产契约。

## Impact

主模块 M13，验收 M15。自有浏览器业务模块仅在真实边界接入计时，Worker 记录本地任务/函数耗时。无业务算法变更，不改变像素、QA、分辨率、Project Command、Revision CAS、ownership 或业务导出。

方案文档修订为 Patch，用户随后授权实施，进度见 implementation-status.md。新版不新增持久化契约，旧 Major 设计中的诊断数据库和跨服务传播不再是交付目标。移除未发布的诊断 SQL/API，不自动删除已存在的测试数据库表或数据。

## Non-Goals

不接入 Perfetto，不做硬件性能采样、远端推理内部诊断、全项目自动函数插桩、关键路径分析、诊断上传或跨刷新历史。函数范围为生图链路内自有业务函数，第三方库内部不插桩。远端只测客户端请求/等待，不称为推理或 CPU 执行时间。
