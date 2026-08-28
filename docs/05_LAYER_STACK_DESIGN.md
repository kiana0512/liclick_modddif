# Layer Stack Design

图层栈是贴图编辑器的核心非破坏数据模型。当前实现同时管理 Projected Layer 和 UV Layer；`patch`/`normal` 类型存在于契约中，但主 UI 的生产路径主要落为 projected 或 uv role。

## Layer Types And Roles

- `projected`：带捕获相机/对象矩阵的相机投影图；可包含 projection-space mask、linear depth 和 normal visibility。
- `uv`：已经位于目标对象 UV 空间的纹理，不需要相机投影。
- `patch`：类型契约保留给局部 patch；当前局部重绘通常先用 transient projected patch，再提交为 UV repair layer。
- `normal`：类型契约已定义，但 Normal generation 尚未成为正式图层流程。

常用 UV roles 包括 `base-color`、`merged-uv`、`local-repaint-overlay` 和 `content-aware-underlay`。

## Current UI

Layers 面板当前支持：

- 单选/多选、缩略图与活动层。
- 可见性（包括拖动批量切换）、opacity、projection strength。
- Blend/Overlay 切换和 HSL 调整。
- Projected Layer 的 Go to Camera。
- 删除选中层。
- 对图层图像执行本地重绘、编辑/替换等上下文操作。
- 将选中 Projected/UV sources 合并成新 UV layer。
- 将选中 sources 合并到指定空白 UV layer。
- 撤销/重做由编辑器 history 驱动，按钮根据 `canUndo/canRedo` 启用。

旧文档中的“rename placeholder”“go-to-camera placeholder”和“点击 Bake Active Layer 重新烘焙”已不再代表当前主工作流。

## Projected Preview Composition

同一对象的可见 Projected Layers 会进入 shader stack：

- Blend 候选按覆盖与质量组合，适合多视图重叠。
- Overlay 按图层顺序覆盖 Blend 结果。
- mask/depth/normal/backface/frustum/source-alpha 决定表面样本是否有效。
- 无有效样本处回退到 imported/base material。

Layer opacity、strength、blend、adjustments 或 source 内容变化会改变 stack identity；已有 baked cache 只有在 source layer revisions、可见栈、对象、分辨率和导出选项完全匹配时才可复用。

## UV Layers And Merge

UV layers 直接覆盖目标对象 UV。手动合并流程：

1. 选中一个或多个 Projected/UV layers。
2. Projected sources 通过 UV-space bake 变成透明 RGBA。
3. UV sources 按编辑器合成规则加入结果。
4. 进行受 UV topology 约束的 gutter/seam 处理与 PNG 编码。
5. 预热最终 texture 后创建/更新 `merged-uv` layer，并隐藏已被消费的 source layers。

本地重绘提交和内容识别补缝也会创建专用 UV layers，但不会冒充完整 BaseColor flatten。

## Bake Semantics

- 当前没有用户级 Auto UV bake 开关。
- 新增 Texture Map 结果会自动建立实时 Projected Layer，不会因为旧的全局设置自动 flatten 全栈。
- 用户通过 Layers 面板显式合并 UV。
- GLB/FBX/OBJ/BaseColor 导出会在需要时按当前可见 projected stack 生成精确 baked texture，并叠加 visible UV layers。
- `isBaked`、`bakedTextureId`、`bakedAt`、`needsRebake` 仍作为 cache/兼容字段存在；不能据此恢复已移除的 UI toggle。

## Persistence

项目 JSON 保存图层元数据；图片、mask、depth、normal 和 merged output 在 local-server/local-component 工程中物化到资产目录。Live canvas/blob 数据必须在关键保存点转为 durable asset，避免刷新后丢失遮罩或投影来源。
