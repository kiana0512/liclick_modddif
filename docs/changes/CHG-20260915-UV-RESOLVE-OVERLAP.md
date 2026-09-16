# Resident 最终回读调度优化

2026-09-15；主模块及维护责任 M07，关联 ALG-UV-003/008。调度策略 `UV-RESIDENT-RESOLVE` v1.0.0，像素算法与 Schema 版本不变。本地修改，未提交或线上部署。

## 实测原因

用户工程 2K 最近重算 610.1ms，gpuRasterAndReadbackMs=359.7ms。其包含 sourcePreparationWaitMs=124.1、textureUploadMs=26.6、qualityResolveMs=198.2；不是纯 GPU 光栅时间。逐层回读等待为 0，六层缓存命中、一层未命中；最终 RGBA 两个 8MiB 条带回读合计 105.1ms。嵌套/重叠字段不可重复相加。

最终处理原来依次执行颜色回读和精确校正、Worker Y 翻转/coverage 转换、覆盖数量 GPU 归约回读。其中覆盖统计只读当前候选纹理，与颜色校正/转换独立。此外，标记扫描即使不足工作预算，也每 1MiB 固定让出一次任务。

## 实现与契约

- `gpuUvBakeRenderer.ts`：颜色回读/校正/转换作为一个 Promise，与原覆盖数量归约同时启动；仍在两者成功完成后使用准确覆盖数量。任何颜色读回、转换或统计错误均等待所有在途任务收尾，再允许外层释放资源，避免读取已释放的目标。
- 两个任务使用同一隔离 WebGL 有序队列，不宣称 GPU 真正同时执行。统计归约仍使用原临时目标和整数计数；取消/失败不让部分结果成为可复用前缀。只改变临时资源生命周期的重叠，不添加常驻缓存或提高预算。
- `residentQualityComposite.ts`：扫描范围与标记条件不变，每 1MiB 检查已用时间，达到 4ms 才主动让出；原 rounding-boundary 精确 CPU 修正、重复候选复用及 Alpha 全部保留。
- 新增 DOM `residentUvCorrectedReadbackMs`，记录最近一次实际颜色回读加精确校正的时间；配合现有 uvBakeReadbackTotalMs 与 qualityResolveMs 排查。精确结果缓存命中不执行此阶段，这个字段会保留上次实际调用值，不能将其当成该缓存命中轮的新耗时。
- 为保持原包体门禁，压缩同路径两条诊断文字，仍保留 GPU 量化、CPU 仅诊断、校正数量以及是否保留参考 raster 的信息；没有删除 QA 或错误分支。

## 对应路径审计

GPU 光栅/MRT、Top-K、resolve/gather/count shaders、CPU 金标准、Worker 转换、8MiB 分条与离屏最多双 PBO 的读回策略不变。标记扫描共用于生产和校准，真实 WebGL 门禁继续验证。新并排归约仅用于不保留逐层 raster 的 Resident 路径，其他诊断路径保留原逐层计数。普通合并/导出使用相同精确结果，不降低分辨率，不修改接缝/留边/底图/上传策略。Project Command、Revision CAS、ownership、verified assets、持久化键和 Schema 不变，无数据迁移。

## 验证

- `test-resident-resolve-scheduling` 先观察旧实现“统计晚于转换”与“每 1MiB 固定让出”失败，再验证改后通过。覆盖颜色、统计、Worker 转换失败时等待在途统计结束、精确计数和受控 4ms 调度。
- `test-resident-uv-display`、`test-uv-readback-stripes`、`test-uv-postprocess-scheduling`、完整非增量 TypeScript 与修改文件 ESLint 通过。
- 2K 独立显隐回归 17 次：page errors=[]，画面还原及 UV 岛边缘差异 0。
- `verify-resident-quality-webgl` 通过原质量门禁、4K 完整像素及 prepared texture handoff 检查，资源/交接差异 0。
- `benchmark-resident-resolve-browser.mjs <修改前 composite 文件> <修改前 bake 文件>` 在同一浏览器/renderer 中比较本次修改前快照与当前代码，2K 七层常色输入；交替运行顺序，完整 RGBA、coverage 和覆盖数量每轮相同。首轮 127.8→45.1ms 受编译/热身影响，不用于收益结论。四个热轮如下：

| 轮次 | 修改前 ms | 修改后 ms |
| --- | ---: | ---: |
| 1 | 49.5 | 38.5 |
| 2 | 44.4 | 40.2 |
| 3 | 41.4 | 37.4 |
| 4 | 40.7 | 34.1 |
| 中位 | 42.9 | 38.0 |

这是独立最终读回/校正/统计阶段约 11.5% 的改善，不代表用户模型 359.7ms 整段或显隐总耗时。未优化本次未命中层的源准备 124.1ms，也不宣称消除了 GPU 原始读回的 105.1ms。

干净目录生产构建及原包体门禁通过：96 块、3247488 / 3247500 字节，预算未提高。

## 生效与回滚

重新构建本地 apps/web/dist，刷新并执行新显隐操作后读取实测。回滚本次两个源文件的差异、专项测试/基准/入口及维护条目即可；保留此前优化，不迁移工程和资产。
