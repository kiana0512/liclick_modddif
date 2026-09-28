# 旧方案恢复清单（历史）

2026-09-28，主模块 M13/M15；本轮仅整理文档和 stash，无算法变更。以下为整理前 180 个 Git 可见文件，清单自身不计入；忽略文件（例如 .codex-tmp）不在统计内。

## 当前决策

- 旧方案停止扩展；2026-09-28 用户授权的轻量方案已写入 proposal/design/spec/tasks/adr。
- 当前已按新版收敛，下面 180 个文件仅用于追溯恢复时的旧范围，包含现已移除的重型模块。当前能力与验收见 implementation-status.md 和 coverage.md，旧验收记录不作为新版通过依据。
- 代码和维护文档主要服务于本项 OpenSpec。自动化先于 Trace 建立，可独立保留；A/B 捕获报告、HTML、字体及相关临时脚本不是 Trace 产品实现，不应混入同次提交。
- 文件原位保留，不移动业务文件、不修改 .gitignore、不自动暂存或提交。

## 恢复来源与备份

旧 stash 0（bfd357849961a181e211d94d128431a68241f554）保存剩余本地材料；旧 stash 1（25372ce0f40a7bc38ee14ee9bb74b61478a92e31）保存 Trace 和自动化主体，两者共用 11 个 OpenSpec 文件。更早三份 stash 没有应用到当前工作区。

全部五份 stash 导出到本机仓库外 D:/li3d-stash-backups/20260928-104747/all-stashes.bundle。manifest 保存原名称与提交 ID；该增量 bundle 依赖原仓库基线提交，已通过 git bundle verify。恢复步骤见同目录 RECOVERY.md。清空 stash 不删除当前工作区内容。

## 下一次修改的边界

1. 按已重写的 proposal/design/spec/tasks 实施收敛；默认关闭，旧任务勾选不继承。
2. 按新 spec 清理 Perfetto 导出、相关 UI 和验证，不能仅隐藏按钮。
3. 新版已移出跨端时钟、独立诊断数据库、断网续传与资源生命周期台账；后续清理对应代码，不自动删除已存在的诊断数据。
4. CLI 和内置浏览器业务自动化可独立保留，Trace 输出耦合需单独处理。

## 已知未完成项

恢复后 test-interaction-safe-service-results.mjs 报 import.meta 在非模块上下文加载错误；captureDepth.ts 有行尾空白。master 与旧实现基线不同，过去测试通过不代表恢复后的完整验收。本轮不修复实现、不运行付费生图、不执行数据库迁移、不发布；回退本轮整理只需还原 README 并移除本清单。

## 方案与维护文档（20 个）

- 修改：AGENTS.md
- 修改：CHANGELOG.md
- 修改：docs/00_SYSTEM_MODULES_AND_CHANGE_STANDARD.md
- 修改：docs/00_SYSTEM_REVISION_LOG.md
- 修改：docs/README.md
- 新增：docs/changes/CHG-20260922-PIPELINE-TRACE-FOUNDATION.md
- 新增：docs/changes/CHG-20260922-REAL-WORKFLOW-AUTOMATION.md
- 新增：docs/changes/CHG-20260922-TRACE-PROPOSAL-REVIEW.md
- 新增：docs/changes/CHG-20260923-PIPELINE-TRACE-IMPLEMENTATION.md
- 新增：openspec/changes/add-generation-pipeline-tracing/.openspec.yaml
- 新增：openspec/changes/add-generation-pipeline-tracing/README.md
- 新增：openspec/changes/add-generation-pipeline-tracing/adr.md
- 新增：openspec/changes/add-generation-pipeline-tracing/design.md
- 新增：openspec/changes/add-generation-pipeline-tracing/implementation-status.md
- 新增：openspec/changes/add-generation-pipeline-tracing/proposal.md
- 新增：openspec/changes/add-generation-pipeline-tracing/specs/generation-pipeline-tracing/spec.md
- 新增：openspec/changes/add-generation-pipeline-tracing/tasks.md
- 新增：openspec/changes/archive/.gitkeep
- 新增：openspec/config.yaml
- 新增：openspec/specs/.gitkeep

