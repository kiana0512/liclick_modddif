# 局部重绘切换显示断档与性能录制分析

## 范围与证据

- UI-06/UI-10 → M08/M06；`ALG-LR-007` v2.2.1、`ALG-PROJ-007` v2.1.4，状态 production 修复候选，实施 Codex，体验验收维护者。
- 依据用户导出的 `perf_224920a6-910d-456b-b580-a68d95639d9f`，collector 2.2.0，40.336 秒、2261 帧、9 分块；不把原始用户日志复制到仓库。
- 用户操作描述：局部重绘回贴涂抹后切换按钮 1，重绘显示消失，重新显示时卡顿。
- 硬件报告为 RTX 4070 Ti / ANGLE D3D11；渲染快照最大 4 draw calls、600000 triangles、38 textures、28 programs。计数是实际渲染统计，不直接等于原模型面数或系统显存占用。

| 录制时间 | 真实观测 | 结论边界 |
| --- | --- | --- |
| 24.983s | 应用按钮路径 resident-gpu，响应记录 2.1ms | 当次已有 GPU 资源，无须重新生成 |
| 26.168–31.168s | 一次持续涂抹；首笔附近帧 216.7ms，pointerdown 脚本 34ms、rAF 脚本 189.8ms | 首次呈现仍有尖峰，不把全部耗时归为笔刷 CPU |
| 31.188s | 新重绘行发布 0.8ms，随后建立 9 层正式材质 | LayerStore 中存在行不代表 GPU 已包含该行 |
| 32.706s | 切换后 overlayVisible=0，residentMaskOverride=inactive | 与用户报告的显示断档一致 |
| 33.121s | 纹理数组准备完成，累计上传 53.8ms，54 次让步，最长 stripe 2.2ms | 上传总耗时不是单次主线程阻塞 |
| 35.154–37.233s | LoAF 2078.9ms；其中定时脚本 2063.5ms，长任务 2063ms，最大帧 2050.1ms | projectPipeline 脚本字符位置 619278 对应 Three compileAsync 的 currentProgram.isReady 轮询；不能由此推断具体驱动内部行为 |
| 37.454s | 正式材质发布，重绘 live mask bound，准备总延迟 6259ms | 与 32.706s 相比，约 4.75 秒尚未完成显示交接 |

平均 56.08 FPS、P95 16.8ms 掩盖了上述尖峰。报告 droppedFramePercent=60.73% 是原采集器按 >16.67ms 统计的比例，受 16.7/16.8ms 量化影响，不能解释为实际丢掉 60.73% 的显示帧。负数按钮响应和无 Timing-Allow-Origin 的跨域资源阶段时间不用于归因。

## 修复

原 `syncLocalRepaintGpuOverlayActivity` 虽保留 preview owner，却只在 apply/特定 eraser/已启动呈现屏障时允许 exact overlay。切到 none/inpaint-add/inpaint-subtract 时，正式材质尚未绑定也会撤下唯一显示者。缓存复用和可见性监听另有相同的 apply-only 条件；准备函数还会仅因已存在持久行而清掉 owner。

保留有内容的当前 preview owner，直到正式 resident mask 真正绑定。绑定成功后仍按原先清除 owner、呈现屏障、撤下 overlay 的顺序完成交接。复用同一 source/composite/overlay，不清空笔画，不靠刷新或重新解码恢复。空预览不能认领已有结果，eye-off 与显示模式限制仍生效；其他对象、Generation 的身份取消和原来源交接流程不变。

输入为当前 Layer 可见性、source/composite 身份、作者 mask 内容、真实 resident binding 与既有呈现状态。输出只改变 renderer overlay 可见生命周期；不新增颜色、矩阵或时间阈值。CPU/Worker/shader 覆盖、depth/surface-lock、1024 live mask、最终项目分辨率、UV/export 算法及像素不变。Layer/Project/Generation/Capture Schema、Command 幂等性、Revision CAS、ownership 和 verified assets 不变，无迁移。回滚恢复本次可见性判断即可，禁止删除用户笔画或已保存资产。

