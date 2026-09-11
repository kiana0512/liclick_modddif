# 常驻 UV 显示与派生结果缓存

主模块 M06，协作 M03/M07/M08；显示契约 `UV-DISPLAY-BUFFER/1.0.0`，内部校正标记 `RESIDENT-ROUNDING-RUNS/2`。用户明确要求投影仅参与计算，视口持续显示 UV，包含图层眼睛开关后的重算阶段。

## 行为与所有权

- SceneRoot 只负责订阅和绑定；ResidentProjectedUvDisplay 在引擎中协调原 `bakeVisibleProjectedLayersToTexture` 路径。逐层可见性、内容、相机、蒙版及 live revision 进入派生签名；普通行选择、旋转/缩放/平移视口不改变 UV 内容。
- 完整结果经 Worker 位图和分条上传后发布，绑定确认后才能淘汰旧纹理。重算保留上一完整 UV，初次没有结果时保留原底图。没有新增投影叠加过渡，也不把选中投影留在每帧 shader 中。
- 逐层缓存保存现有 GPU 内核生成的 quantized color/quality，命中时跳过源解码、上传和投影光栅；继续使用原 Top-K、完整精度门禁、舍入校正及接缝/gutter。mutable live 源不复用静态光栅。模型/几何版本、变换、采样参数、内容改变或上下文丢失会失效。
- 光栅与未覆盖局部重绘的普通投影合成结果共享 256 MiB 上限。已完成 UV 的 GPU 纹理上限 512 MiB，上传完成即释放 Worker 位图副本。另有 256 MiB 无损 deflate 状态缓存、64 MiB 已合并蒙版源、32 MiB 几何快照及最多 64 MiB 有序接缝地址；Top-K 工作目标在 4K 时约 576 MiB，另有在途计算/编码资源。缓存均有界，不意味着零显存/内存成本；完全未命中的组合仍需计算。对象卸载释放派生资源。
- 无损缓存保存原始 RGBA 和 rendered-color mask，包括 alpha=0 的隐藏 RGB，不经 Canvas/PNG 丢失边缘颜色。编码一次只接收一个任务；恢复显存中已淘汰的状态可解压并上传，不重新投影。失败退回原完整计算，前台保留最后完整显示并报告最终错误，不降采样。
- 显示和手动合并共用 `prepareMergeProjectionLayers`，局部重绘按原规则合并源 alpha 与蒙版。常驻 UV 管理当前模型时，停止额外的推测性合并预热；显式合并仍保留原验证、持久化和导出路径，避免两个任务争用同一串行烘焙队列。
- 已合并 UV 底层和 content-aware 底图继续在 UV shader 中按上下顺序叠加；局部重绘顶层和 rendered-color mask 保留。旧投影显隐回调不能把新 UV 底图透明度清零。投影作者 UV 蒙版已经参与逐层计算，不能再次乘到整个 UV 栈。

## GPU / CPU / Worker / Shader 审计

后续迭代（M09/M07/M06）：`ALG-UV-008` v2.0.3 保留每条 8 MiB，独立烘焙 GPU 最多两条读回重叠，额外在途 PBO 上限由 8 MiB 到 16 MiB；可见 renderer 仍逐条等呈现。结果直接写入完整 RGBA 的独占区域，包含透明像素隐藏 RGB；所有异常先观察并排空已提交读取，目标释放不早于在途读取结束。四组交替 4K 实测串行 112.9–114ms、并行 67.1–71.9ms，完整像素差异 0，测试最大帧间隔约 17ms；不能据此承诺任意工程整体收益。

`UV-TOPOLOGY-SOURCE-CACHE/1.1.0` 消除显隐时重新展开整个高模三角形的开销。单个原始 UV/index 快照最多 32 MiB，根对象弱引用，不额外保留已卸载模型；共享原始字节去重，未设置 needsUpdate 的实际编辑仍被检出。超过预算保留精确重建路径。首次展开和字节校验按 4ms 预算让出，覆盖全部顶点，无降采样；编辑发生在准备过程中时拒绝发布混合快照。缓存命中的耗时报告只计当次来源校验，不重复报告首次 GPU/CPU 校准耗时。接缝仍使用完整位置/法线/变换快照，拓扑只看实际依赖的 UV/index。

