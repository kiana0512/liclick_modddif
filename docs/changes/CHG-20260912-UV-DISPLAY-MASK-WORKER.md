# CHG-20260912-UV-DISPLAY-MASK-WORKER

## 范围

- 主模块：M07 UV 投影转换与常驻显示。
- 协作模块：M06 投影视口、M09 GPU/Worker 基础设施。
- 算法/调度版本：`UV-DISPLAY-MASK-WORKER` v1.1.0。

## 问题与修改

常驻 UV 计算返回的是每像素一字节的 `renderedColorMask`。旧显示上传路径在 UI 主线程逐像素展开为 RGBA，再创建翻转后的 `ImageBitmap`；4K 时需要执行 16,777,216 次 JS 循环并临时持有约 64 MiB RGBA。该任务虽有周期性 yield，仍会与相机、图层眼睛和画笔交互竞争主线程。

现在主线程只复制并转移原始单通道 mask。既有 Preview Bitmap Worker 以一字节形式保留它，并在每次上传条带请求时直接读取最终 Y 翻转对应的源行，仅为当前条带展开 RGBA 和创建 `ImageBitmap`；不再创建整张 RGBA 位图。输出仍为 `R=mask、G=0、B=0、A=255`，后续继续使用 RGBA `DataTexture` 和原有自适应分条上传。

## 不变项

- 不降低 1K/2K/4K 输出分辨率，不跳过 QA、Top-K、接缝或补边步骤。
- GPU texture 格式、shader 采样通道、颜色空间、Y 方向与分条上传顺序不变。
- CPU/Worker 投影求解结果、图层顺序、眼睛状态和导出像素不变。
- Project/Layer Schema、Command 幂等性、Revision CAS、ownership 与 verified assets 不变。

## 验证、迁移与回滚

- 回归执行真实 Worker 源码，逐字节验证两个 Y 翻转条带、红通道、opaque alpha、释放与尺寸。
- 静态门禁确认 Resident UV 主线程不再创建 `mask.length * 4` 临时数组。
- 无数据或资产迁移。回滚时恢复 Resident UV 内的主线程展开循环并删除 `adopt-mask` Worker 消息，不触碰工程数据。
