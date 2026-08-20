# Export Matrix

本表描述贴图编辑器当前导出能力。独立 Model Baking 工作台的远端 artifacts 不在本表中。

| Group | Format | Status | Notes |
| --- | --- | --- | --- |
| Scene | GLB | Implemented | 导出导入模型 roots，不含 grid/editor lights；嵌入准备后的 BaseColor |
| Scene | FBX | Implemented | 本地 binary FBX 7400 writer；需持续做 Blender/3ds Max 回归 |
| Scene | OBJ | Implemented | 输出 OBJ/MTL，并将 BaseColor PNG 放在旁边 |
| Scene | STL | Implemented | 几何导出；STL 不承载材质贴图 |
| Object | GLB/FBX/OBJ/STL | Implemented | 仅当前选中对象 |
| Texture | BaseColor PNG | Implemented | 使用 exact cached stack；缺失时为当前 visible projected stack 按需 bake，并叠加 visible UV layers |
| Texture | Normal PNG | Partial | 仅当导入材质实际存在 `normalMap` 时启用；不会生成 Normal |
| Texture | Segments/ColorID | Not implemented | 没有真实 segmentation 数据 |
| View | Viewport PNG | Implemented | 从 WebGL canvas 截图，隐藏编辑器 helper/overlay |
| Video | WebM turntable | Implemented where supported | 5 秒、360°；依赖 `MediaRecorder`/`captureStream` |
| Video | MP4 | Not implemented | 浏览器原生 MVP 只输出 WebM |
| Project | `.liclick3d` zip | Not implemented | 便携包仍是规划能力 |

## Textured Model Preparation

GLB/FBX/OBJ 走 `prepareTexturedModelExport`：

1. 读取当前对象的 visible Projected Layers。
2. 按对象、分辨率、source revisions、visible stack 和 export options 查找 exact baked cache。
3. 没有 cache 时执行 export-on-demand projection bake；这不依赖已移除的 Auto UV bake toggle。
4. 读取 visible UV layers；`merged-uv` 会作为明确 base，其他 repair/underlay layers 按规则合成。
5. 克隆 export root，应用 `Liclick_BaseColor` material，避免修改编辑器运行时 scene。

Local repaint projection mask 会先 flatten 到 source alpha，再进入 export bake，防止 live canvas mask 丢失后把完整生成图烘入模型。

## Format Notes

- GLB 使用 `GLTFExporter`，贴图随材质嵌入。
- OBJ 使用 `OBJExporter`/MTL 辅助流程，PNG 与文件组一起下载。
- STL 只适合几何，不应期待 BaseColor。
- FBX 使用仓库本地 writer，并带当前 DCC 兼容 scale/material/UV/normal 处理；它不是 Three.js 官方 exporter。
- Turntable 每帧同步 projected shader 的对象矩阵 delta，使实时投影在旋转模型上保持附着。

## Required Regression Checks

- 侧视/非对称 UV 模型的 `flipY` 与纹理方向。
- Projected + UV repair 混合后，Viewport/BaseColor/GLB/FBX/OBJ 结果一致。
- 导出期间生成 exact bake 后，项目 cache/source layer 状态不丢失。
- FBX 在 Blender 和 3ds Max 中的 mesh、scale、UV、normal、material 与 texture。
