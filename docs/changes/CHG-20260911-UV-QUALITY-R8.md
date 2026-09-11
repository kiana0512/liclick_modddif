# UV 权重单通道缓存

主模块 M07，协作 M09。`UV-QUALITY-R8/1`，设备校验 `UV-DEVICE-CALIBRATION/1.1.0`。

偶数分辨率 WebGL2 的私有权重目标改为 RedFormat/UnsignedByte，仍保留原来的一个完整权重字节，不改精度。质量 shader 的 red 使用和旧 alpha 相同的 ONE/ONE_MINUS_SRC_ALPHA 混合；不能再次乘以自身 alpha。奇数尺寸与旧读回路径仍使用 RGBA。读回打包与 GPU Top-K 累积按实际纹理格式选择通道；校验输入混合 R8/RGBA，覆盖两种 preserveAlpha 模式。权重公式、颜色、覆盖和舍入校正不变。

## 容量及失效

每层 4K color+quality 从 128MiB 变为 80MiB，缓存按实际格式计数；256MiB 总预算和 context/几何/来源失效规则不放宽。含 96MiB 最终结果时，逐层缓存从一层增至两层。此处是逻辑纹理字节数，不承诺所有驱动按同样大小分配。

## 审计与验证

CPU/Worker 仍消费相同的 RGBA、quality 和 coverage；导出、持久化资产、Command/CAS/ownership 及 Project Schema 不变，深灰斜线不改。私有纹理不会跨页面持久化，无旧数据迁移；回滚恢复 RGBA 目标和 alpha 取样即可。

内置浏览器以 f22c353 冻结核按旧/新/新/旧顺序比较：512²/13 层、4K/6 层、JPEG、长宽比、共享 UV、257² 奇数路径，保留的逐层 RGBA/quality/coverage 与最终输出均零差异。另以六层不同颜色进行四组 4K 连续切换，五个状态产生四种不同输出 hash，颜色/覆盖/计数与旧核全部一致。命中一层→两层，但本轮总耗时旧/新都约 0.56–0.70 秒，不能声明切换已即时。122 项 Web 回归及 TypeScript 通过。

发布必须针对最终提交通过正式 CI 环境包体门禁；容量优化不能替代端到端性能验收。
