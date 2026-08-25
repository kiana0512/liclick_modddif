# Li3D 2026-08-10 修改、优化与合并说明

更新时间：2026-08-11（性能优化阶段 7 收口）
目标读者：负责代码审查、合并、回归验证的同事
当前分支：`master`
阶段 7 前一提交：`3fd90263eee266cd29603c46389c6c7558cf1178`
阶段 7 收口提交：本文档所在提交（以合并分支最新 SHA 为准）
合并前主线基准：`ef1bcdfbc6d8d2697742bf53482ccdbfbc733772`
建议审查范围：`ef1bcdf..3fd9026`

## 1. 一句话结论

今天完成了贴图工作区 UI 合并、局部重绘穿透/死区/实时反馈修复、刷新与白膜加载优化、性能实验室阶段 7、一次性本地身份证明重试，以及 4K/UV 合成稳定性调度；所有优化都保留原始纹理和 4K 输出质量，没有通过降低分辨率、减少图层、降低模型复杂度或放宽最终质量校验来换速度。

最终树相对 `ef1bcdf` 的净变化为：

- 45 个文件；
- 新增约 6534 行；
- 删除约 1611 行；
- `3fd9026` 之后继续完成了刷新恢复、内容识别原子发布、局部重绘实时链路、4K 合成 Worker 和性能实验室量化收口；
- 本文档随阶段 7 收口代码一并提交。

## 2. 本次解决的主要问题

### 2.1 局部重绘

- 修复投影射线穿透：在投影相机空间捕获前表面深度，蒙版和捕获 pass 都只接受最前方可见表面。
- 修复重复任务第一次正常、第二次绘制慢半拍：蒙版纹理在绘制调用内立即上传并请求视口重绘，不再等下一轮节流回调。
- 修复局部重绘死区：有捕获深度时以深度为可见性权威，避免扫描模型局部翻转法线造成永久拒绝。
- 修复图层眼睛状态与 GPU 覆盖层不同步：局部重绘覆盖层的可见性统一跟随对应图层和视图模式。
- 修复按钮 2 偶发冻结 5–10 秒：多投影蒙版改为一次累计渲染、一次异步读回；2K/4K 像素模糊、Alpha 处理和 PNG 编码转移到 Worker。
- 修复按钮 3 首笔不显示或 GPU Ready 与实际覆盖层失联：发布 ready 前重新校验覆盖层仍挂在当前模型、材质未释放、源图和蒙版绑定有效。

### 2.2 刷新、白膜与 0→14 上图

- 新增原分辨率预览纹理共享缓存；失败 promise 会被淘汰，允许自动重试。
- 页面进入贴图工作区时提前解码并分条上传可见预览纹理。
- 冷恢复先发布可见局部重绘或最相关的可见投影，再让隐藏驻留层加入最终完整数组。
- 投影数组仍保持 1536 预览边长和原算法，但上传预算调整为每帧一张完整 1536² 颜色切片，避免约 140 次强制等待。
- 顶部增加真实进度：准备、GPU 上传、按眼睛状态发布、完成/失败都有明确状态。
- 最终完成统计只计算当前眼睛为可见、且确实已经加载的图层；全部关闭时显示“已按图层眼睛状态隐藏投影结果”。
- UV/投影眼睛切换使用驻留资源和 uniform 更新，不把冷预加载耗时伪装成眼睛开关耗时。

### 2.3 4K/UV 合成

- 保留 4K、完整 RGBA、Alpha、覆盖率和逐字节 A/B 校验。
- WebGPU RGBA 合成在交互保护期间使用 1 MiB 提交块，降低单次 GPU 队列占用。
- 最终透明像素清理保持原字节算法并在主线程分块让出事件循环；撤回了会产生约 84 MiB 往返和更大消息交付长帧的实验性 Worker 收尾方案。
- S4 目前质量已经通过，但 GPU 光栅/读回仍有长帧，详见“未完成项”。

### 2.4 UI、工作流与首次引导