原工程单次对照中，拓扑校验与 gutter 所在阶段约 826–849ms 降至 306–312ms；新局部重绘组合约 1838ms，普通投影组合约 4035ms，返回已有完整状态约 48ms。来源解码与 GPU 开销波动明显，整体尚未达到即时更新；逐层贡献缓存及消除整图后处理仍未完成。CPU/Worker/shader/保存/导出的 RGBA、权重与质量门禁均不变，无持久格式变化；回滚恢复调度和来源校验实现即可。

本轮最终验证：119 项完整回归通过，含读回部分尾条、双在途上限、乱序成功/失败排空和可见 renderer 呈现边界；拓扑回归确认缓存命中不访问逐顶点 getter，未设置 needsUpdate 的 UV/index 改动仍失效。TypeScript、生产构建与普通包体检查通过：3,211,451 / 3,222,000 bytes，剩余 10,549 bytes。真实独立 WebGL 4K 读回与原工程浏览器测试无错误；没有据此声称正式推送检查或远端 CI 已通过。本轮未推送。

GPU 光栅和 Top-K 继续使用 ALG-UV-003 的原数学公式。新增缓存仅转移目标所有权，并保留已编译的常驻合成器。内部不确定舍入标记增加相邻 texel 的四个整数候选完全相等检查；重复标记复用前一精确结果，只有不同候选需要 gather，标记不会进入发布纹理。CPU 的 double resolver 不变，校正按 4ms 预算让出；alpha/颜色/候选顺序逐字节对照。

Worker overlay 对 source RGBA、原 base RGBA、quality、rendered-mask 完全一致的相邻输入复用结果，coverage 仍逐像素计数；literal/feathered、透明阈值、linear/sRGB、顺序和颜色贡献公式不变。透明清理/gutter 空闲时让出浏览器任务，交互忙时仍让出绘制帧。

`UV-SEAM-REPAIR-PLAN/1` 保存按原遍历顺序生成的像素地址，包括重复地址，维持先前修复可作为后续 donor 的行为。几何快照按实际共享字节范围去重，逐字节等价的整数比较仍捕获未设置 needsUpdate 的几何修改；GPU、CPU、Worker 拓扑和接缝遍历均排除绘制/线框辅助网格。渲染程序保留引用避免每层销毁后重新编译，纹理与材质值仍按当前源更新。

新增 UV 显示 shader 的底层输入只采样 UV；原未覆盖斜线和 flat/coverage capture 保留。没有修改源资产、输出分辨率、生产计算服务或开启实验 UV/PBR 服务替代。

常见投影栈使用与手动 UV 合并相同的 overlay sampler，避免把已合成结果放入不同材质混合角色产生额外 alpha 差异；有上方 UV 图层时保留多层顺序。截图屏障同时冻结 base / UV overlay / live UV 三个采样器，眼睛计时等到实际材质绑定。原工程同来源裸投影 UV 与新编码 UV 的 CPU、GPU 及整帧像素已验证一致。完整合并包含底层 RGBA 合成，仍须单独检查，不得误把旧的已合并纹理当成本次结果。

`UV-PIXEL-SPACE/1.0.0`（M07，协作 M06/M09/M11）：投影顶点按 `UV × resolution` 进入 GPU 窗口坐标，旧补边拓扑和 CPU 接缝却按 `UV × (resolution - 1)` 缩小，导致岛边错位。CPU 拓扑、Worker Canvas gold / WebGPU 顶点、CPU 诊断光栅和 PBR 法线烘焙统一到像素边界坐标；CPU 接缝按 floor 选择包含该位置的 texel。GPU 投影采样、Top-K、来源 alpha、蒙版和邻域 donor 顺序不改；不恢复全局补洞或改变分辨率。Merge / bake protocol 升为 9，会话 v13、persistent-4，旧资产不自动重写。回滚同时恢复坐标消费者和版本，清除派生缓存；历史资产继续可读。

