# Editor Toolbar And Export Implementation

本文补充当前编辑器交互与导出代码位置。Undo/Redo 已接线；Paint 与 Eraser 必须按当前 feature exposure 单独判断。

## Dock Drag And Drop

- `WorkspacePanelHeader` 只从 drag handle 开始 panel drag。
- `dragInteractionStore` 区分 panel drag 与 asset-file drag。
- `WorkspaceDock` 是左/右 dock 的有效 drop target，顺序和侧边保存在 localStorage。
- 当前不是任意坐标 floating window；Reset Layout 恢复预设。
- Panel drag 不触发 viewport 模型 import overlay。

## Model Drop Boundary

贴图编辑器实际模型导入 filter 是 `.glb`、`.gltf`、`.fbx`、`.obj`。旧文档把 `.stl` 写成可拖入模型是错误的；STL 当前仅支持导出。

图片 drop 会进入当前活动对象的 reference workflow，而不是被当成模型。

## Bottom Toolbar

当前可达工具：

- Select、Move、Rotate、Scale。
- Project/accept generation 的相关动作由 Generate/Layer context 控制。
- Undo/Redo 根据编辑器 history 的 `canUndo/canRedo` 启用。
- Local repaint mask 使用 add、subtract、apply 等 mode，支持连续笔触和模型 silhouette/visibility clipping。
- Projected Layer Eraser 的底层参数、preview、commit 和 refinement 代码仍存在，但当前 `PROJECTED_ERASER_TOOL_ENABLED=false`：按钮不渲染，已有 eraser 状态会重置为 `none`。

普通自由绘制 Brush mode 当前会被重置/隐藏，Projected Layer Eraser 也未对用户开放，不应描述成完整 3D paint workflow 已交付。Quick Mask 与 Segments 仍未实现。

## Export Modules

主要代码位于 `apps/web/src/engine/export/`：

- `exportGltf.ts`：Scene/Object GLB。
- `exportFbx.ts`：Scene/Object binary FBX。
- `exportObj.ts`：Scene/Object OBJ/MTL。
- `exportStl.ts`：Scene/Object STL。
- `exportTexture.ts`：BaseColor 和已有 material normalMap。
- `exportSnapshot.ts`：Viewport PNG。
- `exportTurntable.ts`：5 秒 WebM turntable。
- `texturedExportUtils.ts`：exact stack cache、按需 projection bake、UV layer flatten 和 export material clone。

## Current Output

- Scene/Object：GLB、FBX、OBJ、STL。
- Texture：BaseColor；源材质存在 normalMap 时可导出 Normal。
- View：Viewport PNG。
- Video：浏览器支持时输出 WebM。

未实现：Segments ColorID、MP4、project package zip。

## Verification Checklist

1. Panel drag/refresh/reset，不触发模型导入 overlay。
2. GLB/glTF/FBX/OBJ 模型 drop；确认 STL 被拒绝为导入模型。
3. Projected + UV repair stack 下分别导出 BaseColor、GLB、FBX、OBJ。
4. 确认没有 exact cache 时导出按需 bake，重复导出可复用匹配 cache。
5. 在 Blender/3ds Max 验证 FBX，在标准 glTF viewer 验证 GLB。
6. 验证 Viewport PNG 不含 grid/paint helpers，WebM 旋转时 projected texture 不漂移。
