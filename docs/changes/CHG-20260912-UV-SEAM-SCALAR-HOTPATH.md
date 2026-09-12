# CHG-20260912-UV-SEAM-SCALAR-HOTPATH

## 范围

- 主模块：M07 投影转 UV；协作模块：M06 GPU/Worker、M09 持久化与导出审计。
- 算法：`UV-SEAM-REPAIR-PLAN` v1.4.0。
- 目标：降低首次 4K 接缝计划的垃圾回收与主线程负担，不改变任何像素结果。

## 修改

接缝边缘每个采样深度原来会创建两个临时坐标对象，再由 `pixelIndex` 读取并钳制。4K 实际工程可产生约六十万组地址，这些对象只用于一次索引换算。新实现保留原插值表达式、`Math.floor` 和边界钳制顺序，用标量 `x/y` 直接生成相同像素索引；有序地址缓存、重复地址、修复后 texel 可继续作为后续 donor 的行为全部保留。

GPU 投影、Top-K、Worker 质量合成、shader、RGBA/alpha/coverage、完整输出分辨率、接缝宽度、gutter、深灰斜线和 QA 均未修改。显式 Merge、常驻 UV、保存与导出继续共用同一接缝实现。

## 验证

- `test:uv-gutter-cooperative`：600 组 gutter、500 组修补、40 组变换网格、重复/非流形顺序、几何缓存失效和冷/热结果全部通过冻结核逐字节对照。
- 隔离性能夹具：4K gutter 当前核三轮约 269.6/265.6/264.3ms，约 13 万面球体接缝冷计划 161.9ms、热计划 0.75/0.57ms，像素差异 0。该数字用于发现回退，不承诺所有设备或工程获得相同比例。
- 完整 Web 回归 122 项在同步更新 UI 长文案契约后通过。

## 迁移与回滚

无 Project Schema、Command、Revision CAS、ownership、verified asset、缓存键或历史资产迁移。回滚只需恢复 `uvSeamReconciliation.ts` 内临时点对象和 `pixelIndex` 帮助函数；已保存工程与导出物无需处理。
