# Capture And Projection Design

## Capture Contract

每个 Capture 绑定活动对象和完整相机快照：position、quaternion、target、near/far、fov/zoom、projection/view/world matrices 与 aspect。对象在生成时的 `matrixWorld` 另存于 Generation/Layer metadata，用于后续变换补偿。

当前 pass：

- `color`：用于模型视图参考的干净颜色捕获。
- `mask`：目标对象 silhouette。
- `depth`：线性 view-space depth，PNG 编码并标记 `depthEncoding='linear-view'`。
- `normal`：几何法线辅助资产。当前实时投影与局部重绘默认以 linear-view Depth 为可见性权威，Normal 校验需要显式启用。

捕获使用离屏 WebGL render target，临时替换材质/显隐后恢复原场景。PNG 通过异步 Blob 路径编码；服务工程再把资产物化到 `assets/captures`。

多视图捕获会先准备整个相机批次，再批量持久化 Capture，避免生成任务并发完成时丢失某个视角的相机/深度数据。

## Projection Back To Model

Projected Layer 保存 source image、camera、object matrix、Mask、Depth、Normal 和图层参数。Shader 对每个当前 fragment：

1. 使用保存相机将 world position 投影到 clip/image UV。
2. 拒绝 projector 后方、frustum 外和图片边界外样本。
3. 普通生成层应用原始 source alpha，不把 capture mask 烘入图片或绑定到图层；局部重绘、表面锁定和用户擦除继续应用各自的专用蒙版。
4. 比较 projected view depth 与捕获的 linear-view depth；缺失/legacy depth 才后台重建。Normal 邻域仅在显式 opt-in 时参与拒绝。
5. 使用插值顶点法线计算连续 backface/facing 与 edge feather，再应用 opacity、strength 和 HSL adjustments；禁止用 triangle-constant 法线或 hard step 写入边缘 alpha。
6. 将 Blend candidates 按质量合成，再按顺序加入 Overlay layers。
7. 没有覆盖时投影 alpha 为 0，保留既有底层显示，不生成额外白/灰占位色。

对象从 capture transform 发生变化时，shader 使用保存矩阵到当前矩阵的 delta 修正投影。该机制同样用于模型旋转的 WebM turntable。

### Preview Residency And Performance

- 所有持久化 Projected Layer 进入同一个最终 texture-array material；没有单视角临时材质和延迟替换阶段。
- 图层眼睛与 opacity 只更新 resident material 的 uniform，切换不重建数组、不重新编译 shader。
- authored linear-view Depth 不会被稍后的低分辨率 runtime pass 覆盖。缺失/legacy visibility 的后台修复默认只生成 Depth。
- 各数组独立分配精度预算；准备在 worker 执行，GPU upload 分 stripe 并逐帧让出，避免阻塞相机和画笔交互。

## Multiview

当前 multiview 是多个独立相机/捕获/Generation/Projected Layer 的批次：

- 支持 6、10、14 和自定义视角数量。
- 每个视角都调用 single-view generation endpoint。
- 批次共享 `textureBatchId`，并保存 view id/label/camera metadata。
- 成功视角自动投影；批次完成后尝试 UV coverage 内容识别补缝。
- 视角失败可以部分成功，任务恢复逻辑会补建缺失的 durable projected layer。

## UV-space Projection

手动 UV merge、内容补缝、局部修补和 export-on-demand 共用底层 projection bake 能力，但提交策略不同。

GPU-first UV path：

1. 在目标模型 UV 空间绘制 triangles。
2. 重构 world position/normal。
3. 对每个 projected source 执行与实时预览一致的 depth-authoritative、连续 coverage rules；surface-locked local repaint 不默认启用 flat Normal 拒绝。
4. 输出 coverage/quality 与 straight RGBA。
5. 按用途进行受 UV topology 约束的 gutter、hole、seam repair。
6. 必要时运行 CPU parity/fallback。

UV orientation 按当前 Three.js/glTF 路径使用 `texture.flipY = false`。任何 orientation 改动都必须同时验证视口、PNG、GLB、FBX 和 OBJ。

## Accuracy And Limits

- Depth 已由旧 grayscale 近似升级为 PNG 编码的 linear-view depth，但仍受捕获分辨率、量化、邻域容差和透明材质影响。
- 当前目标是一项活动对象、一个 `uv` channel；无 UDIM。
- 投影 visibility 不是 ray-traced ground truth，极薄表面、重叠面、透明/双面材质和强 grazing angle 仍需回归测试。
- 大 multiview 栈受 WebGL sampler、texture-array、显存与编译时间限制，系统会缓存并限制 live preview，而不是承诺无限层实时合成。
- Texture editor 的 UV output 以 BaseColor 为主；PBR 多通道烘焙属于独立 Bake Workspace。