## Trace 实现与测试（114 个）

- 修改：apps/server/package.json
- 新增：apps/server/scripts/serve-pipeline-trace-test.mjs
- 新增：apps/server/scripts/test-blender-trace.mjs
- 新增：apps/server/scripts/test-pipeline-trace.mjs
- 修改：apps/server/scripts/test-reference-delight-pipeline.mjs
- 新增：apps/server/sql/005_pipeline_trace.sql
- 修改：apps/server/src/auth/atlasAuthService.ts
- 修改：apps/server/src/index.ts
- 新增：apps/server/src/repositories/pipelineTraceRepository.ts
- 修改：apps/server/src/repositories/postgresProjectRepository.ts
- 修改：apps/server/src/routes/importUvRepair.ts
- 新增：apps/server/src/routes/pipelineTrace.ts
- 修改：apps/server/src/services/modelviewInpaintService.ts
- 新增：apps/server/src/services/tracing/blenderTrace.ts
- 新增：apps/server/src/services/tracing/nodeTrace.ts
- 修改：apps/server/src/services/webFrontendService.ts
- 修改：apps/web/package.json
- 新增：apps/web/scripts/pipeline-trace-test-build.mjs
- 修改：apps/web/scripts/test-capture-renderer-isolation.mjs
- 修改：apps/web/scripts/test-content-framing.mjs
- 修改：apps/web/scripts/test-gpt-multiview-pairs.mjs
- 修改：apps/web/scripts/test-gpt-repaint-normal.mjs
- 修改：apps/web/scripts/test-modelview-normal-input.mjs
- 修改：apps/web/scripts/test-normal-capture-material.mjs
- 新增：apps/web/scripts/test-pipeline-trace.mjs
- 修改：apps/web/scripts/test-projection-performance-safety.mjs
- 修改：apps/web/scripts/test-quality-blend-resources.mjs
- 修改：apps/web/scripts/test-remote-multiview-sequential.mjs
- 修改：apps/web/scripts/test-resident-uv-display.mjs
- 修改：apps/web/scripts/test-resident-uv-visibility-scheduling.mjs
- 修改：apps/web/scripts/test-single-view-auto-projection.mjs
- 修改：apps/web/scripts/test-single-view-texture-completion.mjs
- 修改：apps/web/scripts/test-underlay-reuse.mjs
- 修改：apps/web/scripts/test-uv-raster-layer-keys.mjs
- 修改：apps/web/scripts/test-uv-topology-reuse.mjs
- 修改：apps/web/scripts/test-uv-underlay-cache.mjs
- 修改：apps/web/scripts/test-workspace-asset-upload-queue.mjs
- 修改：apps/web/src/App.tsx
- 修改：apps/web/src/components/panels/GeneratePanel.tsx
- 修改：apps/web/src/components/panels/ReferenceGroupPicker.tsx
- 修改：apps/web/src/components/panels/ReferenceImagePicker.tsx
- 修改：apps/web/src/engine/bake/ProjectedUvRasterCache.ts
- 修改：apps/web/src/engine/bake/gpuUvBakeRenderer.ts
- 修改：apps/web/src/engine/bake/qualityBlendWorker.ts
- 修改：apps/web/src/engine/bake/webGpuUvTopologyRaster.ts
- 修改：apps/web/src/engine/capture/captureColor.ts
- 修改：apps/web/src/engine/capture/captureCurrentView.ts
- 修改：apps/web/src/engine/capture/captureDepth.ts
- 修改：apps/web/src/engine/capture/captureMask.ts
- 修改：apps/web/src/engine/capture/captureNormal.ts
- 修改：apps/web/src/engine/capture/captureTypes.ts
- 修改：apps/web/src/engine/capture/gpuReadbackPngWorker.ts
- 修改：apps/web/src/engine/capture/isolatedNormalCapture.ts
- 修改：apps/web/src/engine/capture/renderTargetUtils.ts
- 修改：apps/web/src/engine/generation/contentFramingRestore.ts
- 修改：apps/web/src/engine/generation/singleViewAutoProjection.ts
- 修改：apps/web/src/engine/loaders/loadFbxModel.ts
- 修改：apps/web/src/engine/loaders/loadGltfModel.ts
- 修改：apps/web/src/engine/loaders/loadModelFromFile.ts
- 修改：apps/web/src/engine/loaders/loadObjModel.ts
- 修改：apps/web/src/engine/loaders/modelImportTypes.ts
- 修改：apps/web/src/engine/loaders/modelLoadUtils.ts
- 修改：apps/web/src/engine/loaders/processModelImport.ts
- 修改：apps/web/src/engine/performance/gpuComputeBackend.ts
- 修改：apps/web/src/engine/performance/performanceTimeline.ts
- 新增：apps/web/src/engine/performance/tracing/browserRecording.ts
- 新增：apps/web/src/engine/performance/tracing/cacheTrace.ts
- 新增：apps/web/src/engine/performance/tracing/detailSampling.ts
- 新增：apps/web/src/engine/performance/tracing/generationEntry.ts
- 新增：apps/web/src/engine/performance/tracing/generationTrace.ts
- 新增：apps/web/src/engine/performance/tracing/gpuTrace.ts
- 新增：apps/web/src/engine/performance/tracing/imageTrace.ts
- 新增：apps/web/src/engine/performance/tracing/modelTrace.ts
- 新增：apps/web/src/engine/performance/tracing/pipelineTrace.ts
- 新增：apps/web/src/engine/performance/tracing/rendererTrace.ts
- 新增：apps/web/src/engine/performance/tracing/resourceLedger.ts
- 新增：apps/web/src/engine/performance/tracing/selfProfiling.ts
- 新增：apps/web/src/engine/performance/tracing/traceAnalysis.ts
- 新增：apps/web/src/engine/performance/tracing/traceCapturePass.ts
- 新增：apps/web/src/engine/performance/tracing/traceExport.ts
- 新增：apps/web/src/engine/performance/tracing/traceLifecycle.ts
- 新增：apps/web/src/engine/performance/tracing/traceRecorder.ts
- 新增：apps/web/src/engine/performance/tracing/traceRequest.ts
- 新增：apps/web/src/engine/performance/tracing/uiTrace.ts
- 新增：apps/web/src/engine/performance/tracing/webGpuTrace.ts
- 新增：apps/web/src/engine/performance/tracing/workerTrace.ts
- 新增：apps/web/src/engine/performance/tracing/workerTraceControl.ts
- 新增：apps/web/src/engine/performance/tracing/workerTraceTransport.ts
- 修改：apps/web/src/engine/performance/webGpuRgbaComposite.ts
- 修改：apps/web/src/engine/projection/ProjectedLayerPreviewCompositor.ts
- 修改：apps/web/src/engine/projection/compileForRenderTarget.ts
- 修改：apps/web/src/engine/projection/residentUvPresentation.ts
- 修改：apps/web/src/engine/session/engineSession.ts
- 修改：apps/web/src/engine/viewport/ViewportCanvas.tsx
- 修改：apps/web/src/engine/viewport/input.ts
- 新增：apps/web/src/features/performanceLab/PipelineTracePanel.tsx
- 新增：apps/web/src/features/performanceLab/PipelineTraceView.tsx
- 修改：apps/web/src/features/performanceLab/performanceLabUpload.worker.ts
- 修改：apps/web/src/routes/EditorPage.tsx
- 修改：apps/web/src/services/liclickApiClient.ts
- 修改：apps/web/src/services/modelviewApiClient.ts
- 修改：apps/web/src/services/projectSaveCoordinator.ts
- 修改：apps/web/src/services/workspaceApiClient.ts
- 修改：apps/web/src/workers/encodeGpuReadbackPng.worker.ts
- 修改：apps/web/src/workers/payload.worker.ts
- 修改：apps/web/src/workers/qualityBlend.worker.ts
- 修改：apps/web/src/workers/webGpuRgbaComposite.worker.ts
- 修改：apps/web/src/workers/webGpuUvTopologyRaster.worker.ts
- 修改：apps/web/vite.config.ts
- 修改：packages/contracts/src/index.ts
- 新增：packages/contracts/src/tracing/cpuProfile.ts
- 新增：packages/contracts/src/tracing/pipelineTrace.ts
- 新增：packages/contracts/src/tracing/traceClock.ts
- 新增：packages/contracts/src/tracing/workerTrace.ts

