# Li3D 性能优化阶段 8：内容修补与 4K 合成稳定性交付

更新时间：2026-08-11

## 交付结论

阶段 8 已达到可合并状态：生产构建和专项自动测试通过；真实工业切割机器人项目完成 S4、S6、S7、S8、S9 与生产导出验证。没有降低纹理分辨率、采样质量、修补算法、深度/法线判定或 UV 合成精度。

本阶段优先级保持为：稳定与正确第一，质量第二，速度第三。仍存在的 4K GPU 光栅/回读长帧在“剩余风险”中如实记录，不以降质或隐藏数据的方式宣称解决。

## 一、问题与根因

### 1. 内容识别修补发布后白膜或必须重开眼睛

投影 shader 为内容修补预留的 base sampler 在新纹理异步解码完成前可能已经获得非零 opacity。预留 sampler 的安全占位是白色，因此形成白膜；再次切换眼睛会触发后续 uniform 同步，看起来像“重开后恢复”。

项目包含多次内容修补时，单独开启某一修补眼睛还会重新排队做 UV 合成，而不是直接使用该层自身的稀疏纹理，导致眼睛状态与画面短暂不一致。

### 2. 内容识别修补和 4K UV 合成期间交互长帧

- 4K ImageBitmap 交给 Three.js 首次使用时会触发整张 `texImage2D` 上传。
- 投影烘焙逐层创建 CPU canvas 纹理，解码、上传和 GPU pass 容易集中在连续帧。
- 运行时深度即使与当前模型矩阵完全一致，旧路径仍可能重复生成。
- 性能实验室在重负载期间刷新大面积 HUD，会把调试台自身提交混入被测最大帧。

### 3. 缺少可证明的内容修补正确性基准

原实验室没有真实运行“14 投影层 → UV 烘焙 → 拓扑 → 内容修补 Worker → 原子发布”的场景，无法自动证明白膜安全、眼睛状态、确定性和原图层恢复。

## 二、代码改动

### A. 白膜和眼睛状态原子化

- 内容修补 base sampler 从投影材质第一次构建起固定预留；新增/替换修补层只更新纹理和 opacity uniform，不再改变 14 层 shader 结构。
- 内容修补层 ID、URL 和内容修订不再进入投影数组结构签名，修补发布不触发投影材质重建。
- 精确纹理没有 ready 前强制有效 opacity 为 0；纹理 ready 后再一次性发布，禁止显示白色占位。
- 单个可见内容修补层直接使用常驻纹理；两个及以上可见层仍按原 authored order 精确合成。
- 内容修补纹理被优先纳入常驻预热，眼睛切换不再临时解码/合成。

### B. 不降质的 GPU 上传调度

- 4096 纹理保持原尺寸、RGBA、色彩空间、过滤和各向异性设置。
- 4K UV 合成结果在成为可见纹理前，先以精确条带完成 GPU 上传，再原子替换。
- 单帧上传预算从 1M 像素调整为 2M 像素；真实 RTX 4070 Ti SUPER 测得单条最大 4.6ms，5 张 4K 常驻预热由约 45.0s 降为 25.0s。
- 投影烘焙优先复用满足尺寸约束的常驻解码源；其他源异步转换为 ImageBitmap，并在 offscreen pass 前分条上传。
- 共享 ImageBitmap 的所有权和释放路径分离，防止烘焙临时纹理销毁视口常驻源。

### C. 深度复用与正确性保护

- 只有在线性视图深度、法线都存在，并且 4×4 object matrix 在 `1e-6` 容差内完全匹配时才复用运行时可见性结果。
- 不满足任一条件即重新生成，避免以速度换取穿透、遮挡或旧姿态错误。
- 性能分解新增 reused/regenerated 层数，不改变最终深度判定公式。

### D. 真实 S9 性能基准