## 持久化、导出、迁移与回滚

### 2026-09-11：首次转换与白边后续修复

本轮最终本地回归 120 项全部通过，包含新增蒙版支撑范围逐像素对照；独立 WebGL 质量打包读回及 DPR=2 状态恢复检查通过。新局部重绘显隐组合约 1189ms，普通投影组合约 2933ms，重复已有组合约 48ms，后续仍需降低新组合等待。

主模块 M06/M07，协作 M09/M15。用户明确要求在 WebGL 正确性已验收后移除每次整工程 CPU 对照，优先减少首次和新显隐组合的延迟。

- `UV-DEVICE-CALIBRATION/1.0.0` 在实际 renderer/context 上用 256×256、6 层有限输入检验 Top-K、0–255 alpha/quality、字节反预乘及两种输出 alpha 模式；通过后普通计算不再读回每层完整 4K RGBA/quality 给 CPU 重做。设备小样本不是对所有输入的数学证明，完整工程 CPU/GPU 对照仍作为回归/发布验收，以 `perfQualityGpuAb=1` 强制运行；GPU 不确定舍入仍精确 CPU 修正。失败阻止结果发布，context loss 重新校验，不持久保存设备“通过”标记。记录本次实际 WebGL 首次校验约 161–171ms。
- CPU 对照请求原来还启动一遍结果不会采用的 WebGPU 求解。现在 `forceCpuOutput` 仅生成 CPU gold，常驻 WebGL 对照门禁保持；原候选 WebGPU 在其真实调用入口保留校验。原实现/新实现 CPU RGBA、coverage 一致，并断言不再分配该无效 GPU 工作的 buffers。
- `UV-QUALITY-READBACK-PACK/1.0.0` 将原质量目标每个 alpha 字节按四字节一组装入 RGBA 目标，减少 75% 质量传输字节，恢复时仍输出完整分辨率 Float32 QA 数据。16/512/4096 GPU 逐值一致、状态恢复和损坏长度拒绝通过；单次 4K 质量读回约 174→108ms。正常通过设备校验后已不需要整层读回，此项主要加速显式完整 QA/兼容入口。
- `PROJECTED-MASK-FOOTPRINT/1.0.0` 首次按 mask 的非零 RGB×alpha 支撑计算保守双线性范围，范围外直接得到原本就为零的覆盖；有效区沿用原 sampler，不改分辨率、像素坐标、羽化、作者 alpha 或隐藏 RGB。CPU 和 masked Worker 共用同一函数。800 组冻结旧核对照及真实 4K 工程通过，原工程蒙版准备约 2.4s→0.57s。PNG 中间格式改为临时 Canvas 的候选无明确收益，已撤回，未增加该候选的运行时缓存预算。
- Worker 的空闲让出使用 scheduler/MessageChannel，避免连续 `setTimeout(0)` 的定时器下限；交互保护的真实延时不改。底层 RGBA 合成原公式与 QA 不变。
- `UV-DISPLAY-BUFFER/1.1.0` 将可见 content-aware UV underlay 在生成最终显示 RGBA 时按显式 Merge 的 source-under 规则合成，显示只消费最终 atlas，避免二次 alpha 组合导致岛边白线。底层进入请求/持久身份，rendered-color mask 按新增 albedo 覆盖修正归属；未修改 ProjectedLayerMaterial 的深灰斜线或颜色。正面、俯视原工程对照：最终 4K RGBA 差异 0，截图差异 0。非零 rendered-color 混合工程仍需单独扩大验收。
- 手动“合并 UV”进度标题改为对应合并动作；此前显示“自动烘焙 BaseColor”造成误解，不表示新增或移除了后台自动烘焙。

