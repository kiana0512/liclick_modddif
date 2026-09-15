# 留边分段计时

2026-09-15；主模块 M07，诊断策略 `UV-GUTTER-TIMING` v1.0.0。
关联算法 `ALG-UV-005`，仅增加观测，算法像素版本不变。状态：本地实现，未提交或部署。

## 入口与字段

`bakeProjectedLayerToTexture` 现有质量合成/Resident UV 阶段通过共享 `dilation.ts` 内核收集诊断，仍写入 `performanceBreakdown`，随后随 `residentUvProjectionStages` 输出。单位全部为毫秒。

| 字段 | 含义 |
| --- | --- |
| `gutterMs` | 原有留边阶段总经过时间 |
| `gutterTopologyWaitMs` | 进入留边后等待已提前启动的拓扑准备完成；不是完整拓扑生成总耗时 |
| `gutterBoundaryScanMs` | 查找当前有效边缘、建立或读取边缘资格缓存，扣除该阶段的主动调度等待 |
| `gutterExpansionMs` | 按轮次延伸颜色和更新覆盖标记，扣除该阶段的主动调度等待 |
| `gutterYieldMs` | 留边内核主动让出主线程至恢复的等待总时间 |
| `gutterTopologyRasterMs` | 仅兼容回退在本阶段现场生成拓扑的耗时，扣除其主动调度等待；正常路径为 0 |
| `gutterOtherMs` | 其他编排、门禁及测量开销，使用总时间减上述五项计算 |

六个子项互斥，合计为 gutterMs（浮点误差范围内）。并行启动的 `uvTopologySerializeMs` / `uvTopologyWorkerTotalMs` 不再加入这些子项，避免重复统计。计算项是扣除主动让出后的经过时间，不是操作系统 CPU profiler 的纯线程占用时间，仍可能包含 GC、系统抢占等。

## 实现与兼容

边缘与扩展阶段只在边界读时钟，不增加逐像素计时。调度耗时在原有 await 外测量，以 finally 保留失败/取消的实际等待；原 8ms 让出检查、调用顺序、像素取色和所有 Alpha 规则不变。每次计时对象初始化为零，禁用/零轮次不会复用上一轮值。

共享协作内核的计时参数可选，现有其他调用无需改动。同步 Worker 使用相同算法且不传计时参数；shader、GPU QA、合并/导出公式和分辨率不变。只扩展已有 Resident 质量路径的阶段报告，其他原本不输出 gutterMs 的兼容分支未新增报告管线。

未触及工作区已有底图缓存、大模型接缝缓存、预览接缝跳过策略。无 Schema、工程、资产、Command/CAS/ownership 或派生缓存身份变化。

## 验证

- 新增 `test:uv-gutter-timings`，修改前因没有独立调度等待值而失败，修改后通过。使用受控时钟验证冷/热查找、扩展、主动等待、零轮次重置、三种 Alpha 模式像素一致，以及实际阶段包装器的分项求和。
- `test-uv-gutter-cooperative`、`test-uv-gutter-reuse`、`test-uv-postprocess-scheduling` 通过；覆盖冻结像素结果、子数组、接缝和取消行为。
- 完整非增量 TypeScript 检查与修改文件 ESLint 通过。
- 既有 1K `run-resident-uv-browser.mjs gutter-timings` 独立浏览器回归通过，page errors 为空，实际输出所有新增字段；最后一轮 gutterMs=0.6ms，边缘查找=0.6ms，其他项=0，分项合计吻合。该例用于验证输出接线，不代表用户模型耗时。

## 查看与回滚

需要运行包含本次代码的前端，并触发一次新的重算；精确结果缓存命中可能保留上一条重算记录。旧记录无法追溯拆分。没有为了收集数据修改用户图层或刷新原标签页。

回滚本次两个源文件的计时差异、专项测试及诊断记录即可，无数据迁移；保留原 gutterMs 和其他已有工作。维护责任：M07。