- 合入新的贴图工作区布局，同时保留本地性能和局部重绘算法。
- 生成模式整理为“多视图 / 单视图 / 重绘效果图”。
- 多视图提供 10 视角、14 视角和自定义 6 视角预设。
- 参考图改为独立卡片，支持上传、拖拽、预览、复制、删除及从单视图补全多视图。
- 增加单视图与多视图示例素材。
- 底部局部重绘整理为“蒙版 → 局部生图 → 局部重绘画笔”的三步流程。
- 新增 `TextureOnboardingTour`，引导首次创建项目的用户完成导入模型、添加参考图、生成纹理和局部修改。
- 调整对象、生成、视口、图层、Workspace Dock 和全局样式，减少面板滚动、尺寸跳动和操作入口分散。

### 2.5 本地授权与版本

- 根版本和本地组件运行时版本从 `0.1.10` 更新为 `0.1.11`。
- 本地组件开发校验只接受 loopback + 固定 Vite 端口，不再错误复用工作区服务的 CORS allowlist。
- 本地身份证明是一次性的；组件返回 `INVALID_LOCAL_IDENTITY_PROOF` 时，前端获取新 proof 并且只重放原请求一次。
- 图片编辑、生成 API、个人账号 API 统一使用同一个 proof 重试封装。
- 补充一次性 proof 被消费后的回归测试，避免仍有效的飞书登录被错误要求重新登录。

## 3. 今日提交时间线

> 注意：今天 Git 历史里有 11 笔提交，但不是 11 笔都应该单独 cherry-pick。两个 merge commit 记录了有意的冲突取舍。

| 时间 | 提交 | 类型 | 说明 | 合并注意 |
| --- | --- | --- | --- | --- |
| 11:46 | `e8b6845` | 侧分支 | 4K 修补稳定、内容识别拓扑和重绘蒙版实验 | 后续 `6c5d9f5` 选择保留本地算法；不要单独 cherry-pick |
| 12:26 | `f8e9e52` | 主线 | 修复局部重绘开关，增加 GPU 覆盖层同步和可见性测试 | 是今日主线有效改动 |
| 12:33 | `b8b28d6` | merge | 合入 `3bfc38e` 的 UI、参考图、引导和授权流程，同时保留性能算法 | 必须保留其冲突解决结果 |
| 12:33 | `6c5d9f5` | merge | 将 `e8b6845` 记录进历史，但明确保留本地局部重绘算法 | first-parent 树无净变化，不能替换成 `e8b6845` 文件整包 |
| 13:47 | `09a76a9` | 主线 | 启动性能阶段 7：HUD 自扰动统计、深度/法线预编译、S6 分阶段指标 | 新增性能指标自动测试 |
| 13:53 | `4f5930f` | 文档 | 记录并否决“真实模型 shader 变体预编译”实验 | 实验代码已撤回，只保留结论 |
| 17:12 | `ff677f4` | 主线 | 性能阶段 7 主体：显示模式常驻、刷新渐进材质、局部重绘隔离、授权 proof 重试 | 大型核心提交，依赖前面 merge 结果 |
| 17:24 | `3a55d09` | 主线 | 使用投影相机深度阻止蒙版射线穿透 | 不要删除深度 target 生命周期和相机失效逻辑 |
| 17:35 | `7befcd7` | 主线 | 修复再次绘制蒙版慢半拍，保留同视图深度缓存 | 清空像素不应清空仍有效的深度缓存 |
| 17:55 | `8660e8b` | 主线 | 修复深度可见但因法线方向产生的局部重绘死区 | 有深度时使用 `abs(N·V)`，局部重绘禁用额外 normal reject |
| 19:05 | `3fd9026` | 主线 | 修复白膜/刷新加载速度、按钮 2 卡顿、预览缓存、顶部进度和性能量化 | 今日最终交付提交 |

## 4. 合并拓扑：必须理解的两个点

### 4.1 推荐按最终树合并，不要逐笔 cherry-pick

