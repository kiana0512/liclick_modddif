# 函数与阶段覆盖清单

FUNCTION-TIMING/1.0.0，2026-09-28。主模块 M13/M15，无业务算法变更。此清单是明确边界，不表示自动覆盖全仓每个函数。

## DEBUG 构建期函数计时

实现清单位于 apps/web/scripts/function-timing.mjs；构建和测试在指定函数不存在时失败，防止改名后静默遗漏。函数调用者沿原业务代码不变，记录静态源码路径#函数名，无运行时堆栈采样。

| 文件（apps/web/src/ 下） | 函数 |
| --- | --- |
| engine/loaders/loadModelFromFile.ts | loadModelFromFile |
| engine/loaders/processModelImport.ts | processModelImport |
| engine/loaders/modelLoadUtils.ts | summarizeLoadedGroup、getImportedBaseColorTextureUrl |
| engine/capture/captureCurrentView.ts | captureCurrentView |
| engine/capture/captureColor.ts | captureColor |
| engine/capture/captureMask.ts | captureMask |
| engine/capture/captureNormal.ts | captureNormal |
| engine/capture/captureDepth.ts | captureDepth |
| engine/capture/renderTargetUtils.ts | renderSceneToPngUrl、renderScenePassesToPngUrl |
| engine/generation/contentFramingRestore.ts | restoreContentFraming |
| engine/generation/singleViewAutoProjection.ts | persistProjectionCommit |
| engine/projection/compileForRenderTarget.ts | compileForRenderTarget |
| services/workspaceApiClient.ts | createProject、loadProject、saveProject、uploadBlobAsset |
| services/liclickApiClient.ts | prepareReferences、requestJson |
| services/modelviewApiClient.ts | requestJson |
| engine/viewport/input.ts | interactionSafeJsonResponse、interactionSafeBlobDataUrl |

## 显式阶段与异步关联接入

以下业务文件保留阶段边界、上下文或 Worker 传递；阶段名不是自动推断的 CPU/GPU 耗时。Generation 的 operation/batch/view/attempt 由 generationEntry/generationTrace 观察真实入口、状态和保存 ACK；请求/捕获/回贴等已存在边界通过显式上下文关联。编译期函数 scope 按静态阶段归组，不用全局 async 父栈猜测调用树。

- apps/web/src/App.tsx
- apps/web/src/components/panels/GeneratePanel.tsx
- apps/web/src/components/panels/ReferenceGroupPicker.tsx
- apps/web/src/components/panels/ReferenceImagePicker.tsx
- apps/web/src/engine/bake/gpuUvBakeRenderer.ts
- apps/web/src/engine/bake/qualityBlendWorker.ts
- apps/web/src/engine/bake/webGpuUvTopologyRaster.ts
- apps/web/src/engine/capture/captureCurrentView.ts
- apps/web/src/engine/capture/gpuReadbackPngWorker.ts
- apps/web/src/engine/capture/renderTargetUtils.ts
- apps/web/src/engine/generation/contentFramingRestore.ts
- apps/web/src/engine/generation/singleViewAutoProjection.ts
- apps/web/src/engine/loaders/loadFbxModel.ts
- apps/web/src/engine/loaders/loadGltfModel.ts
- apps/web/src/engine/loaders/loadModelFromFile.ts
- apps/web/src/engine/loaders/loadObjModel.ts
- apps/web/src/engine/loaders/modelLoadUtils.ts
- apps/web/src/engine/loaders/processModelImport.ts
- apps/web/src/engine/performance/performanceTimeline.ts
- apps/web/src/engine/performance/webGpuRgbaComposite.ts
- apps/web/src/engine/projection/ProjectedLayerPreviewCompositor.ts
- apps/web/src/engine/projection/compileForRenderTarget.ts
- apps/web/src/engine/projection/residentUvPresentation.ts
- apps/web/src/engine/session/engineSession.ts
- apps/web/src/engine/viewport/input.ts
- apps/web/src/routes/EditorPage.tsx
- apps/web/src/services/liclickApiClient.ts
- apps/web/src/services/modelviewApiClient.ts
- apps/web/src/services/projectSaveCoordinator.ts
- apps/web/src/services/workspaceApiClient.ts
- apps/web/src/workers/encodeGpuReadbackPng.worker.ts
- apps/web/src/workers/payload.worker.ts
- apps/web/src/workers/qualityBlend.worker.ts
- apps/web/src/workers/webGpuRgbaComposite.worker.ts
- apps/web/src/workers/webGpuUvTopologyRaster.worker.ts

## 排除与限制

归档提交合入 origin/master 后，参考图读取/尺寸计时随远端去重迁至 services/referenceImagePreprocessor.ts 的 blobToDataUrl 和 utils/imageSize.ts 的 getImageSize；保留远端压缩及错误处理，两个 Picker 只保留角色选择计时。

- 第三方库内部、React render、像素/顶点循环、shader 内核、未列出的底层 helper 不自动插桩。
- Node/Blender/远端推理内部不在新版范围；客户端请求/等待可见，不构造 queue/inference。
- Worker 仅本地任务/函数 wall，与主线程往返分别展示，无跨时钟对齐。
- 刷新冷启动前段及开始录制前已完成工作不补造；刷新默认 off。
- 任一阶段的父子/并发记录不能相加为流程总耗时；显示 complete 只指已观测记录结束，不表示所有业务视角成功。
