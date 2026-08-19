# Li3D 后续优化总结（2026-08-18）

## 1. 总览

本文以今天上一份优化总结为分界，仅记录之后新增、合并并保留的优化内容。

本阶段主要围绕后台纹理任务稳定性、GPT2 固定材质迁移提示词、白模显示统一、默认视口、模型加载反馈和项目创建体验展开。

## 2. 后台纹理任务稳定性

### 2.1 页面切到后台后继续执行

- 增加统一的浏览器调度工具，在前台优先等待真实绘制帧，在后台自动切换到定时器兜底。
- 不再让纹理任务直接依赖 `requestAnimationFrame` 或 `requestIdleCallback`，避免浏览器标签页进入后台后任务被暂停。
- 多视图快照、纹理上传、UV 合成、内容识别填补及表面拓扑分析共用同一套可继续推进的调度逻辑。
- 页面在后台时会跳过没有意义的视口交互等待，避免残留的交互状态长期阻塞生成链路。
- 页面重新回到前台后仍保持原有的分帧让步策略，兼顾生成连续性与视口操作流畅度。

### 2.2 后台任务回归覆盖

- 扩展重任务调度测试，覆盖隐藏标签页不触发 `requestAnimationFrame` 时仍可启动纹理任务。
- 统一 GPU 纹理分片上传、离屏捕获和 UV 烘焙中的帧等待入口，减少不同模块各自调度造成的不一致。

## 3. GPT2 固定材质迁移提示词优化

### 3.1 区分视图说明与物体表面内容

- 明确忽略多视图排版中的“正面、左侧、45 度”等视图名称和说明文字。
- 明确保留印刷在物体表面的文字、数字、Logo、邮票、标签、贴纸、警示符号和装饰图案。
- 防止模型表面的有效标识被误判为多视图说明文字而被删除。

### 3.2 增加物理表面归属与位置锁定

- 生成前先建立“参考视图 → 物理表面 → 图案”的对应关系。
- 正面、背面、左右侧、顶部、底部和可动部件上的内容只能迁移到对应表面，禁止跨面移动、交换或复制。
- 以具体物理表面的边界为坐标系，保持图案中心点、边距、面积比例、长宽比、旋转方向及与相邻图案的间距。
- 多个视角中重复出现的同一标识只迁移一次，斜视图仅用于确认身份和透视关系。
- 图案位于箱盖、折板、门板或面板时跟随具体部件，不转移到相邻外壳。
- 无法可靠确认归属或当前视角不可见时不猜测位置，优先保证位置正确。

### 3.3 提升文字与图案保真

- 对清晰内容要求保留原始拼写、大小写、数字、标点、颜色、轮廓和 Logo 形状。
- 禁止乱码、镜像、倒置、重复平铺、跨部件串贴及为了构图美观而重新居中或排版。
- Base Color 输出要求中补充物体表面的印刷信息，确保材质和图案作为同一套表面信息共同迁移。

## 4. 白模显示统一

### 4.1 建立统一白模材质

- 新增统一的白模材质定义，集中管理颜色、粗糙度、金属度和自发光参数。
- 纹理为空时的主视口白模、生成控制图白模、模型预览窗口、历史模型缩略图和离屏捕获统一使用同一材质。
- 消除不同流程之间偏蓝、偏灰、偏米色或明暗反差不一致的问题。

### 4.2 统一预览灯光

- 模型预览和历史缩略图采用一致的环境光、半球光、主光与补光组合。
- 保持轮廓、凹凸和细节可读性，同时对齐主编辑器中的中性白模效果。

## 5. 默认视口与显示模式

- 贴图工作区默认进入“平面”视口，避免首次打开时受到 PBR 光照影响。
- 调整视口按钮顺序，将“平面”放在“PBR”之前，使默认模式和界面顺序一致。
- 新建项目默认保存为平面显示模式。
- 增加偏好数据迁移，已有用户升级后也会使用新的平面默认值。

## 6. 模型加载反馈

### 6.1 加载过程可视化

- 模型加载显示分阶段进度，包括文件准备、读取、几何解析、材质处理、项目保存和加入场景。
- 多模型批量加载按文件数量合并计算总进度，进度保持单调递增。
- 无法确定字节总量时使用不定进度状态，避免显示错误百分比。

### 6.2 加载完成反馈

- 模型真正加入场景后，进度标题切换为“模型加载完毕”。
- 单文件和批量文件分别显示明确的完成提示及实际成功数量。
- 加载失败的文件不计入成功数量，原始解析警告仍以警告形式保留。
- 完成状态延长短暂展示时间，方便用户确认模型已经可用。

## 7. 新建项目体验

- 新建项目窗口自动填入“新项目1”，用户可以直接点击创建。
- 已存在同名项目时自动查找下一个可用编号，例如“新项目2”。
- 输入框获得焦点时自动全选默认名称，仍可快速替换为自定义名称。
- 增加中英文默认项目名前缀及编号规则测试。

## 8. 视口灰色平面进一步修正

- 绘制类工具启用时暂时隐藏接触阴影接收平面的输出，避免离屏捕获或辅助对象污染阴影纹理后出现大面积灰色矩形。
- 工具退出后在空闲帧恢复正常接触阴影，不改变普通浏览状态下的阴影效果。
- 加强辅助遮罩预热过程的中止和清理：工具状态变化后立即停止预热，并隐藏不应继续显示的辅助覆盖层。
- 降低选中遮罩、切换工具或预热着色器时偶发显示灰色地面格子的概率。

## 9. 远端最新修改整合

- 已同步并合并远端 `master` 的最新基础改动。
- 对捕获、投影材质、图层显示和视口场景相关变更进行了本地兼容整理。
- 后续新增的后台调度、统一白模和默认平面视口均建立在合并后的代码基线上，避免远端更新覆盖本地流程。

## 10. 主要涉及文件

- `apps/web/src/utils/browserScheduling.ts`
- `apps/web/src/engine/performance/heavyTaskScheduler.ts`
- `apps/web/src/engine/contentAware/buildSurfaceTopology.ts`
- `apps/web/src/engine/capture/captureCurrentView.ts`
- `apps/web/src/engine/capture/renderTargetUtils.ts`
- `apps/web/src/engine/bake/bakeProjectedLayerToTexture.ts`
- `apps/web/src/engine/bake/gpuUvBakeRenderer.ts`
- `apps/web/src/engine/materials/clayModelMaterial.ts`
- `apps/web/src/engine/projection/ProjectedLayerMaterial.ts`
- `apps/web/src/engine/viewport/SceneRoot.tsx`
- `apps/web/src/engine/viewport/ViewportCanvas.tsx`
- `apps/web/src/engine/viewport/previewTextureCache.ts`
- `apps/web/src/engine/viewport/viewportInteractionState.ts`
- `apps/web/src/features/workflow/AssetModelViewport.tsx`
- `apps/web/src/features/workflow/modelPreviewAssets.ts`
- `apps/web/src/features/projects/projectDefaultName.ts`
- `apps/web/src/components/panels/GeneratePanel.tsx`
- `apps/web/src/components/panels/ViewportPanel.tsx`
- `apps/web/src/layouts/EditorShell.tsx`
- `apps/web/src/routes/EditorPage.tsx`
- `apps/web/src/routes/ProjectsPage.tsx`
- `apps/web/src/stores/i18nStore.ts`
- `apps/web/src/stores/sceneStore.ts`
- `apps/web/scripts/test-heavy-task-scheduler.mjs`
- `apps/web/scripts/test-model-import-progress.mjs`
- `apps/web/scripts/test-project-default-name.mjs`
