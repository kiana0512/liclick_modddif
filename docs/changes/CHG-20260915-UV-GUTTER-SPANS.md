# CHG-20260915 显隐冷路径的有界 gutter 区间缓存

## 模块与算法

- 主模块 M07，协作 M06/M08/M09/M11；ALG-UV-005 v2.0.6（实现 Patch，像素语义不变）。独立聚焦变更：1 个生产源码文件、1 个测试文件。
- 旧 immutable topology 缓存逐像素登记所有 touchesAtlasGutter，包括大片岛外空白，常超过 262144 个索引后回退全扫描。4K A60 显隐冷路径 gutter 约 179–183ms。
- 新缓存登记同一布尔谓词的半开连续区间，保留原 row-major 顺序、动态 coverage 过滤和原 donor/iteration 顺序。岛外有 coverage 的 raster fringe 不省略。
- 仍仅缓存一个 WeakRef 几何校验后的不可变 topology，Uint32 chunks 总容量不超过 1 MiB。高度碎片化超过 131072 区间仍按原扫描回退；不提高显存/内存预算。

## 全链正确性

- GPU、CPU、Worker、shader 的投影/Top-K/颜色/Alpha/coverage、接缝、gutter 迭代数与分辨率、QA 均不变。三个正式 bake 消费入口继续 await 同一协作 kernel，按原 8ms 预算让出并检查取消。
- 视口仍完整 UV；新生图截图屏障、持久化、导出路径不变。无 Schema、Project Command、Revision CAS、ownership 或 verified asset 变更；不重写既有资产。
- 600 随机旧核 RGBA/coverage/count 对照、500 repair、40 transformed seam 对照通过；新增 1024² 空白 atlas/岛外动态覆盖/三种 alpha/cold-warm/超预算碎片回退逐字节零差异。
- 实机前后延迟在 CHG-20260915-UV-VISIBILITY-RESPONSE 汇总；不会把缓存命中或材质绑定探针当作全功能像素验收。

## 迁移与回滚

- 只有内存派生索引，刷新自动重建，无工程/磁盘/资产迁移。
- 回滚 dilation.ts 的 spans 登记/遍历为原 seeds，无需删除工程、缓存资产或修改渲染模式；像素语义始终不变。
