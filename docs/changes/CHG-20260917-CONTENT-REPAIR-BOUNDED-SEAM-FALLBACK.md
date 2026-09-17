# 内容填补按需物理缝余量修复

主模块 M07，协作 M05/M06/M08/M09。`LOCAL-BOUNDARY-REPAIR/1.4.0`，`CONTENT-REPAIR-SEAM-FALLBACK/1.0.0`；`ALG-CA-001` 缺口检测仍为 v1.1.0。

## 问题与边界

首轮局部边界修复严格限制在同一 UV region。这样能阻止皮肤、口腔或不同材质互相借色，但完全空白的 UV 小岛即使与已着色小岛属于同一真实网格表面，也没有本 region 的可靠 donor。用户工程曾在 485,862 px 成功修复后留下 13,046 px；这些残余不能用全图平均色硬填，否则会把错误材质写入模型。

本次不承诺所有模型达到字面 100%。没有任何可靠颜色、没有物理缝关系、硬法线断裂、跨 Mesh 或跨材质的孤立表面仍保持透明并报告余量。

## 修改

- 常规快路径不变：预热和首轮仍不构建 seam links，保持同 region、多边界局部混合与自适应距离。
- 只有首轮统计确认仍有残余时，才按需构建物理缝拓扑。连接必须来自同一 Mesh、同一 material slot、同一几何 component，并通过法线兼容和真实 core texel 门禁。
- 第二轮只处理首轮未修复 mask，颜色最多跨一条物理 UV seam；不能沿岛链继续传播，不能进入未选 texel，也不启用全局平均色或 dominant 单色兜底。
- Worker 在有残余时把已经转移的 source RGBA 和原 write mask 原路转移回来：首轮成功 texel 原地成为 donor，mask 原地收缩为 residual，避免为 4K 再复制约 80 MiB 的 RGBA+mask。
- 第二轮在 Worker 内把稀疏结果合并到首轮 buffer。首轮高置信像素优先，第二轮只能补首轮仍透明的位置；最终 checksum 对合并后的发布 RGBA 重新计算。
- 两阶段编排为按需动态分包。常规 Editor 首屏与没有余量的填补任务不加载 fallback 模块。

## 对照审计

- CPU/Worker：同一 `surfaceAwareRepair` 核；主线程兼容路径与 Worker 路径共享 continuation、合并和 checksum 契约。
- GPU/shader：投影烘焙、实时斜线阈值、深度/背面门禁、shader 与 WebGPU 合成公式不变。
- UV/拓扑：首轮缓存键不变；fallback 独立使用 `includeSeamLinks:true` 缓存键，不把 seam 数组混入快路径缓存。
- Repaint/export：仍发布一张稀疏内容修复 UV 图层；图层顺序、Alpha 合成、导出方向与模型导出不变。
- 持久化：Layer/Project Schema、Project Command 幂等、Revision CAS、ownership、verified object assets 和对象存储键均不变。
- 质量：不降分辨率、不放宽投影 QA、不启用浏览器实验 UV/PBR 内核替代云服务。

## 性能与稳定性

- 无残余时只多一个 Worker 统计分支，不构建 seam 拓扑，不回传 continuation buffer。
- 有残余时额外付出一次 seam 拓扑和第二个 Worker pass；工作量仍为 O(pixel + seam links)，且只在用户已经观察到未补全时发生。
- 生产构建将 fallback 放入 6.68 KB lazy chunk；Editor route 为 494,775 / 499,024 bytes，余量 4,249 bytes；release 总 JS 3,227,295 / 3,256,500 bytes。
- 这不是服务器并发扩容项：计算仍发生在用户浏览器 Worker；Cloud 控制面、对象存储与生产计算服务协议不变。

## 验证

- 内容填补专项 33/33：新增 local-boundary 显式单 seam 上限、零拷贝 residual continuation、两轮稀疏合并与合并 checksum。
- 内容拓扑、UV gutter/seam 冻结核、单视图 completion、Web TypeScript、lint（0 error，2 个既有 warning）通过。
- 真实 Edge 浏览器 2048²：Worker/主线程首轮 RGBA 字节差 0，修复 262,144 px；独立 residual 夹具经零拷贝 continuation 与单物理缝第二轮后余量为 0，合并输出保留两轮 Alpha；控制台 0 error。本机合成夹具首轮主线程约 684 ms、Worker 约 718 ms，不代表复杂用户工程总耗时。
- 生产构建与 `check:web-bundle-budget --reserve-bytes=256` 通过；没有提高预算。
- 完整仓库预推门禁以本轮最终提交结果为准。

## 迁移与回滚

无数据库、Schema、工程、图层或对象资产迁移。旧项目无需重算；用户再次执行内容填补时才使用新策略。

回滚时删除按需 `runVisibleSurfaceRepairWithFallback` 编排，恢复编辑器直接执行一次 `maxSeamCrossings=0` 的 Worker，并恢复 local-boundary 模式强制 seam 上限为零。现有修复图层仍是普通稀疏 RGBA 资产，无需删除或转换。
