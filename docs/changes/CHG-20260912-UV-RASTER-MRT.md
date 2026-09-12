# CHG-20260912-UV-RASTER-MRT

## 范围与版本

- 主模块：M07 Projection / UV
- 协作模块：M06 Viewport、M09 Worker、M15 Build / CI
- 算法：`UV-RASTER-MRT/1.0.0`

## 问题

Resident UV 的每个普通投影层原来对相同几何、相同源图和相同深度/法线可见性执行两个完整光栅 pass：颜色 pass 输出 RGBA，质量 pass 再次运行同一顶点与可见性计算并输出 R8 权重。高面数模型因此重复提交全部三角形；来源解码、上传和最终读回仍是独立阶段。

## 修改

- 仅偶数分辨率的 WebGL2 Resident 普通投影层启用两个颜色附件的 MRT：附件 0 为 RGBA 颜色，附件 1 为 R8 质量；生产 1K/2K/4K 均覆盖，奇数诊断尺寸保留原双 pass。
- 单个 shader 只计算一次投影坐标、深度/法线可见性、mask、source alpha、覆盖率和质量，同时写出两种结果。
- 两个附件共用原颜色路径的非预乘 `NormalBlending`。质量附件输出 `RGB=1, Alpha=quality`，硬件混合结果仍是原质量 pass 的 `quality + previous * (1 - quality)`，避免 shader 预乘造成 1–2 字节舍入变化。
- 光栅缓存持有一个 MRT render-target owner 和两个附件纹理；淘汰、上下文丢失与 dispose 只释放 owner 一次。缓存预算仍按 RGBA 4 byte + R8 1 byte/texel 计量。
- non-Resident、overlay、WebGL1、奇数尺寸兼容与诊断路径继续使用原双 pass，不扩大新路径适用范围。

## 跨路径审计

- GPU / shader：RGBA 与 R8 附件 framebuffer 完整；16 组 source alpha、mask、surface-lock、normal-check 真实 WebGL 对照均为 0 字节差异、无 shader error。
- CPU / Worker：质量候选、校准、读回转换、Top-K、coverage、后处理和 CPU 参考均未改变。512/4096、PNG/JPEG、完整 alpha 的整条冻结对照 RGBA/coverage/coveredPixels 全部一致。
- 缓存：独立 target 和共享 MRT target 都保留原 LRU、scope/context-loss 失效与硬预算；新增共享 owner 单次释放回归。
- 持久化 / 导出：不改 Layer/Project Schema、Command 幂等、Revision CAS、ownership、verified assets、Resident 压缩格式或 PNG/FBX/OBJ/GLB 输出。
- 质量边界：不降低 1K/2K/4K 分辨率，不关闭 QA、接缝、补边或呈现屏障。

## 性能证据与限制

- 约 26 万三角形、4K、6 层的隔离夹具：旧双 pass 为 12 draw / 3,133,440 提交三角，新 MRT 为 6 draw / 1,566,720，提交量减半。
- 直接对已推送 `6ac6eac` 的 4K 六层完整流程复测：旧约 1054/942ms，新约 1051/1000ms；来源准备和纹理上传占主导，设备波动内没有稳定的端到端提升。因此本变更只声明减少光栅提交，不把该样本描述为整体加速比例。

## 包体处理

与同期橡皮连续性提交合并后的首次正式构建为 `3,222,597 / 3,222,000`，超限 597 字节。未提高预算：颜色 pass 与 MRT 共用一条渲染主干，MRT 复用既有 target 工厂，质量读回复用单一入口；shader 内的说明迁到构建会剥离的 TypeScript 注释，公式和 GLSL token 不变。最终正式构建为 `3,220,943 / 3,222,000`，余量 1,057 字节。

## 迁移与回滚

无项目、Schema、资产或持久缓存迁移。回滚时删除 MRT shader/target 分支、恢复每个普通层的颜色与质量两次 draw，并把缓存 entry 恢复为两个独立 render target；已有图层、UV、缓存键和导出资产无需清理。
