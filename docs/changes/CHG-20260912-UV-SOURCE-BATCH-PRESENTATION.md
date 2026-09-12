# CHG-20260912-UV-SOURCE-BATCH-PRESENTATION

- 主模块：M07；协作：UI-06、M06、M09
- 算法：`PERF-UV-SOURCE-PREPARE-001` v1.10.0
- 用户结果：多图层投影转 UV 不再为同一批私有来源纹理重复等待发布帧；不降低分辨率、不减少图层、不跳过 QA。
- 修改：同一次 GPU UV bake 的来源纹理仍逐张、逐精确条带上传和 flush，但每张纹理可以把可见 renderer 的双帧发布等待延后；全部唯一来源上传完成后统一 flush，并只执行一次双帧发布屏障。公开缓存纹理仍在各自上传结束后独立发布，detached renderer 不使用该延后能力。
- 正确性边界：延后只由 `stageLayerTexturesForGpu` 用于尚未交给 shader 采样、尚未公开的本次 bake 私有纹理。整批屏障完成前不会开始 raster；每纹理 ready 身份不进入全局缓存。条带字节、Y 翻转、premultiply、颜色空间、coverage、quality、rendered-color mask、层序、接缝和 gutter 不变。
- 交互与稳定性：每个条带仍执行交互静默、取消、4ms 累计同步预算、自适应降档、GL capture/restore 和定期 flush；整批双帧之间仍让相机/指针交互优先。异常和取消继续释放 active/pending stripe 与全部 disposable texture。
- 性能证据：以提交 `ac7cccb` 为冻结基线，真实浏览器 WebGL 三轮配对、每轮各 2 次。512/13 图层 retain-raster 基线均值 1771.3ms，当前 939.6ms，约提升 47.0%；512 两图层 JPEG 约提升 45.3%，非方形 PNG 约提升 44.2%。4K/6 图层中位样本约相差 0.5%，受驱动上传抖动影响，不声明稳定收益或退化。
- 验证：PNG、JPEG、非方形、重叠源、4K 和 13 图层 retain-raster 的最终 RGBA、coverage、retained raster/quality 全部逐字节一致，差异为 0；候选运行未记录 Long Task。专项合同覆盖唯一纹理去重、每纹理延后标记、整批一次 flush/双帧、detached 不延后以及原上传清理。
- GPU/CPU/Worker/shader：仅改变 GPU 来源上传发布等待的归并位置；GPU 指令和像素、CPU/Worker 数据、shader 与 fallback 公式不变。
- 持久化/导出：Project Command、Revision CAS、ownership、verified assets、Schema、缓存身份和导出不变。
- 迁移：无数据、Schema 或资产迁移。
- 回滚：移除 `deferVisiblePresentationBarrier`，恢复每张私有来源纹理独立双帧等待；工程与对象资产无需改写。