推荐直接合并包含 `3fd9026` 的完整分支或 Merge Request。审查范围使用：

```bash
git diff ef1bcdf..3fd9026
```

不推荐把 11 个 SHA 逐个 cherry-pick，因为：

1. `b8b28d6` 是 UI 与性能算法的语义合并，单独取父分支会重新制造 `GeneratePanel`、`EditorPage` 和 `ViewportCanvas` 冲突；
2. `6c5d9f5` 有意保留本地算法，不能用侧分支 `e8b6845` 覆盖最终文件；
3. `ff677f4` 以后多个修复建立在合并后的文件结构和状态机上。

### 4.2 `e8b6845` 不是最终产品树的完整来源

`e8b6845` 修改过内容识别拓扑、修补 Worker、参考图和局部重绘逻辑，但 `6c5d9f5` 的合并策略明确选择保留当时本地主线算法。因此：

- 可以保留它作为历史和对照；
- 不应在目标分支上再次 cherry-pick；
- 不应在冲突时直接选择该提交版本的 `ViewportCanvas.tsx`、`EditorPage.tsx` 或内容识别文件；
- 最终行为以 `3fd9026` 的文件树和本文档为准。

## 5. 关键文件地图

### 5.1 高冲突核心文件

| 文件 | 今日最终职责 |
| --- | --- |
| `apps/web/src/engine/viewport/ViewportCanvas.tsx` | 局部重绘 GPU 覆盖层、蒙版绘制、深度防穿透、实时纹理更新、按钮 2/S6/S4/S5 性能场景 |
| `apps/web/src/engine/viewport/SceneRoot.tsx` | 投影/UV 常驻材质、渐进恢复、原子发布、纹理缓存、眼睛状态同步和顶部加载进度 |
| `apps/web/src/engine/projection/ProjectedLayerMaterial.ts` | 投影 shader、深度/法线可见性、纹理数组准备、分帧上传、GPU fence、显示模式 uniform |
| `apps/web/src/routes/EditorPage.tsx` | 工作区 UI、局部重绘会话、预热入口、投影进度条和 4K 合成入口 |
| `apps/web/src/components/panels/GeneratePanel.tsx` | 多/单视图、重绘效果图、按钮 2 输入 Worker、任务结果选择和生成进度 |

这些文件禁止用“整文件接受 ours/theirs”的方式解决冲突，必须语义合并。

### 5.2 新增的关键实现文件

| 文件 | 用途 |
| --- | --- |
| `apps/web/src/components/editor/TextureOnboardingTour.tsx` | 首次创建项目引导 |
| `apps/web/src/engine/viewport/localRepaintGpuOverlaySync.ts` | 局部重绘 GPU 覆盖层显示状态同步 |
| `apps/web/src/engine/viewport/previewTextureCache.ts` | 原尺寸预览纹理缓存、预热和分条上传 |
| `apps/web/src/engine/localRepaint/comfyInpaintInputWorker.ts` | 按钮 2 输入 Worker 客户端和预热 |
| `apps/web/src/workers/comfyInpaintInput.worker.ts` | 源图/蒙版合成、模糊、Alpha 和 PNG 编码 |
| `apps/web/src/engine/projection/maskedProjectedImage.worker.ts` | 投影蒙版/局部重绘 Alpha 处理 Worker |
| `apps/web/src/engine/performance/performanceLabMetrics.ts` | 性能实验室低扰动统计函数 |
| `apps/web/scripts/test-performance-lab-metrics.mjs` | 性能统计精确一致性测试 |
| `apps/web/public/examples/reference-single.png` | 单视图示例素材 |
| `apps/web/public/examples/reference-multiview.jpg` | 多视图示例素材 |

### 5.3 其他重要修改文件

