# 拓扑工作流与模型预览更新说明

- 更新日期：2026-08-10
- 涉及模块：贴图、拓扑、UV、烘焙、参考图导入、模型预览

## 1. 拓扑界面整体重构

拓扑界面调整为三栏布局：

- 左侧为模型输入。
- 中间为全屏模型预览。
- 右侧为历史结果。

中央视窗会根据任务阶段切换显示内容：

- 拓扑开始前显示高模。
- 拓扑处理中显示统一任务状态。
- 拓扑完成后仅显示当前拓扑低模结果。

模型视窗支持旋转、缩放、自动居中和自适应相机距离，并增加模型面数、顶点数信息。下载模型和“传入 UV”操作固定在中央视窗底部。

点击顶部“UV”入口时，系统会先将当前拓扑低模传入 UV 工作区，再完成界面切换。

主要文件：

- [AssetProcessingPage.tsx](../apps/web/src/routes/AssetProcessingPage.tsx)
- [AssetModelViewport.tsx](../apps/web/src/features/workflow/AssetModelViewport.tsx)

## 2. 拓扑历史记录改版

历史记录调整为以模型缩略图为主的网格布局，每行显示三个正方形缩略图。

- 点击缩略图可直接在中央视窗预览对应结果。
- 处理中的任务显示统一状态卡和进度条。
- 失败任务显示失败占位图。
- 当前任务与历史记录共享同一份实时进度数据，避免同一任务在不同位置显示不一致。
- 模型缩略图采用延迟加载，减少页面打开时的一次性模型解析压力。

主要文件：

- [HistorySidePanel.tsx](../apps/web/src/components/history/HistorySidePanel.tsx)
- [modelPreviewAssets.ts](../apps/web/src/features/workflow/modelPreviewAssets.ts)

## 3. FBX 模型预览修复

修复模型在 Blender 中正常、但在网页拓扑视窗中显示异常的问题。

- 根据可见几何体的包围盒自动居中、缩放和对焦。
- 修复模型远离原点时相机落入模型内部的问题。
- 修复 FBX 凹多边形被错误地按三角扇切割，导致预览出现大块假面的问题。
- 读取并恢复 FBX 节点的 `Visibility` 属性，避免隐藏节点在网页预览中错误显示。
- 统计信息、包围盒计算和相机对焦均忽略隐藏几何体。
- 补充凹面重建、隐藏几何包围盒和 FBX 可见性测试。

主要文件：

- [repairFbxPreviewGeometry.ts](../apps/web/src/features/workflow/repairFbxPreviewGeometry.ts)
- [fbxVisibility.ts](../apps/web/src/engine/loaders/fbxVisibility.ts)
- [loadFbxModel.ts](../apps/web/src/engine/loaders/loadFbxModel.ts)
- [repairFbxPreviewGeometry.test.mjs](../apps/web/src/features/workflow/__tests__/repairFbxPreviewGeometry.test.mjs)
- [fbxVisibility.test.mjs](../apps/web/src/engine/loaders/__tests__/fbxVisibility.test.mjs)

## 4. 参考图导入流程

上传或拖入图片后，先弹出用途选择对话框：

- 传入作为单视图。
- 传入作为多视图。
- 关闭并取消导入。

用户完成选择后，系统会自动设置对应的参考图类型。编辑器、参考图组选择器和独立参考图选择器均接入该流程。

主要文件：

- [ReferenceImportDialog.tsx](../apps/web/src/components/panels/ReferenceImportDialog.tsx)
- [ReferenceGroupPicker.tsx](../apps/web/src/components/panels/ReferenceGroupPicker.tsx)
- [ReferenceImagePicker.tsx](../apps/web/src/components/panels/ReferenceImagePicker.tsx)
- [EditorPage.tsx](../apps/web/src/routes/EditorPage.tsx)

## 5. 贴图到拓扑流程

删除独立的“完成并传入拓扑”按钮，将功能合并到顶部“拓扑”入口。

- 点击“拓扑”时，自动传入当前或选中的贴图模型。
- 没有显式选中对象时，自动使用当前导入模型作为传入对象。
- 跳转期间显示等待状态并阻止重复点击。
- 缺少可传入模型时显示明确提示。

主要文件：

- [EditorPage.tsx](../apps/web/src/routes/EditorPage.tsx)
- [WorkflowModuleSwitcher.tsx](../apps/web/src/features/workflow/WorkflowModuleSwitcher.tsx)

## 6. 烘焙贴图资源读取

高模 Base Color 和烘焙采样图片改用工作区资源接口读取。

- 正确解析项目相对路径和远程工作区资源地址。
- 通过带凭证的工作区请求获取 HTTP 图片，并在采样前转换为 Blob。
- 使用临时 Object URL 加载采样图片，完成后立即释放。
- 减少跨域、身份凭证缺失和临时 URL 失效造成的读取失败。
- 改进 Base Color 和投射图层读取失败时的错误信息。

主要文件：

