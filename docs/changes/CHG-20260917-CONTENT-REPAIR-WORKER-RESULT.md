# 内容填补 Worker 结果内存收敛

主模块 M07，协作 M05/M06/M08/M09。`LOCAL-BOUNDARY-REPAIR/1.3.1`，`CONTENT-REPAIR-WORKER-RESULT/1.0.0`。

## 问题

内容填补 Worker 的核心必须在计算期间维护 `repairedMask` 与 `sourceExclusionMask`，但编辑器原子发布只消费最终稀疏 RGBA 和统计。旧协议仍把两张 mask 转移回 UI 线程并组装进结果；4K 时每张 byte mask 为 16 MiB，发布路径因此额外保留约 32 MiB。复杂项目连续运行或浏览器同时承担贴图上传、PNG 编码时，这会增加堆峰值和垃圾回收压力。

## 修改

- `runSurfaceAwareRepair` 新增显式 `includeDiagnostics` 选项，默认 `true`，保持测试、诊断与兼容调用返回完整结果。
- 正式编辑器发布路径传入 `includeDiagnostics:false`；Worker 只转移 `filledRgba` 和统计，不把两张 atlas-sized mask 交给 UI 线程。
- 主线程兼容执行采用同一返回契约；关闭诊断时只暴露 RGBA 与统计。
- Worker 若在默认诊断模式遗漏 mask，客户端 fail-closed，不伪造空诊断结果。

像素算法、缺口 mask、来源排除计算、传播、局部混合、Alpha、checksum 和统计仍在 Worker 内完整执行。本次只缩短诊断数组生命周期，不省略 QA 或计算步骤。

## 验证

- 内容填补专项 32/32；覆盖默认完整诊断、生产精简结果、输入所有权、取消、确定性、跨 region/真实空洞保护和黄金像素。
- Edge 2048²：生产精简 Worker 与主线程完整 RGBA 字节差 0，修复 262,144 texel，无全局兜底。
- Edge 4096²：生产精简 Worker 修复 524,288 texel，中心 RGB `[140,80,95]`，真实空洞保持透明，无全局兜底；约 2.78 秒，仅作为本机合成夹具观测，不宣称复杂项目已达到交互帧预算。
- Web TypeScript 检查通过；完整仓库门禁在提交候选后执行。

## 影响、迁移与回滚

GPU/shader、CPU/Worker 算法、投影/UV/repaint/export、分辨率、PNG、QA、Layer/Project Schema、Command、Revision CAS、ownership 和 verified assets 不变。无数据库、工程或资产迁移。

回滚时移除 `includeDiagnostics`，恢复 Worker 总是回传两张 mask，并恢复编辑器调用即可；已有工程和填补资产无需处理。回滚会重新引入 4K 发布阶段约 32 MiB 的 UI 线程诊断数组驻留。