## 验证与未完成项

生产回调回归在旧实现的第一次 `none` 切换失败，修复后通过；覆盖 apply → none/add/subtract → resident 到达 → 呈现屏障 → idle、eye-off、空预览、不同 owner，以及三条缓存/可见性复用入口。ordered-composition、layer-retention、performance-merge、projection-performance-safety 和 Web typecheck 通过。

编译优化：带深度/法线的实时与数组混合材质复用既有 compact 循环，每个通道按层选择固定 live sampler 或数组 slice。保留全部九点 visibility、surface-lock、Top-K、literal overlay、UV 翻转、H(S)V、透明度及显隐公式。预热与正式材质采用相同 GLSL，避免 placeholder slice 与实际 slice 不同造成再次编译。简单 live 颜色/蒙版组合保留原展开路径，GLSL 字节完全不变；GPU 实验显示对它强行启用 compact 会回退。保持硬件 sampler 门禁、三个 program anchor 上限及 compileAsync 完成检查，不跳过质量或降低分辨率。

此修改只重组 GPU 着色器代码，不改 CPU/Worker/bake/export 参考公式及像素契约。纹理数组和实时 CanvasTexture 的上传、引用、flipY、mask 持久化与身份规则不变；现有 compact uniform 更新同时覆盖 live sampler 绑定。无 Schema/资产迁移；回滚本次 ProjectedLayerMaterial 改动即可恢复旧 shader，不删除录制或用户工程。仍可能发生首次编译/驱动阻塞，不保证所有设备达到固定帧时。

浏览器验证：通过 CUA 在 `http://127.0.0.1:5198/gpu-test` 运行真实生产 material 创建、Worker/纹理数组上传、WebGL compileAsync、draw 和 RGBA readback；基线为 05b607bd。隔离合成场景不访问或修改用户项目。7 组：纯数组、live color/mask、live depth/normal、3 层全 live、UV mask、surface-lock、depth + live mask。每组比较原显隐/透明度、关闭末层、重新打开并降低透明度三种状态，96×96 输出逐字节一致；显隐前后必须存在实际变化，防止被深度全部遮挡时误判通过。compact 预热与正式 GLSL 逐字节一致，更新 display state 不重建材质；过量 sampler 仍拒绝。

九层深度混合 GLSL 从约 81–82 KB 降至约 31 KB。编译实测受到驱动缓存及 ANGLE 后端影响，某次冷旧路径约 3.2 秒，新路径首次约 0.5–0.6 秒；热路径和共用 program 可更快。这是隔离测试的观测，不能当作用户 RTX 4070 Ti 项目的最终加速比，也不能混合冷/热缓存计算收益。测试脚本及原始输出留在系统临时目录，不将用户录制或临时测试服务引入生产。

显示交接采用实际生产回调的受控时序重放；不是用户原项目的完整浏览器录制。上线验收应在同一项目重新执行按钮 3 → 涂抹 → 按钮 1 → 按钮 3，确认全程画面不丢、已有笔画可继续编辑/撤销，保存重开仍保留；另录制冷/热两轮最大帧及 LoAF。

Web 88 项回归通过，修改文件 lint 0 errors（Viewport 6 条既有 warnings）。Cloud 构建和原包体门禁均验证；后续合并最新 master 后重跑，结果以最终发布检查为准。发布顺序严格为本地验证 → master CI 全通过 → 合并 release 并 deploy；保留效率组的生产部署配置。

合入 master 2fdd480 后的兼容校验：single-view completion 的旧正则仍匹配重构前内联请求，改为调用实际 submitGptTextureView 并验证两张参考图顺序、capture 身份与 count=1。生产生图逻辑不变。compact eligibility 提取为唯一判断，预热/正式加载共用，削减重复包体；不提高原有 3,134,000 字节上限。

后续合并 30dbad62：保留其单投影恢复 atomic reveal 修复、对应测试及该提交已登记的 3,142,400 字节总包体门禁；本补丁不再更改预算配置。