- `apps/web/src/engine/capture/renderTargetUtils.ts`：多 pass 累计后一次 GPU 读回/PNG 编码。
- `apps/web/src/engine/projection/createMaskedProjectedImage.ts`：投影遮罩处理转 Worker并支持预热。
- `apps/web/src/engine/projection/createRuntimeProjectionDepth.ts`：深度/法线 pass 复用、预编译和串行化。
- `apps/web/src/engine/projection/ProjectedLayerPreviewCompositor.ts`：深度权威下的投影候选一致性。
- `apps/web/src/engine/bake/bakeProjectedLayerToTexture.ts`：透明收尾分块和质量保持。
- `apps/web/src/engine/performance/webGpuRgbaComposite.ts`：交互期 1 MiB WebGPU 提交。
- `apps/web/scripts/test-projected-layer-visibility.mjs`：图层眼睛、显示模式和局部重绘覆盖层回归。
- `apps/web/src/services/localIdentityProofApiClient.ts`：一次性 proof 自动刷新并且只重试一次。
- `apps/server/src/services/localIdentityProofService.ts`：开发环境 loopback 校验地址修复。
- `apps/web/src/components/editor/BottomToolDock.tsx`、`LayersPanel.tsx`、`ObjectsPanel.tsx`、`ViewportPanel.tsx`、`ReferenceGroupPicker.tsx`：贴图工作区 UI 合并。
- `apps/web/src/styles/globals.css`：新工作区、引导和面板视觉样式。

## 6. 合并冲突时必须保留的不变量

### 6.1 质量不变量

- 不能降低 4K 输出分辨率。
- 不能缩减 14 个投影视角或跳过隐藏但需要驻留的最终图层。
- 不能移除深度/法线最终质量检查来提速。
- 不能降低原始局部重绘源图分辨率；实测源图为 `2048×1032`。
- WebGPU/CPU A/B 不一致时必须回退正确结果，不能为了速度强制发布 GPU 候选。

### 6.2 局部重绘不变量

- 图层眼睛关闭后，独立 GPU 覆盖层必须立即隐藏；重新开启后恢复，不得重建背景投影数组。
- PBR/平面显示局部重绘；法线/线框隐藏局部颜色覆盖层，但不得释放资源。
- 投影相机改变时深度缓存必须失效；只清空同视图蒙版像素时深度缓存应保留。
- 有深度快照时深度是前表面权威，不得重新用有符号法线阈值制造死区。
- 画笔调用内必须立即 `texture.needsUpdate` 并请求视口帧，不能恢复到下一帧节流发布。

### 6.3 刷新和眼睛状态不变量

- 新纹理未完成前保留最后一份有效材质，不能退回白膜。
- 可见图层优先恢复；隐藏图层可随后加入驻留材质，但不能阻塞唯一可见局部重绘层。
- 顶部进度必须来自真实纹理/数组管线，不能使用纯时间模拟。
- “已显示”的数量必须与当前眼睛可见集合相交，不能把已加载但隐藏的层计入。

### 6.4 授权不变量

- 一次性 proof 只允许在明确返回 `INVALID_LOCAL_IDENTITY_PROOF` 时重试一次。
- 不得对普通网络错误或其他 401 无限重试。
- 本地组件仍只绑定 loopback；开发验证仅允许固定 Vite 端口。

## 7. 最新量化结果

测试环境：工业切割机器人、4K、14 个投影图层、RTX 4070 Ti SUPER、60Hz、`?perfLab=1`。

