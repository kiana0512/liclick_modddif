# Li3D 2026-08-13 修改总结

更新时间：2026-08-13

整理范围：相对基准提交 `ddbed3b` 的本次改动

状态：本文档随源码和配置一并提交；共涉及 15 个源码/配置文件

## 1. 一句话总结

今天主要完成了三项产品改动：明确拓扑历史中的低模/高模标识、调整单图生成六视图的默认布局、将局部重绘替换为 Flux2 Klein TrueV3 双图材质迁移工作流；同时修复了局部重绘结果的跨工作区保存、服务连接提示、刷新后复用及白模视图 GPU 准备误判。工作区还包含一组独立的 GLB/GLTF 与 FBX 烘焙单位对齐修复。

## 2. 用户可见改动

### 2.1 拓扑结果改为“低模 / 高模”

- 拓扑任务恰好返回两个模型时：
  - 第一个输出显示为“低模”；
  - 第二个输出显示为“高模”。
- 不再使用容易误点的“模型 1 / 模型 2”。
- 多于两个输出时仍显示“模型 N”，单个输出仍显示“拓扑结果”。

涉及文件：`apps/web/src/components/history/HistorySidePanel.tsx`

### 2.2 单视图生成多视图模板增加底视图

六视图默认布局由：

```text
第一排：正面、左前45°、右前45°；
第二排：左侧、右侧、顶部。
```

调整为：

```text
第一排：正面、左前45°、顶部；
第二排：左侧、右侧、底部。
```

即删除“右前 45°”，新增“底部”，并把“顶部”移动到第一排第三格。

涉及文件：`apps/web/src/components/panels/GeneratePanel.tsx`

### 2.3 局部重绘暂时取消用户提示词输入

- 局部重绘面板不再显示提示词输入框。
- 界面改为说明：当前使用固定材质迁移提示词，无需填写。
- 固定提示词由服务端维护，重点约束如下：
  - 图 1 绝对锁定模型结构、部件数量、相机、构图、透视和可见关系；
  - 图 2 只提供对应部位的材质、颜色分区、裸露金属、锈蚀、划痕和磨损等信息；
  - 禁止增加、删除、移动、缩放、重构零件或复制六视图排版。

涉及文件：

- `apps/web/src/components/panels/GeneratePanel.tsx`
- `apps/server/src/services/comfyuiGenerationService.ts`

## 3. 局部重绘工作流替换

### 3.1 输入、输出和蒙版逻辑

旧流程使用 ModelView/SeedVR2 的“当前视图 + 蒙版合图”输入；新流程改为 ComfyUI 的“Flux2 Klein TrueV3-双图材质编辑-精简测试”。

ComfyUI 只接收两张图：

1. 图 1：当前视角白模图，用于锁定模型结构和构图；
2. 图 2：纹理贴图阶段所使用的多视图材质参考图。

输出仍为一张生成图片。蒙版继续由用户绘制，但不再传入 ComfyUI，仅用于结果返回后限制回贴区域。

### 3.2 多视图参考图选择

- 优先自动查找当前模型最近一次纹理贴图记录对应的多视图材质参考图。
- 找不到时回退到当前选中的多视图参考图。
- 仍没有有效多视图时，阻止提交并提示“缺少多视图材质参考”。

### 3.3 白模捕获

- 局部重绘捕获模式由 `flat-target` 改为 `clay-target`，与纹理贴图白模输入保持一致。
- 保留当前相机视角和画面比例，保证返回图与本地蒙版能够对齐。
- 生成记录会保存项目、对象、捕获、材质参考、蒙版版本和对象矩阵等关联信息。

### 3.4 ComfyUI 服务端工作流

新增一套独立的材质重绘链路：

1. 检查 ComfyUI 服务状态；
2. 并行上传白模图和多视图材质参考图；
3. 构造 Flux2 Klein TrueV3 API Prompt；
4. 提交队列并轮询结果；
5. 下载结果图；
6. 保存到项目，无法直接写入本地组件项目时保存到用户 recovery 目录作为中转和容灾。

主要工作流参数：

- 主模型：`Flux2-Klein-9B-True-V3-int8mixedrow.safetensors`；
- 文本编码器：`qwen_3_8b_fp8mixed.safetensors`；
- VAE：`flux2-vae.safetensors`；
- LoRA：`baimo_shangcaizhi_klein_v1_000005500.safetensors`，强度 `0.8`；
- 双 `ReferenceLatent`；
- 12 步、Simple 调度、Euler 采样；
- 输出画布跟随图 1，并恢复图 1 原始尺寸。

