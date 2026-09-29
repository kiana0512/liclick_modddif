# 运行时投影深度／法线绘制调度

UI-06/UI-10/UI-13 → M06，协作 M03/M07/M08；RUNTIME-VISIBILITY-SCHEDULING v1.0.1，production，Patch；负责人 Codex。用户要求专项 A/B，问题或低收益先同步，保留数据和截图并创建飞书报告。

输入：冻结 SerializedCamera、捕获对象世界矩阵、目标 group、原始请求尺寸及 includeNormal。输出：原格式 RGB packed linear-view depth PNG，以及可选几何 view-space normal PNG。当前视口旧数据修复与重绘校准通常 includeNormal=false；UV bake 按参数决定，默认 false。没有额外生成法线。

改动：每个 pass 从 256px scissor tile 改为一次整张提交，在深度开始前检查 idle。深度→法线的 waitForBrowserPaint 和 idle 保留。已有 Three PBO 同步、分条读回、GPU/CPU 像素公式、normal 导数、颜色空间、几何/矩阵克隆、外层缓存与 renderer 锁保持。

验收：全屏 Edge，原始 Bicycle 1,857,094 面，压力组 6 份共 11,142,564 面。A=当前分块，B=整张保留等待，C=整张删去 pass 间呈现帧；每场景每模式四轮，首轮预热、后三轮中位数。A/B 已同享前一轮读回优化，避免重复归因。512 仅深度 72.4→24.4ms，1024 仅深度 321.5→71.6ms，1024 双图 653.0→150.6ms，2048 双图 2623.7→518.5ms；带输入压力补测 653.8→155.7ms。72 次捕获深度/法线 RGBA 差异 0，保存的 PNG 哈希相同且输出非空。

C 在 2K 双图仅额外减少 14.6ms/2.8%，已同步用户，未采用。压力补测 B 的部分 pointermove 派发 P95 达 16.4/17.1ms，A 四轮最高 12.8ms；最大帧间隔 A/B 16.8/16.9ms。样本数和时长不同，不承诺零交互代价或跨设备同等收益。夹具执行真实渲染函数、旁路外层缓存，idle callback 仅计数，不冒充完整编辑器持续按键暂停测试。有效作者深度及缓存命中仍复用，因此不是全部项目打开/烘焙都会获得相同收益。

审计：GPU 改变提交粒度；CPU 减少逐 tile 调度；Worker/PNG 与 shader 代码未在本项修改；持久化无 Schema/Command/CAS/ownership 或资产格式变化；CPU/GPU UV raster 和导出仍消费相同深度/法线。无迁移。回退恢复两个 tileSize=256 及各自 idle callback，保留既有资产。

测试：真实运行时编排新增 whole-pass、idle、depth-only、失败清理与原材质所有权断言；完整 Web 156 项回归、typecheck、改动文件 lint 通过。Trace 复用现有捕获读回/编码阶段与 runtimeProjectionVisibilityLastTiming；没有新增默认采集。

证据：[专项本地文档](../../output/texture-optimization-20260929/runtime-README.md)、[主实验](../../output/texture-optimization-20260929/runtime-results.json)、[压力补测](../../output/texture-optimization-20260929/runtime-confirm.json)。[飞书完整优化报告](https://lilithgames.feishu.cn/docx/TekRd1TZRo2GzAxYFqQc7TWqnxb) 通过 lark-cli 写入，含表格、图片和数据附件。修改尚未提交、推送或部署，没有付费生成。