| 场景 | 最新结果 | 结论 |
| --- | ---: | --- |
| 0→14 交互 P95 / 最大 | `16.8 / 16.8ms` | 通过 |
| 0→14 完整数组管线 | `1424.2ms` | 比原约 2.5–3.0s 明显缩短 |
| 0→14 GPU 上传总计 / 最大条带 | `62.4 / 3.6ms` | 通过；没有降低切片质量 |
| S5 UV/投影眼睛切换 P95 / 最大 | `16.8 / 33.4ms` | 基本通过 |
| S5 松手发布最大 | `83.4ms` | 略高于 80ms 目标，继续跟踪 |
| S6 连续实时反馈 P95 / 最大 | `16.0 / 16.1ms` | 通过 |
| S6 按钮 3 就绪 / 首笔可见 | `26.3 / 99.1ms` | 连续反馈通过，首笔仍可继续缩短 |
| S6 按钮 2 蒙版捕获 | `22.9ms` | 主线程不再冻结 5–10 秒 |
| S6 按钮 2 输入总计 / Worker | `238.8 / 215.1ms` | 重工作已离开主线程 |
| S6 冷态首笔最大 | `50.1ms` | 仍有一次冷峰值 |
| S6 停笔发布最大 | `66.7ms` | 与连续绘制隔离 |
| 刷新后投影恢复 | `14 层 / 2016ms / ready` | 顶部状态和眼睛集合一致 |
| S4 WebGPU/CPU A/B | `0 字节差异，最大差值 0` | 质量通过 |
| S4 已校准生产路径 | GPU 光栅/读回 `18.3s`，P95 `33.4ms`，最大 `283.6ms` | 稳定性未通过 |

## 8. 已执行验证

| 检查 | 结果 |
| --- | --- |
| Web TypeScript 类型检查 | 通过 |
| Web ESLint | 通过，0 error；仍有 14 条 Hook/Fast Refresh warning |
| Web production build | 通过；Vite 仍提示部分大 chunk |
| Server TypeScript 类型检查 | 通过 |
| Server build | 通过 |
| `test:projection-layers` | 通过 |
| `test:performance-lab-metrics` | 通过 |
| `test:uv-composite-backpressure` | 通过 |
| `test:liclick-auth-separation` | 通过 |
| `git diff --check` | 通过 |
| 浏览器刷新稳定窗口 | 4 秒内无新增 warning/error |

建议合并后至少执行：

```bash
corepack pnpm --filter @liclick/web typecheck
corepack pnpm --filter @liclick/web lint
corepack pnpm --filter @liclick/web build
corepack pnpm --filter @liclick/server typecheck
corepack pnpm --filter @liclick/server build
corepack pnpm --filter @liclick/web test:projection-layers
corepack pnpm --filter @liclick/web test:performance-lab-metrics
corepack pnpm --filter @liclick/web test:uv-composite-backpressure
corepack pnpm --filter @liclick/web test:liclick-auth-separation
git diff --check
```

## 9. 合并后的人工回归清单

### 9.1 刷新与图层

- [ ] 使用至少 14 个投影层和 1 个已持久化 UV 层的项目刷新。
- [ ] 顶部出现真实加载进度，完成后消失。
- [ ] 投影层、UV 层和局部重绘层都能恢复，不出现长时间白膜。
- [ ] 逐个点击眼睛，面板状态与模型显示严格一致。
- [ ] 切换 PBR、平面、法线、线框，不触发完整投影数组重建。

### 9.2 局部重绘

- [ ] 从后侧涂蒙版，再切左/前视图确认蒙版没有穿透到前表面。
- [ ] 完成一次生成后再次进入蒙版绘制，首笔和连续笔画都立即显示。
- [ ] 在曲面、硬边和可能翻转法线的位置反复涂抹，确认没有永久死区。
- [ ] 点击按钮 2 后浏览器持续响应，不出现 5–10 秒冻结。
- [ ] 按钮 3 未 ready 时有明确进度，ready 后首笔显示。
- [ ] 关闭局部重绘图层眼睛后 GPU 覆盖层立即消失，开启后恢复。

### 9.3 质量与性能

- [ ] S6 GPU 可见像素、场景变化像素、Alpha 和背景零重建全部通过。
- [ ] S4 输出尺寸、覆盖率、Alpha、RGB A/B 与合并前金标准一致。
- [ ] 运行 S1/S5/S6 时保持视口旋转，不能为了通过测试停止相机。
- [ ] 连续运行性能场景后，GPU 显存和 JS 堆不单调增长。

### 9.4 授权

- [ ] 个人飞书登录可以生成和编辑图片。
- [ ] 模拟首次 proof 被消费后，第二次 proof 只重试一次并成功。
- [ ] 普通 401/网络错误不会进入无限重试。