- 新增真实 14 层内容识别修补测试：强制临时开启 14 个投影源、隐藏原内容修补层、执行完整生产算法。
- 基准产物使用无损 PNG data URL，只用于测试，不写工程资产、不写历史、不保存项目、不弹产品 toast。
- 发布后必须等待指定新层同时满足：`safe=true`、`textureReady=true`、眼睛可见、有效 opacity 大于 0。
- 测试结束恢复原图层数组、活动层和眼睛状态。
- Worker 对最终稀疏 RGBA 计算 FNV-1a 校验和，用于冷热轮像素级确定性 A/B。

### E. 性能实验室自扰动隔离

- S4/S6/S7/S9 测量窗口保留 rAF、长任务和原生采样，但暂停大 HUD 的 React 刷新。
- S7 增加独立 rAF 采样器，避免开发态 HMR 重启公共采样器后产生虚假的 `0ms`。
- S7 等待投影数组、UV 组合、UV 常驻纹理和线框全部 ready 后才开始，避免把预热中的占位状态误报为功能错误。
- 性能报告 JSON 新增完整 S9 数据。

## 三、真实项目量化结果

环境：Windows、Chrome/ANGLE D3D11、RTX 4070 Ti SUPER、工业切割机器人、14 个投影层、产品质量参数不变。性能数据只采纳 `document.visibilityState=visible` 的前台标签页。

### S9：真实内容识别修补（2048 修补上限）

| 指标 | 冷轮 | 紧接热轮 |
| --- | ---: | ---: |
| 总耗时 | 20.89s | 10.09s |
| 投影烘焙 | 15.08s | 8.08s |
| 运行时深度 | 6.32s | 0.20ms |
| GPU 光栅/回读 | 7.03s | 6.99s |
| 拓扑 | 3.90s | 7.7ms |
| 修补 Worker | 626.6ms | 556.7ms |
| 原子发布 | 915.9ms | 854.1ms |
| 发布到首帧可见 | 25.1ms | 30.8ms |
| 帧 P95 / 最大 | 16.8 / 66.8ms | 33.4 / 66.7ms |
| 投影材质重建 | 0 | 0 |

两轮结果完全一致：FNV-1a 校验和 `556722154`（十六进制 `0x212ee7ea`）。两轮均满足白膜安全、纹理 ready、眼睛可见、有效 opacity=1、原状态恢复。

### S4：真实 4K UV 合成

| 指标 | 冷轮 | 热轮 |
| --- | ---: | ---: |
| GPU 链 | 35.03s | - |
| 4K UV 合成 | 2.38s | - |
| WebGPU RGBA | 2.26s | - |
| WebGPU A/B | 差异 0 / 最大差 0 / 回退 0 | 差异 0 / 最大差 0 / 回退 0 |
| 帧 P95 / 最大 | 16.8 / 467.0ms | - |
| WebGPU 回读 | 约 156ms | - |

8MB 分片 GPU 回读将 WebGPU 回读从约 879ms 降至约 156ms；Worker 原生无损 PNG 编码约 453ms。输出 18.87MB，覆盖率 48.41%，RGBA A/B 差异 0，未降低 4K 分辨率或质量 pass。当前仍存在一次约 467ms 的 `uv-underlay-composite-encode` 最大帧；P95 已稳定但最大帧门槛尚未通过，因此本项如实列为残余风险。

### S6：完整局部重绘

- 蒙版加 39、减 11、恢复 11，apply 6 笔/60 样本全部完成。
- 实时反馈 P95/最大：16.0/16.0ms。
- 按钮 3 ready/首笔可见：273.3/99.5ms。
- 按钮 2 点击响应 4.0ms；蒙版捕获 22.7ms；四通道精确视图捕获 529.3ms（按帧切分）；输入 Worker 312.1ms；投影 Worker 276.8ms。
- GPU 可见像素 934、最大 Alpha 255、最终场景变化像素 769、最大差 68。
- 投影背景重建 0；发布 P95/最大 16.8/33.4ms；交互 P95/最大 16.8/66.7ms；无 5–10 秒浏览器卡死。