- [imageSampler.ts](../apps/web/src/engine/bake/imageSampler.ts)
- [BakeWorkspacePage.tsx](../apps/web/src/routes/BakeWorkspacePage.tsx)

## 7. 跨工作流 Base Color 资源固化

贴图模型传入拓扑时，自动将当前 Base Color 保存为项目内的固定资源，避免后续拓扑、UV 或烘焙模块继续依赖已经失效的临时地址。

- 支持实时投射画布、Blob URL、项目相对路径和远程工作区资源。
- 将实时画布或临时对象地址转换为可持久化的图片资源。
- 同步记录资源 URL、项目相对路径和实际 MIME 类型。
- 后续流程统一引用固化后的 Base Color 快照，降低跨模块读取时出现 `403` 或资源失效的概率。

主要文件：

- [EditorPage.tsx](../apps/web/src/routes/EditorPage.tsx)
- [imageSampler.ts](../apps/web/src/engine/bake/imageSampler.ts)
- [BakeWorkspacePage.tsx](../apps/web/src/routes/BakeWorkspacePage.tsx)

## 8. 其他界面调整

- 降低视角方块的渲染层级，使其始终位于功能面板下方。
- 工作流切换入口增加处理中状态。

主要文件：

- [ViewCube.tsx](../apps/web/src/engine/viewport/ViewCube.tsx)
- [WorkflowModuleSwitcher.tsx](../apps/web/src/features/workflow/WorkflowModuleSwitcher.tsx)

## 9. 高模删除与预览堆积修复

修复左侧删除当前高模后，中央视窗仍回退显示旧上游模型的问题。

- 中央高模预览仅使用左侧当前模型列表作为数据源。
- 删除最后一个高模后立即卸载中央视窗中的旧模型并清空统计信息。
- 删除上游初始模型时同步清除父级残留引用，避免组件重新挂载后旧模型再次出现。
- 切换或删除输入时清理结果预览、历史选择、加载状态和错误状态，避免新旧模型叠加。

主要文件：

- [AssetProcessingPage.tsx](../apps/web/src/routes/AssetProcessingPage.tsx)
- [AssetModelViewport.tsx](../apps/web/src/features/workflow/AssetModelViewport.tsx)

## 10. 自动烘焙实时投射纹理修复

修复局部重绘图层在视窗中显示正常、但自动烘焙提示 `Could not load projected layer image for baking (relative URL)` 的问题。

- 自动烘焙采样器同时支持实时 Canvas 与实时 Image 纹理。
- 不再将 `liclick-live-projected-canvas:` 内存纹理误判为普通相对 URL。
- 自动保存时可将两类实时纹理统一编码为 PNG 并固化到项目资源。
- 贴图传入拓扑时同样支持固化实时 Image 类型的 Base Color。
- 增加实时图片采样与 PNG 固化测试。

主要文件：

- [imageSampler.ts](../apps/web/src/engine/bake/imageSampler.ts)
- [liveProjectedCanvasTextureRegistry.ts](../apps/web/src/engine/projection/liveProjectedCanvasTextureRegistry.ts)
- [EditorPage.tsx](../apps/web/src/routes/EditorPage.tsx)
- [liveProjectedCanvasTextureRegistry.test.mjs](../apps/web/src/engine/projection/__tests__/liveProjectedCanvasTextureRegistry.test.mjs)

## 11. 局部重绘颜色一致性修复

修复局部重绘生成图应用到模型后整体变暗、与生成完成时的参考效果图颜色不一致的问题。

- 局部重绘生成图统一按已经包含视窗光照和曝光的最终显示颜色处理。
- 实时 GPU 投影、保存后的投影图层以及转为 UV 后的覆盖层使用相同颜色语义。
- 避免生成图在模型视窗中再次乘以环境光和主光，消除二次光照造成的暗化。
- 兼容旧项目：即使历史局部重绘层保存了 `renderedColor: false`，也会依据图层 ID、角色和资源标识自动恢复正确显示。
- 增加普通基础色图层与旧版局部重绘层的颜色语义回归测试。

主要文件：

- [ViewportCanvas.tsx](../apps/web/src/engine/viewport/ViewportCanvas.tsx)
- [SceneRoot.tsx](../apps/web/src/engine/viewport/SceneRoot.tsx)
- [renderedLayerColor.ts](../apps/web/src/engine/viewport/renderedLayerColor.ts)
- [test-projected-layer-visibility.mjs](../apps/web/scripts/test-projected-layer-visibility.mjs)

## 12. 验证结果

- FBX 可见性与凹面预览相关测试共 6 项，全部通过。
- Web TypeScript 类型检查通过。
- Web 生产构建通过。
- 实际界面完成“导入高模 → 删除当前高模 → 中央视窗清空”流程验证。
- 使用项目 `424` 的临时副本完成 2048px 可见投射层合并，成功生成“合并 UV 图层”，未再出现相对 URL 错误；验证副本随后已删除。
- 局部重绘颜色语义回归测试通过，确认旧版局部重绘层跳过二次视窗光照，普通基础色图层仍保留正常光照。