### 3.5 新增接口和配置

- 新增 `GET /api/comfyui/material-repaint-status`：检查材质重绘服务状态。
- 新增 `POST /api/comfyui/generate-material-repaint`：提交双图材质重绘任务。
- 新增 `COMFYUI_MATERIAL_REPAINT_BASE_URL`，示例默认地址为 `http://10.3.2.59:49230`。
- 前端新增 `generateMaterialRepaint()` 客户端方法，超时为 30 分钟并支持中止信号。

涉及文件：

- `apps/server/.env.example`
- `apps/server/src/config.ts`
- `apps/server/src/routes/comfyui.ts`
- `apps/server/src/services/comfyuiGenerationService.ts`
- `apps/web/src/services/comfyuiApiClient.ts`
- `apps/web/src/components/panels/GeneratePanel.tsx`

## 4. 局部重绘问题修复

### 4.1 “无法连接生成服务”

- 定位结果：ComfyUI 工作流本身可用，失败原因是旧的本地后端进程无法访问局域网 ComfyUI 地址。
- 处理：重启本地后端，使其恢复正常网络访问。
- 代码侧补充独立健康检查、结构化错误码和更明确的错误文案。
- 新增错误码：
  - `MATERIAL_REPAINT_COMFY_UNREACHABLE`；
  - `MATERIAL_REPAINT_COMFY_FAILED`。
- 前端失败记录额外保留 `rawError`，方便后续排查。

### 4.2 跨工作区结果保存

- 当前页面项目由本地组件管理，而 ComfyUI 请求由主后端执行，两者工作区不同。
- 主后端无法直接写入本地组件项目时，结果会自动保存到用户 recovery 目录，避免“生图成功但结果丢失”。
- 前端随后将结果持久化到当前本地项目的 `assets/generations`。
- 输出元数据会标记保存来源为 `project` 或 `user-recovery`。

### 4.3 “局部重绘 GPU 准备失败”误报

- 生成图、蒙版、运行时深度和 GPU 覆盖层实际都已准备成功。
- 原因是白模/平面视图使用普通显示材质，不会产生“最终投影材质已就绪”的标记；旧逻辑却强制要求该标记，因此把正常白模误判为 GPU 失败。
- 修复后只校验真实的背景材质修订状态，普通白模材质和投影材质都可进入应用阶段。

### 4.4 GPU 失败后无法真正重试

- 旧逻辑会复用已经失败的准备状态，再次点击仍直接报错。
- 现在检测到同一生成结果的 GPU 错误时，会绕过失败缓存并重新准备源图、蒙版和覆盖层。

### 4.5 刷新后“应用局部重绘”不可用

- 刷新后临时的蒙版 revision 会回到 `0`，但生成记录中已有持久化 `maskUrl`。
- 现在允许在 revision 重置时使用生成记录内归档的蒙版，避免结果已经保存但应用按钮被错误禁用。

涉及文件：

- `apps/web/src/routes/EditorPage.tsx`
- `apps/web/src/engine/viewport/ViewportCanvas.tsx`
- `apps/web/src/components/panels/GeneratePanel.tsx`
- `apps/server/src/routes/comfyui.ts`
- `apps/server/src/services/comfyuiGenerationService.ts`

## 5. 烘焙模型单位与叠合对齐（独立并行改动）

这组改动与局部重绘链路相互独立，用于修复 GLB/GLTF 与 FBX 混用时因“米/厘米”单位不同造成的 100 倍尺寸偏差。

### 5.1 单位统一

- GLB/GLTF 按 glTF 2.0 的米制约定记录 `sourceUnitScaleFactor = 100`，即一个源单位对应 100 厘米。
- 烘焙内部使用厘米作为统一比较空间。
- 旧项目若 GLB/GLTF 缺失单位字段，会根据格式自动回退为 100；FBX/OBJ 默认回退为 1。

### 5.2 高低模与 Cage 对齐

- 包围盒统一转换到厘米空间后再进行尺寸预检。
- 未经过导入归一化的 GLB 高模会按物理单位显示；已归一化模型不会被二次缩放。
- 低模和 Cage 的叠合缩放同时考虑高模格式、低模格式和各自单位。
- 自动 Cage 膨胀距离改为基于低模自身源坐标包围盒，避免跨格式时放大或缩小 100 倍。
- 烘焙视口使用换算后的高模对象副本，不修改项目中持久化的原始 Transform。