### S7：视口/图层暴力切换

覆盖 PBR、平面、法线、线框，两轮循环，逐个切换 3 个 UV、14 个投影和 2 个内容修补眼睛：

- 投影材质重建：0。
- 显示状态错误：0；材质 uniform 与眼睛状态同步错误：0。
- 局部重绘覆盖层错误：0。
- 帧 P95/最大：16.8/50.2ms。

### S8：刷新恢复

- 结果：通过；总耗时 3.37s。
- 水合 426ms；模型 2.86s；投影 3.16s。
- UV 常驻预热 463.9ms（浏览器缓存热态）。
- UV、投影、局部重绘恢复标记全部 ready。
- 冷恢复窗口最大长任务为 0；纹理阶段 P95/最大 83.4/83.4ms。

### 生产导出

真实点击产品“导出”并等待完成，未再出现 `Could not load projected layer image for baking (relative URL)`，无错误 toast。

## 四、无效样本与否决实验

1. 一次 S9 在浏览器测试标签已被关闭后继续通过旧自动化对象等待，rAF 被限流，得到 168–195s 和仅 1–3 个帧样本。该环境不是可见产品页面，数据作废；重新创建前台可见标签后恢复为 20.89s/10.09s。
2. 曾尝试覆盖/质量两次 PBO 回读并行。A/B 修补像素发生变化，违反正确性底线，代码已全部撤回，不进入本阶段。
3. 未采用降至 1K、关闭质量 pass、减少投影层、降低过滤或跳过深度/法线的方案。

## 五、自动化与构建

通过：

- `corepack pnpm --filter @liclick/web build`
- `corepack pnpm --filter @liclick/web typecheck`
- `test:performance-lab-metrics`
- `test:uv-composite-backpressure`
- `test:projection-layers`
- `buildRepairMask.test.mjs`：6/6
- `surfaceAwareRepair.test.mjs`：11/11
- `git diff --check`：无空白错误（只有仓库 CRLF 提示）

全量 ESLint 仍被阶段 8 以外的 `src/engine/loaders/__tests__/fbxVisibility.test.mjs` 阻断：13 个 `Buffer/TextEncoder no-undef`。本阶段修改文件没有新增 ESLint error；仓库已有 hook/fast-refresh warnings 保持原状。

## 六、合并说明

阶段 8 涉及以下 11 个源码文件与本记录：

- `components/panels/GeneratePanel.tsx`
- `engine/bake/bakeProjectedLayerToTexture.ts`
- `engine/bake/gpuUvBakeRenderer.ts`
- `engine/capture/captureCurrentView.ts`
- `engine/contentAware/surfaceAwareRepair.ts`
- `engine/viewport/SceneRoot.tsx`
- `engine/viewport/ViewportCanvas.tsx`
- `engine/viewport/previewTextureCache.ts`
- `engine/viewport/viewportInteractionState.ts`
- `routes/EditorPage.tsx`
- `workers/webGpuRgbaComposite.worker.ts`

合并冲突原则：投影/UV/局部重绘/内容修补的性能算法与原子发布逻辑保留本分支；无关业务 UI 和拓扑工作流采用同事版本。不得只合并 HUD 而遗漏 SceneRoot 的 sampler 预留与 opacity 安全门，否则白膜会复现。

## 七、剩余风险与下一阶段建议

1. 真实 4K 合成仍有一次约 467ms 的 PNG 编码/交接最大帧。P95 16.8ms 且像素 A/B 完全一致，但严格最大帧门槛未通过。
2. 内容修补冷轮仍约 20.89s，热轮约 10.09s；发布首帧可见在 30.8ms 内，且不再需要重启眼睛。
3. 下一阶段只建议做可严格 A/B 的“分片 GPU readback / 独立 WebGL 或 WebGPU bake context”实验。每项必须保持校验和、覆盖率和 WebGPU A/B 完全一致；任何像素差异立即撤回。
