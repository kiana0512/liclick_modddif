# Web3D Engine Design

本文描述当前 3D 引擎实际组成。`apps/web/src/engine` 包含多数可复用引擎逻辑，但场景、UI 编排和性能策略仍有大量代码集中在 `ViewportCanvas.tsx`、`SceneRoot.tsx`、`EditorPage.tsx`、`GeneratePanel.tsx` 与 `ProjectedLayerMaterial.ts`，不能把“引擎已完全与 UI 分离”当作现状。

## Scene And Viewport

- `ViewportCanvas` 创建 R3F Canvas、相机、背景、覆盖 UI 和性能钩子。
- `SceneRoot` 挂载导入模型、灯光、Grid、显示材质、投影/UV 预览和选择逻辑。
- 没有导入模型时显示默认 primitive；真实模型以 `THREE.Group` 存在 `sceneStore`。
- 一个工程可有多个 `SceneObject`，贴图引擎一次处理当前活动对象。
- 导入归一化通过父 Group transform 完成，不重写源 geometry；记录源包围盒、归一化 transform 和用户 transform。

GLB/glTF 是主路径，FBX/OBJ 为实验性导入。当前贴图导入处理器不接受 STL，STL 只在导出矩阵内。

## Camera And Transform

- 支持 Perspective/Orthographic 相机状态与 OrbitControls。
- 相机快照包含 position、quaternion、target、near/far、fov/zoom、projection/view/world matrix 和 aspect。
- 导入后可自动 Fit Camera；Projected Layer 可恢复捕获相机。
- 底部工具支持 Select/Move/Rotate/Scale；拖动 TransformControls 时暂停 OrbitControls。
- Reset、Center、Ground 和 Fit Camera 已实现。
- ViewCube 与当前相机/Orbit target 同步，支持六个正交方向提示。

## Display Modes

- `PBR`：材质贴图、色彩管理、灯光与 tone mapping。
- `Flat`：无灯光 BaseColor/UV 观察。
- `Normal`：表面法线调试显示；不代表 Normal Map 生成结果。
- `Wire`：线框显示。
- `Segments`：工作区入口仍为占位，没有真实 segment material/ColorID 数据。

Normal 可视化已实现；Normal 生成未接线。顶部 Texture/Normal/Segments/Export 是工作区模式，不是四套独立渲染器。

## Capture Engine

当前捕获使用离屏 WebGL render target，并在每次 pass 后恢复场景状态：

- Color：当前选定对象的干净模型视图。
- Mask：目标对象白色、背景黑色。
- Depth：PNG 编码的线性 view-space depth，记录 `depthEncoding='linear-view'`。
- Normal：几何法线可见性图。

捕获结果使用异步 Blob/PNG 路径；本地/服务工程把二进制写入 `assets/captures`，项目 JSON 只保存 URL/相对路径。

## Projected Layer Shader

`ProjectedLayerMaterial.ts` 是 LI3D 自研 shader 实现；当前依赖中没有 `three-projected-material`。

每个可见 Projected Layer 使用保存的相机和对象矩阵，将当前 world position 投回生成图。样本会经过：

1. projector frustum 与 image bounds；
2. 普通生成层使用 source alpha，不把 capture mask 烘入图片或再次挂到图层；
3. linear depth 与显式启用的 normal 邻域可见性；局部重绘、表面锁定和用户擦除另用专用蒙版；
4. backface/facing 和边缘衰减；
5. opacity、projection strength 与 HSL adjustments。

Blend 层按质量组合强候选，Overlay 层按图层顺序覆盖。没有有效投影样本时回退到 base/imported material。Shader 同时处理 capture 时对象矩阵与当前矩阵的 delta，使视口旋转和 WebM turntable 中的投影继续贴在模型表面。

为了控制 sampler、显存与构建成本，大投影栈会使用 texture arrays、缓存和 live-preview guard。极大未合并栈不保证无限实时叠加。

## Multiview

多视图已在 `GeneratePanel` 实现为编排层：生成相机批次、批量捕获、为每个视角调用 single-view API、保存 batch metadata、自动提交 Projected Layer，并在批次后触发内容识别补缝。它不是底层 `generateMultiview()` 的单请求实现。

## Local Repaint, Seam Harmonization, And Hidden Eraser

- Local repaint 在捕获相机空间编辑连续遮罩，Mask 被模型 silhouette、depth/normal 和表面可见性约束。
- 默认 enhanced seam mode 在 Worker 中用保存的 flat viewport reference、生成结果和 authored mask 做局部边缘色彩融合；raw result 与 harmonized result 同时保留，Worker/decode/persistence 失败回退原图，`legacy` mode 可用于诊断。
- 远端返回图只允许写入用户 authored mask；保存可替换源图层或创建持久 UV repair layer。
- 内容识别填充/补缝使用 UV coverage 数据生成 underlay/repair layer。
- Projected Layer Eraser 的完整 preview/commit/refinement engine 仍保留，但当前发布的 `PROJECTED_ERASER_TOOL_ENABLED=false`，UI 不显示且不能保持激活。普通自由 Brush 也未作为正式工具开放。

## UV Merge And Export Bake

- 用户在 Layers 面板选择投影/UV 源，手动合并为新 UV layer，或写入选定空白 UV layer。
- 投影到 UV 使用 GPU-first UV-space bake；必要时走 CPU parity/fallback，并执行受 UV 拓扑约束的 gutter/seam 处理。
- 合并会先预热最终贴图，再原子切换图层可见性，减少白模闪烁。
- 导出会查找与当前 visible stack、分辨率和选项匹配的 baked cache；没有精确结果时按需 bake，再叠加 visible UV layers。
- 当前没有用户级全局 Auto UV bake toggle，也不会仅因新增投影层就统一后台 flatten。

## Current Engine Limits

- 贴图编辑一次针对一个活动对象和一个 `uv` channel；无 UDIM。
- 贴图编辑器 UV bake/merge 主要输出 BaseColor；Normal/Roughness/Metallic 属于独立烘焙模块或未来贴图能力。
- 高分辨率结果受浏览器内存、GPU texture size、readback、PNG encoding 和上传开销限制。
- 核心文件职责过重，后续重构必须用现有 smoke/performance protocol 保证 shader、UV orientation、mask permission 和任务恢复不回退。
