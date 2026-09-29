# 纹理捕获与读回调度优化

UI-10 → M03，协作 M08；INPAINT-MASK-CAPTURE-SCHEDULING v1.0.0，production；Patch；负责人 Codex。

局部重绘的 paintMaskCapture 原本将 2048² 输出按 512px 分成 16 次绘制，每块先等待呈现，再等待 GPU fence，随后执行原分条读回。改为提交前让出一次呈现帧，使用已有整张绘制分支；完整像素仍由原分条异步读回及灰度 PNG Worker 编码。

输入为冻结相机、目标对象和 accumulatedMaskTarget 的作者 UV 蒙版。输出仍是原尺寸灰度 PNG URL；coverage > 0.01、正反面通道、反选、未选中前景的黑色深度遮挡保持原样。算法只改变提交调度，不改变颜色空间、矩阵、输出分辨率或像素公式。

GPU：从多次 scissor draw 改为一次完整 draw，沿用异步 PBO 读回同步。CPU：移除逐 tile 等待，保留提交前单次呈现等待和原状态恢复。Worker：原 PNG 编码，无协议变化。Shader：原蒙版与遮挡材质。持久化：无 Schema/Command/CAS/ownership 或资产格式变化。导出：不涉及，未改变回贴、UV 或导出路径。无数据迁移；回退仅恢复此入口的 tileSize 和 waitForViewportIdle 配置。

Trace：复用已有 capture.readback、capture.encode 和 button2-mask-capture 阶段信息；此修改未增加默认采集或上传。文档入口沿用系统标准第 11 节，不新增模块。

验证：执行真实 capturePaintMask 回调的 inpaint-prewarm-ownership 回归增加单次呈现等待与整张提交断言，原遮挡/恢复断言保留；capture-renderer-isolation、Web typecheck 与改动源文件 lint 通过。

## 本机全屏浏览器对照

Edge，全屏 API 生效，页面可见且获得焦点，viewport 1241×1206、DPR 渲染倍率 1，空闲 rAF P95 16.8ms。原始 Bicycle 1,857,094 三角面，固定捕获相机，构造包含正反面差异的 UV 作者蒙版；可见视口持续绘制，鼠标输入改变显示相机。夹具从 HEAD 与工作区提取实际 capturePaintMask 回调和蒙版 shader，调用当前生产 renderSceneToPngUrl、分条读回、PNG Worker。不是完整生图/远端请求的端到端测量。

每场景 old/new/new/old/old/new/new/old 交错执行，所有 24 次都与该场景首轮逐 RGBA 字节相同且非空；计时包含单次等待、绘制、读回与 PNG 编码，像素验证在计时区间外。每种模式排除首次预热后取剩余三轮中位数：

| 场景 | 原分块 ms | 整张 ms | 减少 |
| --- | ---: | ---: | ---: |
| 2048×2048 | 809.2 | 296.0 | 63.4% |
| 2048×1495 | 593.9 | 221.6 | 62.7% |
| 2048×2048 反选 | 799.4 | 294.2 | 63.2% |

大部分捕获的 rAF P95 16.8ms；旧版有一次最大间隔 33.3ms，新版有一次 33.4ms。持续输入覆盖的反选四轮中，每轮 pointermove 派发延迟 P95：旧 9.1/9.3/9.3/9.5ms，新 14.9/14.0/9.3/10.6ms；不同捕获时长导致样本数量不同，不将这些分位数相加或当作输入到呈现延迟。整张提交有短时输入延迟取舍，不宣称零卡顿或低配设备同等收益。

本地复现脚本 `.codex-tmp/serve-mask-check.mjs`、`.codex-tmp/mask-check-browser.mjs`，原始结果 `.codex-tmp/mask-check-results.json`（均为未纳入版本控制的本机验收材料）。运行 server 脚本须以 apps/web 为工作目录，打开其 /__mask-check，全屏后运行。早期内置浏览器虽报告 visible/fullscreen，却出现约 1000ms rAF 间隔；该轮仅作像素参考，时序作废，另存 mask-check-iab-throttled.json，未混入上表。

上述为第一轮蒙版独立实验；后续继续实施和验证了下列范围。

## 第 2、3、4 项与最终组合验收

- 第 2 项：flat/clay 改为提交前一次呈现等待与整张 draw，保持同样的材质/覆盖、2K 像素及同步恢复。CAPTURE-MATERIAL-ISOLATION v1.0.1；viewport-clean 与运行时深度/法线 tile 不变。
- 第 3 项：UV-READBACK-SCHEDULING v1.2.2 新增可选 task 让步，仅 renderSceneToPngUrl 选择它。可见 renderer 仍 1MiB/并发 1；Three 异步 PBO/fence、失败排空与尺寸均不变。所有其他调用默认 paint，独立上下文仍 2MiB/并发 4。
- 第 4 项：只采用 PNG Worker 直接转移原编码缓冲，去掉一次等长 slice。未跳过 PNG 编码/解码。倒序行编码候选虽能减少 RGBA 缓冲，但两轮白模均变慢，已撤回；不把低拷贝量等同稳定提速。

全屏 Edge、同一原始 Bicycle 的最终组合对照：蒙版 801.8→161.4ms，flat 643.0→237.6ms，clay 654.1→243.7ms。每场景交错八轮、各模式剔除首次预热后取三轮中位数；24 次逐像素一致且 PNG SHA-256 配对一致。PNG 直接转移独立对照 40 次完整编码字节一致。读回独立对照覆盖 2K 方图、非方图、4K，24 次像素一致。不是完整生图/保存端到端验收。

验证：156 项 Web regression 全部通过，typecheck、改动源文件 lint、git diff --check 通过。新增整张提交、task 让步尾条带/失败、PNG 完整缓冲所有权断言；原像素/生命周期/材质恢复测试保持。

完整优化文档、前后原图、哈希、原始样本、未采用候选、异常时序、截图及复现夹具见 [本次优化证据](../../output/texture-optimization-20260929/README.md)。证据是本地文件，尚未提交。没有付费生成、推送或生产部署。第 2 项恢复两个入口 tileSize 即可回退；第 3 项取消捕获的 task 选择；第 4 项恢复原 PNG slice；无历史资产迁移。

合入前代码审查：修正本次新增呈现等待的相机快照顺序。paintMaskCapture 必须先 cloneCameraForCaptureAspect，再等待视口帧，避免未传固定相机的调用截到等待后导航的视角。新增断言先在修改前失败，调整后通过；定向回归、typecheck、lint 通过。此前 A/B 使用固定相机，数值保留为当时样本；本修正没有新增性能收益声明。
