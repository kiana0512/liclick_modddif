# UV 后处理分段与重复计算优化

UI-09 → M07，ALG-UV-005 v2.0.1（调度与实现 Patch，像素语义不变）。基线 master b3431cb。只改三份生产源码，不修改生产服务、阈值、质量或分辨率。

## 改动与边界

UV gutter 初始八邻点成员判断改为等价索引读取；邻点循环保持原数组次序，以索引读取代替解构迭代。接缝、拓扑光栅、覆盖扩展、封闭补洞、gutter 使用共用同步/协作 generator：累计约 8ms CPU 后通过现有 waitForBrowserPaint 让出绘制，隐藏页面沿用 timer 兜底。8ms 是检查预算，不能约束 GC、Canvas 原生调用或纹理上传。

接缝在单次后处理内复用 indexed 顶点变换及位置键；不跨任务缓存，不改变双精度运算。公开 collectUvSeamPairs 保持原对象身份行为。像素行序、邻点/donor 顺序、Map 首写获胜、逐轮提交、RGB/Alpha、coverage 标记、岛归属与边界判定保持。处理中数据仍为未发布的 bake 结果，完成后才走既有编码/预热/发布流程。

## 对应路径审计

- GPU parity、direct GPU、CPU fallback 的接缝、覆盖扩展、补洞、gutter 及拓扑失败兼容分支均 await 协作入口；单层接缝同样让帧。
- gpuUvBakeRenderer 的同步 seam collection、uvRasterizer 和其他同步 dilation 消费者仍走同一数值内核，不改 shader 或渲染状态。
- uvBakePostprocess.worker 及桥接未启用新的流程；未替换生产 UV/PBR 服务、未启用替代实验内核、未放宽既有 GPU 校验门限。
- PNG、export、UV_MERGE_COMPOSITION_VERSION=5、Schema、Project Command 幂等性、Revision CAS、ownership、verified assets 不变，无数据迁移。
- 回滚：恢复三个源码文件原同步入口、旧 gutter 扫描与接缝构建；无需删除、重写任何工程或资产。

## 正确性验证

冻结 b3431cb 独立旧核。600 组 gutter、500 组覆盖扩展/封闭补洞、40 组接缝场景，同步和协作版本的 RGBA、coverage、计数均相同；含单行/窄图、多种 alpha、岛归属、索引/非索引网格、缺失法线、非均匀变换。另验证主线程调度、异常、所有合成入口 await。Edge Canvas 80 组拓扑光栅对照（两种 coverage 模式、索引/非索引、非有限坐标）零差异。

用户「割草机器人」原工程 4096² 的临时同输入诊断：gutter 填充 1,969,319 像素；接缝 15,272 对、修复 84,224 像素；覆盖扩展 489,378 像素；封闭补洞 78,563 像素。各步对冻结旧版 RGBA、coverage、计数均零差异。这些原工程诊断在最后的顶点复用/索引循环优化之前，最后优化由上述冻结旧核测试覆盖。所有临时诊断源码和产物已移除，诊断运行不用于性能统计。

## 原工程实测与限制

2026-09-09，RTX 4070 Ti SUPER，in-app Chromium，DPR 1.3，4K / 300,000 triangles。S4 使用同工程 14 个普通投影 + 1 个修补底层，自动旋转模拟交互；benchmarkOnly 不写图层或工程。它不等同于用户手动选择的所有 repaint/merged-UV 层组合。Browser 专用插件未提供；隔离浏览器测试使用已安装 bundled Playwright，原工程使用 CUA。

| S4 指标 | b3431cb 基线 | 最终优化实测 |
| --- | ---: | ---: |
| 全流程 P95 帧间隔 | 16.8ms | 16.8ms |
| 全流程最大帧间隔 | 1701.3ms | 83.4ms |
| 掉帧比例 | 19% | 3% |
| bake 阶段（GPU 栏，包含 CPU 后处理和等待） | 23234ms | 25526ms |
| 接缝 / 补洞 / gutter（含拓扑） | 990 / 4629 / 1590ms | 2171 / 6203 / 1751ms |
| PNG 编码 | 1819ms | 1738ms |
| 输出 / 覆盖率 | 22.76MiB / 49.00% | 22.76MiB / 49.00% |

原版视口 822×998、最终版 998×998，缓存/堆状态也有差异，因此不能把这些数字当成严格受控的收益百分比。最终最慢阶段是 gpu-detached-texture-upload-submit；未宣称零掉帧。中间仅分段版本 bake 27969ms，减少重复计算后为 25526ms，但仍慢于旧版基线：**响应性明显改善，缩短整次合成耗时尚未达标**。单独 gutter 4K 隔离基准旧版 395–412ms、新版 270–293ms（含绘制等待），不代表整次合成更快。

各轮 PNG 大小曾在 22.71/22.76MiB 间变化，拓扑校准原始像素数也有变化，未将不同运行间的大小一致当作像素一致证据；正确性依据是同输入逐字节对照，未放宽既有校验。

最终 Web 93 项回归、类型、修改文件 lint、Cloud/repository 边界通过；构建与原 bundle budget 通过（82 chunks / 3,141,342 bytes）。4517 保持运行，未提交/推送或部署生产。