涉及文件：

- `apps/web/src/engine/loaders/loadGltfModel.ts`
- `apps/web/src/features/bake/bakeModelAlignment.ts`
- `apps/web/src/features/bake/useBakeModelAnalysis.ts`
- `apps/web/src/features/bake/BakeSceneOverlay.tsx`
- `apps/web/src/routes/BakeWorkspacePage.tsx`
- `apps/web/src/features/bake/__tests__/bakeModelAlignment.test.mjs`

## 6. 删除和替换的旧逻辑

- 删除局部重绘的蒙版合图、RGBA/Alpha 重编码和输入 Worker 预热逻辑。
- 删除局部重绘对 ModelView API 的调用。
- 不再在浏览器中生成“带透明蒙版的 2K 输入图”。
- 局部重绘改为直接读取白模和多视图参考图并提交 ComfyUI，缩短按钮点击后的前置处理链路。

## 7. 今日验证记录

- Server TypeScript typecheck：通过。
- Web TypeScript typecheck：通过。
- Server production build：通过。
- Web production build：通过；只有既有 chunk-size 提示。
- 定向 ESLint：0 error；仍有既有 React Hook/未使用变量 warning。
- `git diff --check`：通过；只有 Windows 行尾转换提示。
- 烘焙单位测试：5 passed，0 failed。
- ComfyUI 真实端到端联调：双图输入正确入队，任务成功完成，结果图返回并持久化。
- 局部重绘 GPU 准备：已确认由 error 状态恢复为 ready 状态。
- 最终交互效果和实际涂抹结果由用户继续验收。

## 8. 当前改动文件清单

| 模块 | 文件 | 主要内容 |
| --- | --- | --- |
| 服务配置 | `apps/server/.env.example` | 新增材质重绘 ComfyUI 地址示例 |
| 服务配置 | `apps/server/src/config.ts` | 新增独立材质重绘 Base URL |
| 服务路由 | `apps/server/src/routes/comfyui.ts` | 新增状态检查、生成接口及结构化错误 |
| 服务实现 | `apps/server/src/services/comfyuiGenerationService.ts` | 双图工作流、固定提示词、结果保存与 recovery 容灾 |
| 拓扑 UI | `apps/web/src/components/history/HistorySidePanel.tsx` | 模型 1/2 改为低模/高模 |
| 生成面板 | `apps/web/src/components/panels/GeneratePanel.tsx` | 六视图模板调整、局部重绘双图输入、隐藏提示词 |
| 前端 API | `apps/web/src/services/comfyuiApiClient.ts` | 新增材质重绘客户端 |
| 编辑器 | `apps/web/src/routes/EditorPage.tsx` | GPU 重试、刷新后复用已保存蒙版 |
| 视口 | `apps/web/src/engine/viewport/ViewportCanvas.tsx` | 修复白模材质 GPU 就绪误判 |
| 模型加载 | `apps/web/src/engine/loaders/loadGltfModel.ts` | 记录 glTF 米制单位 |
| 烘焙算法 | `apps/web/src/features/bake/bakeModelAlignment.ts` | 跨格式单位换算和叠合缩放 |
| 烘焙分析 | `apps/web/src/features/bake/useBakeModelAnalysis.ts` | 统一厘米包围盒预检 |
| 烘焙视口 | `apps/web/src/features/bake/BakeSceneOverlay.tsx` | 低模/Cage 格式感知叠合和 Cage 膨胀修复 |
| 烘焙页面 | `apps/web/src/routes/BakeWorkspacePage.tsx` | 高模显示单位换算和统一尺寸预检 |
| 烘焙测试 | `apps/web/src/features/bake/__tests__/bakeModelAlignment.test.mjs` | 新增 5 项跨单位测试 |

## 9. 后续建议

- 由用户重点验证：蒙版边缘、回贴位置、不同相机角度、刷新后继续应用，以及连续多次局部重绘。
- 建议补充局部重绘接口的自动化测试，以及“普通白模材质可进入 GPU ready”的浏览器回归测试。
- 建议补充 GLB/GLTF 加载器单位字段、BakeWorkspace 视口叠合和自动 Cage 膨胀的集成测试。
- 本次提交已统一包含局部重绘改造和并行的烘焙单位修复，后续迭代需同时关注两条链路的回归结果。