本次普通路径首次完整显示约 17.6→6.2s（20 个投影/旧局部重绘来源，原模型、4K，同机单次样本）；新显隐组合仍有秒级等待，未达到用户即时要求。夹具修正为首次挂载就带全部来源，去掉原先人为等待 1500ms，分别记录首次、显隐、F5 与 CPU full-QA，不能和旧夹具加载数字直接混比。不要将几十毫秒的已有状态命中当成任意新状态速度。

最终 F5 持久缓存复测：同一只读原工程夹具约 2192ms，来源摘要校验与无损恢复约 560ms，最终纹理上传约 94ms；maskPreparationMs=0，未重算投影。原始加载和刷新页面运行于独立测试浏览器，不能将此数字当作用户所有网络/设备的稳定保证。俯视 4K full-QA 的 GPU RGB/alpha 差异为 0，实际最终 UV 与手动 Merge RGBA/整帧差异均为 0，浏览器无异常。上一集成提交 e784659 的 pipeline 629901 全部 8 项通过；本次提交还须执行正式 prepush 并确认新流水线。

GPU 光栅/shader、CPU blend、Worker Top-K、完整分辨率与源资产不变；只有派生显示组成方式变化。persistent purpose 从 resident-uv-display-1 升为 resident-uv-display-2，旧派生快照失效一次，不重写历史合并 PNG、Project Schema、Command/CAS/ownership 或 verified assets。PNG/FBX 显式导出继续原生产入口，mask 支撑优化共用相同原像素函数。回滚须同时恢复显示底层绑定与 purpose；若恢复运行时全工程校验，移除设备轻校验调用即可，保持完整 QA 分支。逐层贡献持久化和任意新组合的增量重算仍未完成，不宣称已经实现。

拓扑缓存同时校验实际序列化 UV 三角形，捕获未设置 `needsUpdate` 的 UV / index 修改；发生变化时页内结果和 Worker key 一起失效。辅助网格不参与身份计算。此项避免更新后补边继续使用旧岛边界，属于 v9 派生缓存正确性修复，不更改源资产。

刷新验证保持实际源字节 SHA-256 身份：同一几何共享字节范围只哈希一次，同 URL 的源文件去重，并以最多三个并发请求校验来源，减少逐层串行网络等待。摘要内容、账号隔离及失效规则不变，不依赖 URL 相同就信任内容未变。

`UV-DISPLAY-DERIVED-CACHE/1` 增加按账号、工程、对象、真实模型与源资产内容 SHA-256、分辨率、图层参数和算法版本隔离的浏览器持久缓存。首次呈现可恢复原 RGBA 与 rendered-color mask；Worker 无损压缩并校验缓存字节摘要，损坏、版本不匹配、无账号或不可持久化的 live 来源均重新计算。最多保留两个压缩快照，每个不超过 256 MiB；配额不足不影响正确显示。显隐热路径不等待摘要/磁盘写入，保存派生缓存不能占用下一次重算队列。

这只是同一浏览器刷新恢复的派生快照，不是已经完成逐层 UV 贡献的 Cloud 资产持久化。逐层颜色/覆盖/质量候选持久化及新组合 Top-K 重算仍需继续实现和验收，不能把完整状态缓存命中约 50ms（计至实际材质绑定）表述为任意开关即时显示。原工程测试新局部重绘组合约 2 秒、新普通投影组合约 4 秒，尚未达到用户验收要求。

缓存格式升级创建新 namespace / purpose，不读取旧格式；回滚后旧代码忽略该 namespace，可清理浏览器派生缓存，不修改任何历史工程 Revision、Cloud 资产或源图层。

派生计算传入 `commitToProject:false`、`markSourceLayersBaked:false`，不添加烘焙记录，不删除/合并源图层，不写 Project Command。sourceModel/rasterCache 只属于运行时输入；Project Schema、Revision CAS、Command 幂等性、ownership、verified assets 不改，无历史资产迁移。独立图层、撤销和保存保留原协议；PNG/FBX/正式合并仍走原完整输出链路。GPT 组间及局部重绘交接识别实际绑定的 UV 中所包含的源层。

