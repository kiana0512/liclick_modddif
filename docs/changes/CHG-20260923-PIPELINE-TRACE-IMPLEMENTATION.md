# Pipeline Trace：跨端阶段记录与真实验收

主模块 M13，验收 M15，涉及 M01/M02/M03/M04/M05/M06/M07/M08/M09/M10/M12/M14。Major 方案沿用已批准的 OpenSpec ADR；用户已明确授权 apply。状态 experimental/disabled，未部署、未归档。无业务算法、像素、分辨率、颜色空间或模型坐标语义变化；诊断协议 PIPELINE-TRACE v1，旧 PERF-LAB-REPORT v2 保留。

## 行为与开关

Trace 能力缺省关闭。VITE_LICLICK_PIPELINE_TRACE_ENABLED / VITE_LICLICK_PIPELINE_TRACE_DETAIL_ENABLED 使用明确的 false 构建默认值；LICLICK_PIPELINE_TRACE_ENABLED / LICLICK_PIPELINE_TRACE_DETAIL_ENABLED 控制服务端诊断能力与采样策略头。能力已构建也不会录制：用户点击开始或授权测试显式调用才创建 recorder、采样、上传 Worker；关闭构建静态裁剪，运行时停止终止采样与上传。已授权、未过期的同 owner/project 刷新续接是明确例外，失效 token 不自动创建新会话。

从业务完成回调发射终态；automation command/poll/idle 单列。operation/batch/view/attempt、捕获、参考输入、请求/下载解码、QA、回贴、材质、保存、恢复分别记录。保存成功由实际 ACK 确认；QA 失败不能被上传成功或刷新成功抹掉。同步 wall 不冒充 CPU execution，进程/heap 不归某请求独占，逻辑 GPU bytes 不叫真实 VRAM，供应方内部不可见时标 opaque-provider。

新增核心集中在各端 tracing 目录；必要探针分布在真实调用边界，不能全部放进单一文件。没有改动既有业务公式、QA 阈值或资产内容。新 wrapper 的异常处理也受构建裁剪保护，保持默认包体预算。

## 迁移、保留与回退

- 显式运行 apps/server/sql/005_pipeline_trace.sql 后才能使用 PostgreSQL 诊断表；普通服务启动不建表。不修改 Project/Layer/Generation 业务文档格式。
- pipeline_trace_sessions/chunks 按 owner 隔离，分片 SHA-256 幂等；created_at/expires_at 固定，迟到分片不延长七天保留。诊断请求触发限频清理，无默认后台定时器。close 保存末尾序号清单，用于识别尾部丢块。
- 新待传数据独立放在 li3d-pipeline-trace-upload-v1 IndexedDB，避免旧 manual 上传器捡到已停止的 Trace。每会话 128 MiB 上限，满盘/配额/网络故障仅报告诊断缺失；停止终止 Worker，下一次同 owner 显式录制才重试。
- 15 分钟 idle、60 分钟 rollover，刷新创建新 segment，活动检查点保留 continuation；不重提原生图任务，不伪造中断阶段完成。
- 回退先关闭上述构建/服务端门并重建，保留已收集 sidecar 表与旧 v2 数据；无需业务迁移/回滚，不删除项目或用户资产。宏关闭不能撤销已经执行的数据库迁移。

## 六路审计与证据

| 路径 | 验证与边界 |
| --- | --- |
| CPU | 分离 sync/async wall；Self-Profiling 脱敏窗口、Long Task/LoAF、Node process CPU/ELU、Blender CPU；不会把共享进程值加给每个请求 |
| GPU | WebGL 原生 CURRENT_QUERY 仲裁、异步回收、disjoint/lost；WebGPU 在 device 创建时协商 timestamp-query，停止清理、无 device 热重建；真实硬件时间戳与像素/数值一致性检查 |
| Worker | 编码、RGBA 合成、quality blend、UV topology 显式上下文与控制信号；原 Transferable 和 CPU gold/回退保留，诊断结果不阻塞业务返回 |
| shader | 没有改 GLSL/WGSL 公式；compile/submit/完成不同边界。Normal 各空间/角度、失败还原和并发 PNG 检查通过 |
| persistence | 独立诊断表/队列；原 Command/CAS/ownership/verified assets 与四副本 soak 通过；诊断数据库写入退出业务 ALS，避免自递归 |
| export | 业务模型/贴图导出保持；减面开关产物 SHA-256 一致。新 Trace 用真实 Perfetto 验证，CPU profile 单独 sidecar；未校准时钟不强拼 |

Web **156 项**与 Server **29 项**完整回归通过；后续诊断增量另跑测试。Web/Server typecheck/lint、Cloud/Repository 边界和 OpenSpec strict 通过。默认关闭包体最近检查：总 JS **3,269,689 / 3,269,800 bytes**，editor **499,121 / 499,624**，high bake **716,294 / 716,300**；未调整预算。开启 Basic/Detail 的构建也成功，但开启档不是生产默认包体的已批准替代物。

本机 Bicycle 真实导入减面至 200,000 triangles、六视图参考直接输入、默认 2K 九视角生图、回贴保存与刷新验证完成；12 attempts 最终 8/9，正面连续两次 silhouette QA 拒绝，按既有 fail-closed 规则保留失败。浏览器 3,046 spans、Worker 52 spans，导出时均无 open span。Perfetto 实际读取 3,046 slices、480 flows、1,947 counters，error/data_loss 为零；最长 attempt 109,111.4 ms，后续约 12 分钟工具停顿未延长它。修复了实际查看器暴露的长十六进制 Flow ID 解析问题。

30 分钟交错 off/Basic/Detail 稳定性完成 1,813,916.7 ms，各档 10 个一分钟窗口；Basic/Detail 共 120,000 scopes，丢弃 0，off 没有 recording，结束为 off。每 100 scopes 经验 P95 为 Basic 0.4 ms、Detail 0.5 ms；rAF observer P95/P99 为 18.1/18.2 ms。该实验是共享机器上的开发构建/合成探针，不能代替完整流程 +2%/+5%、目标硬件帧预算或 collector 独占内存预算。

本机证据和调用矩阵见 [实施状态](../../openspec/changes/archive/2026-09-28-add-generation-pipeline-tracing/implementation-status.md)。临时报告在 .codex-tmp，未作为仓库附件提交。全格式内部拆分、全资源台账、完整关键路径/频道、独立人工批次与严格性能预算等仍需验收；外部 ModelView/GPT 原生 queue/inference/GPU/VRAM 需要对应服务源码或遥测。不得以当前阶段通过宣称整份 OpenSpec 已交付。