## 10. 未完成项和已知风险

### 10.1 S4 4K 合成仍有 GPU 读回长帧

质量已经达到逐字节一致，但已校准生产路径仍出现 `283.6ms` 最大帧；首次适配器质量校准曾达到 `617.1ms`。瓶颈已经定位到共享 WebGL 的逐层 `gpu-raster-readback`，不能靠降低分辨率或跳过图层规避。

后续正确路线是独立 Worker WebGPU/WebGL 离屏几何光栅、纹理数组常驻和仅最终结果一次读回，而不是继续在共享 R3F renderer 上做伪异步切片。

### 10.2 冷态和发布峰值尚未完全清零

- S6 冷态第一笔：`50.1ms`；
- S6 停笔发布：`66.7ms`；
- S5 松手发布：`83.4ms`。

连续绘制已经稳定，但不能把这些峰值写成“完全无掉帧”。

### 10.3 UV 刷新仍需带持久化 UV 的干净项目复测

最终浏览器刷新时服务器快照里有 14 个投影层，但没有持久化 UV 层，因此本轮浏览器只能证明投影恢复；UV 可见性自动测试已通过，但端到端刷新仍要使用明确保存过 UV 图层的基准工程复测。

### 10.4 性能压测不要覆盖用户工程

性能实验室会临时切换图层栈并恢复。今天压测期间曾触发“陈旧项目快照拒绝保存”保护；最终稳定窗口无新增错误，但正式测试仍应使用专用基准项目，避免和其他客户端同时保存同一工程。

## 11. 回退边界

- `3fd9026`：白膜、预览缓存、按钮 2 Worker 和顶部进度；可作为一个整体回退，但会重新暴露刷新慢和按钮 2 卡顿。
- `8660e8b`：死区修复；回退后深度可见但法线翻转区域可能再次无法涂抹。
- `7befcd7`：蒙版实时性与深度缓存；回退后第二次任务可能再次慢半拍。
- `3a55d09`：穿透修复；回退后同一投影射线可能重新落到后表面。
- `ff677f4`：阶段 7、显示模式常驻、刷新渐进和授权重试，范围较大，不建议脱离前置 merge 单独回退。
- `4f5930f` 只有实验文档，不包含需要回退的产品代码。
- 不要单独 revert `b8b28d6` 或 `6c5d9f5`；它们承载合并拓扑和冲突决策。

## 12. 推荐合并结论

1. 以最终提交 `3fd9026` 的完整树创建/合并 MR；
2. 使用 `ef1bcdf..3fd9026` 做整体审查；
3. 冲突时按本文“必须保留的不变量”逐段语义合并；
4. 禁止单独 cherry-pick `e8b6845`；
5. 完成自动测试和人工回归后再发布；
6. S4 长帧作为明确的后续阻断项继续优化，不能通过降低质量关闭。

## 13. 2026-08-11 阶段 7 最终收口补充

本轮停止继续尝试新的优化路线，只提交已经完成静态回归和性能实验室验证的实现。未采用降低分辨率、减少视角、跳过图层、弱化遮挡判断或放宽像素一致性校验的方式换取指标。

### 13.1 本轮新增修正