## 真实流程自动化（4 个）

- 修改：package.json
- 新增：scripts/li3d-workflow-iab.mjs
- 新增：scripts/li3d-workflow.mjs
- 新增：scripts/test-li3d-workflow.mjs

## Bicycle 测试输入（4 个）

- 新增：Li3dTests/Bicycle/Bicycle.glb
- 新增：Li3dTests/Bicycle/Bicycle.png
- 新增：temp/li3dTests/Bicycle/Bicycle.glb
- 新增：temp/li3dTests/Bicycle/Bicycle.png

## 其他本地报告与材料（38 个）

- 新增：.trae-html-share-packages/li3d-texture-painting-implementation/li3d-texture-painting-implementation.html.zip
- 新增：li3d-texture-painting-implementation/_shared/fonts/InstrumentSans-Bold.ttf
- 新增：li3d-texture-painting-implementation/_shared/fonts/InstrumentSans-OFL.txt
- 新增：li3d-texture-painting-implementation/_shared/fonts/InstrumentSans-Regular.ttf
- 新增：li3d-texture-painting-implementation/_shared/fonts/JetBrainsMono-Bold.ttf
- 新增：li3d-texture-painting-implementation/_shared/fonts/JetBrainsMono-OFL.txt
- 新增：li3d-texture-painting-implementation/_shared/fonts/JetBrainsMono-Regular.ttf
- 新增：li3d-texture-painting-implementation/li3d-texture-painting-implementation.html
- 新增：output/capture-pipeline-ab-20260922/A-composite.png
- 新增：output/capture-pipeline-ab-20260922/A-effect.png
- 新增：output/capture-pipeline-ab-20260922/A-mask.png
- 新增：output/capture-pipeline-ab-20260922/A-normal.png
- 新增：output/capture-pipeline-ab-20260922/A-submittedMask.png
- 新增：output/capture-pipeline-ab-20260922/B-composite.png
- 新增：output/capture-pipeline-ab-20260922/B-effect.png
- 新增：output/capture-pipeline-ab-20260922/B-mask.png
- 新增：output/capture-pipeline-ab-20260922/B-normal.png
- 新增：output/capture-pipeline-ab-20260922/B-submittedMask.png
- 新增：output/capture-pipeline-ab-20260922/experiment-source.json
- 新增：output/capture-pipeline-ab-20260922/filmstrip-A.png
- 新增：output/capture-pipeline-ab-20260922/filmstrip-B.png
- 新增：output/capture-pipeline-ab-20260922/final-instrumentation.json
- 新增：output/capture-pipeline-ab-20260922/index.html
- 新增：output/capture-pipeline-ab-20260922/recordings.json
- 新增：output/capture-pipeline-ab-20260922/results.json
- 新增：output/capture-pipeline-ab-20260922/summary.json
- 新增：output/capture-pipeline-ab-20260922/video-analysis.json
- 新增：output/capture-pipeline-ab-20260922/viewport-A.webm
- 新增：output/capture-pipeline-ab-20260922/viewport-B.webm
- 新增：output/mask-capture-ab-20260922.json
- 新增：output/mask-capture-ab-20260922.md
- 新增：output/texture-paint-module-overview.html
- 新增：output/贴图绘制模块说明.html
- 新增：temp/analyze_capture_ab_video.py
- 新增：temp/build_capture_ab_report.py
- 新增：temp/capture-validation-loader.mjs
- 新增：temp/capture-validation/package.json
- 新增：temp/capture_ab_artifacts.py