回滚本变更恢复上一版本显示协调入口；GPU 标记生成与 CPU 消费必须一起回滚，不能混用两种内部标记。清除内存派生缓存即可，不重写项目或已有 PNG。

## 验证记录

- 后续实验未采纳：完整 coverage/topology 相等时缓存有序 gutter donor 地址，4K 隔离命中可由约 184ms 降至 38–47ms，但冷计算增加建表成本；原工程显隐会改变覆盖，阶段约 358–362ms，未优于原方案。进一步只检查拓扑边界与岛外 coverage 的候选仍不能有效命中，原工程阶段约 483–522ms、总切换约 2.1/4.2 秒，故两版生产改动均已撤回。保留本地实验记录，不把隔离命中收益当作用户工程的优化成果；后续优先减少逐层来源准备、投影及完整 RGBA 往返。

- 已推送集成提交 `b683157f4f98f54aa7efe4f33fe4b89c1e680acf`，正式发布包体 3,211,881 / 3,222,000 bytes；pipeline #629898 的 lint 阶段发现新增浏览器夹具中的全局引用和空 catch，非包体失败。修正为明确的 window/globalThis 引用并解释诊断 catch；不跳过测试或放宽 ESLint。M15 `RELEASE-PREPUSH/1.0.1` 将 CI 原 lint 命令纳入每次推送前入口，避免普通构建通过却遗漏 lint。下一轮 gutter 地址复用尚未发布。

- 新增 `test:resident-uv-display`：真实 CPU resolver 对照、重复候选重用、光栅内存预算、所有权与几何失效；Worker overlay 对照冻结旧实现，包含 literal/feathered、透明度、rendered mask 与 coverage。
- `check:resident-uv-browser`：真实 React/WebGL，五层普通/重绘投影逐层关闭、从白模逐层恢复、重复状态像素一致、每种状态非空且可区分。旋转/缩放/平移期间绑定同一 UV，UV revision 不增长、投影材质构建数为零。通过 `LICLICK_UV_TEST_RESOLUTION=4K` 检查完整 4K；测试明确区分缓存与冷计算。
- 原生 UV 重绘浏览器回归已通过绘制/擦除/撤销、两层与三层独立显隐、merged UV 底图、PNG、FBX、重新打开以及 4K 曲面可见性检查。
- 完整回归、最终包体与远端 CI 结果在最终提交验证后追加。当前不能宣称所有冷计算已达到无感毫秒级；尤其 4K 缓存未命中仍需单独测量和进一步优化。
- 浏览器 Worker 的 F5 恢复实测（坐标 v9 前）：完整隔离工程页面约 4845ms，来源校验、无损读取/解压约 1034ms，未重算投影。测试必须等待真实缓存写入回执，不能把未完成的异步条件当作写入完成。v9 更新后需重跑。
- 坐标 v9 和拓扑失效修复后的 F5 实测：4K 原工程隔离页恢复 5004ms，`compressedUvRestoreMs=1075.9`，无浏览器错误、未重算投影；这仍不是即时加载。
- 来源验证去重和三并发后，同一隔离测试单次复测为 4712ms，`compressedUvRestoreMs=807.1`，无浏览器错误。单次样本仅证明恢复路径和优化可用，不作为稳定性能保证。4K 五层普通/重绘开关回归再次通过：重复状态像素一致，边缘上传对照最大差值 0，90 帧视口交互不重算投影；新组合仍有秒级等待，未达到即时最终效果的验收要求。
- 本地完整回归 119 项通过；拓扑失效回归覆盖实际 UV/index 字节变化、页内及 Worker 双端失效和辅助网格排除。来源验证优化后相关回归、TypeScript 与生产构建再次通过。当前普通构建包体 3,210,623 / 3,222,000 bytes，剩余 11,377 bytes；正式推送前还必须对最终提交运行 `verify:prepush`，当前未声称远端 CI 已验证这些未提交改动。