- 刷新恢复改为轮廓先行、可见纹理优先，完整材质在精确纹理预热后原子切换；Contact Shadows 保持挂载并在恢复期设为零透明，避免最终交接帧临时编译。
- 投影材质按真实混合模式生成专用 shader，减少无用分支，同时把混合模式纳入结构签名，保证图层变化后安全重建。
- 隐藏投影层在浏览器空闲期继续完整驻留；可见首屏不再等待全部 14 层，最终眼睛状态与驻留状态分离。
- 内容识别修补结果只有在完整 PNG 解码和 GPU 分条上传成功后才发布可见图层，消除首次白膜、切眼睛后才正常和偶发完全不显示。
- 局部重绘覆盖层改为稳定订阅图层状态；画笔实时反馈、停笔发布和按钮 2 的源图/蒙版处理互相隔离。
- 修复延迟编码优化导致的按钮 2 自锁：实时 GPU 蒙版捕获是提交权威，按钮不再要求尚未生成的延迟 PNG URL；捕获不到实际蒙版时才拒绝提交。
- 局部重绘深度使用精确运行时前表面深度，既阻止投影穿透，也避免曲面/翻转法线区域形成不可绘制死区。
- 4K 合成把 WebGPU RGBA 合成、PNG 编码和 UV 图层源图解码移入 Worker；生产路径仍保持 4096 输出、完整 Alpha 和逐字节 A/B 校验。
- 性能实验室 S4 基准明确排除局部重绘投影层，并在基准失败时直接抛错，不再把失败误报为等待采样。

### 13.2 最终量化结果

| 场景 | 阶段 7 收口结果 | 结论 |
| --- | ---: | --- |
| 刷新 S8：完整可用 | `3287ms` | 可见纹理优先，随后后台驻留全部 15 层 |
| 刷新 S8：模型 / UV / 投影可见 | `3006 / 3035 / 3241ms` | 顶部真实进度与眼睛状态一致 |
| 刷新 S8：主线程最大纹理任务 | `72.3ms` | 较旧样本 `161.2ms` 明显下降 |
| 投影 shader 完整编译 | `165.9–175.8ms` | 较旧样本 `313ms` 下降，最终像素算法不变 |
| S7 图层/眼睛切换 P95 / 最大 | `18.1 / 18.2ms` | 0 重建、0 状态错误、0 覆盖层错误 |
| 局部重绘 S6 交互 P95 / 最大 | `18.1 / 35.5ms` | 实时绘制链路通过 |
| 局部重绘按钮 3 就绪 / 首笔可见 | `301.8 / 104.6ms` | 连续绘制无延迟；冷态首笔仍有优化空间 |
| 局部重绘按钮 2 总计 / Worker | `225.7 / 214.4ms` | 未复现 5–10 秒浏览器卡死 |
| 0→14 旋转 P95 / 最大 | `18.1 / 18.4ms` | 掉帧率 0%，图层栈正确恢复 |
| S4 输出 | `4096² / 20.90MB / 48.41% 覆盖率` | 质量保持 |
| S4 WebGPU/CPU RGBA A/B | `0 字节差异 / 最大差值 0 / 回退 0` | 正确性通过 |
| S4 生产路径 | 总耗时约 `35–38s`，最大帧约 `426–434ms` | 性能未通过，作为下一阶段明确遗留项 |

### 13.3 收口验证

- `pnpm --filter web typecheck`：通过；
- `pnpm --filter web test:projection-layers`：通过；
- `pnpm --filter web test:performance-lab-metrics`：通过；
- `pnpm --filter web test:uv-composite-backpressure`：通过；
- `git diff --check`：通过。

### 13.4 合并结论与边界

- 可以合并阶段 7 当前成果：局部重绘实时性、遮挡正确性、图层眼睛同步、刷新白膜/内容识别发布和状态提示均已进入最终实现。
- 不能把 S4 写成性能通过：它只完成了 4K 质量与正确性验收，主线程/GPU 交接长帧仍需下一阶段解决。
- 不要恢复本轮已撤回的 256 KiB PNG 分块或流式 Blob 实验；实测没有改善 S4，当前保留 1 MiB 交互提交和稳定 Worker Blob 协议。

## 14. 相关文档

- `docs/performance/LI3D_PERFORMANCE_OPTIMIZATION_PHASE_7.zh-CN.md`
- `docs/performance/LI3D_PERFORMANCE_OPTIMIZATION_PHASE_6.zh-CN.md`
- `docs/performance/LI3D_PERFORMANCE_TEST_PROTOCOL.zh-CN.md`
- `docs/MASTER_UPLOAD_DELTA_2026-08-07_AND_REMOTE_MERGE.zh-CN.md`
