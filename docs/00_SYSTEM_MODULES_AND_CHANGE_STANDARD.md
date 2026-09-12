# LI3D Cloud 系统模块、算法与变更管理唯一准则

> 文档版本：`2.20.37`
>
> 生效日期：`2026-09-12`
>
> 代码盘点基线：`9e69980 + 单视图成功结果自动投影恢复`
>
> 基线仓库：`E:\Liclick 3D Texture Modernization`
>
> 审计口径：`0a2519d + 607e82f + 2568e40`，不包含错误文档提交 `2bde8c6/e03bab2/d1c5f78`

## 1. 文档地位与强制边界

2026-09-12 M04：`GPT25-TEXTURE-GENERATION/1.1.0` 将单/多视图和 GPT 局部重绘输出统一为 1:1 方图，分辨率绑定顶部 1K/2K/4K；新增项目级五档质量 low/medium/high/xhigh/max，默认 high，两种 GPT 模型均可切换。透明背景固定，原远端局部重绘不变。协作 M08/M12，详见 [变更卡](changes/CHG-20260912-GPT-OPTIONS.md)。

2026-09-12 M04/M06：`GPT-TRANSPARENT-TEXTURE/1.0.0` 接通 GPT2/Sunburst/Flare 纹理及 GPT 局部任务 background=transparent；通过持久化 extraParams.background 选择源 Alpha 分支，不根据模型名迁移旧任务。新单/多视图保留源 RGBA 和完整画布，跳过重复抠图；capture mask、深度、角度及笔刷约束保留。规范图层恢复尊重显式 ignoreSourceAlpha=false，旧无标记流程不变。协作 M07/M08/M12，详见 [变更卡](changes/CHG-20260912-GPT-TRANSPARENT.md)。

2026-09-12 M04/M08：`GPT25-TEXTURE-GENERATION/1.0.0` 接入莉刻 Sunburst/Flare 并保留两视角并发、分组串行；`GPT-REPAINT-GUIDE/1.0.0` 新增独立 GPT 局部重绘入口，只有无纹理处与笔刷选区使用白模，其余纹理保留。GPT 仅接收组合图和材质参考，原始 UV 选区仍是唯一回贴授权。使用现有单视图提示词、原局部重绘保持不变。`GPT-REPAINT-ALPHA/1.0.0` 按用户确认让新 GPT 局部返图跳过 ALG-LR-013 内缩/强制不透明，前台与恢复原样保留源 RGBA；原远端 ModelView/Klein 保留内缩。协作 M06/M07/M12：回贴显式使用源 alpha，原笔刷/深度约束、合并与导出透传逻辑不变；既有已裁任务不重算。详见 [变更卡](changes/CHG-20260912-GPT25-REPAINT.md)。

2026-09-11 M07：`UV-RASTER-CACHE-IDENTITY/2` 将逐层 GPU 缓存与外层合成签名统一到属性/底层数组身份、交错布局及上传版本，补齐 drawRange；缓存复制/保留以生命周期 revision 防止 context loss 后复活。内置冻结回归复现旧核更换同版本 UV 后 524288 字节错误，新核零差异。像素算法、分辨率、QA、持久格式不变，无资产迁移。收尾验证、未完成性能项与回滚见 [变更卡](changes/CHG-20260911-UV-CACHE-IDENTITY.md)。

2026-09-11 M07/M09：`UV-QUALITY-R8/1` 将偶数尺寸 WebGL2 私有权重目标改为 R8，GPU 累积、读回和设备校验同时支持 R/alpha 两种布局；精度、像素、Top-K、QA、深灰斜线与持久格式不变。4K 逐层缓存名义容量 128→80MiB，固定 256MiB 预算多保留一层；六组冻结对照及连续切换 hash 完全相同，尚无显著端到端加速。详见 [变更卡](changes/CHG-20260911-UV-QUALITY-R8.md)。

2026-09-11 M08：`ALG-LR-UV-PAINT` v1.1.3 将同一笔刷跨多个瓦片的重复模型绘制合成一次；先捕获全部首次触及瓦片的撤销像素，仅在原触及瓦片写回。完整分辨率、可见性/共享 UV/羽化/擦除 shader、保存与导出协议不变。4K 32 万面冻结对照四阶段零差异，合成测试模型绘制 409→17 次，最大帧间隔约 100–184→17ms；不是原工程 FPS 保证。审计、验证、限制和回滚见 [变更卡](changes/CHG-20260911-UV-BRUSH-RASTER-BATCH.md)。

2026-09-11 M07/M08/M11：合并协议 v10 / final-v3 将原生 UV 重绘纳入合并与 Bake 增量，先保留投影底层，再按作者顺序 source-over 重绘；GPU/CPU/Worker 同步 opacity，等待最新笔画与冻结资产。历史资产、深灰斜线、QA 和持久化协议不改。验证与回滚见 [变更卡](changes/CHG-20260911-NATIVE-UV-MERGE.md)。

2026-09-11 M07，协作 M06/M04/M15：`UV-READBACK-WORKER-BOOTSTRAP/1` 将无外部依赖的读回转换 Worker 随页面内联，确认 ready 后才转移像素；启动失败最多重试一次，转换失败不重放已转移数据。请求发送异常清理、会话隔离和 messageerror 处理避免悬挂及旧 Worker 事件破坏新会话。RGBA/coverage/quality、GPU/CPU/shader、深灰斜线、QA、分辨率、导出和持久化契约不变，无 Schema/资产迁移。未取得用户原始 Worker 的底层错误日志，不能将资源 404 断言为唯一根因；故障注入、真实工程与回滚见 [Worker 恢复变更卡](changes/CHG-20260911-UV-READBACK-WORKER-RECOVERY.md)。

2026-09-11 M07，协作 M06/M09：`PERF-UV-SOURCE-PREPARE-001` v1.4.0 对静态、最多两个来源且输出不超过 4K 的投影栈，最多提前准备两层，与当前 GPU 工作重叠；其他栈保持一个槽，live 仍在消费时同步快照。保持原层顺序、完整像素、分辨率、QA、深灰斜线和缓存预算；额外一个解码层的输出上限为 128 MiB，浏览器解码 scratch 属瞬时开销，不宣称内存总峰值不变。持久化/导出及 Schema 不变，无资产迁移。对照、实测、限制与回滚见 [状态同步变更卡](changes/CHG-20260911-UV-STATE-SYNC.md)。

2026-09-11 M07，协作 M06/M09：`UV-OVERLAY-IDENTITY/1` 对底色贡献为零的 overlay 直接保留来源 RGB 字节；`UV-RASTER-SPECIALIZATION/1` 将内部权重光栅的无用 RGB 运算和权重为零的捕获法线比较移除，按 shader defines 保留编译程序。完整颜色/alpha/Top-K、半透明混合、深灰斜线、分辨率、QA 和持久化/导出契约保持；无资产/Schema 迁移。冻结对照与 121 项回归通过，原工程新组合仍约 1.4–2.1 秒，尚未达到即时更新。证据及回滚见 [状态同步变更卡](changes/CHG-20260911-UV-STATE-SYNC.md)。

2026-09-11 M15：`CI-SOURCE-RETRY/1` 将 Runner 拉取源码的尝试上限设为 3。流水线 630025 的 build 在取源码阶段因 DNS 解析失败退出，尚未执行构建/包体检查；本改动仅容忍临时取源码失败，不掩盖持续网络故障，不重复部署脚本、不放宽质量/包体门禁。无运行时算法、Schema 或资产变化；诊断、验证与回滚见 [变更卡](changes/CHG-20260911-CI-SOURCE-RETRY.md)。

2026-09-11 M12，协作 M08/M05：`RUNTIME-LAYER-ASSETS/1.0.0` 将临时图层资产持久化收敛到公共工程保存入口；等待 UV 笔画读回、冻结 PNG，上传成功后才提交 Command/CAS，隐藏层同样保存，不修改活动编辑的 live 绑定。服务端拒绝 UV imageUrl 的 live/blob 地址，不能覆盖已有正式 RGBA，也不能以旧贴图掩盖未保存笔画。原生 UV 重绘预览直接消费 RGBA，不要求旧投影蒙版。GPU/CPU/Worker/shader 绘制与合成、分辨率、导出像素及 Project Schema 不变；历史坏引用不自动覆盖，恢复需核验旧 revision/资产后另行授权。测试、迁移和回滚见 [变更卡](changes/CHG-20260911-UV-REPAINT-PERSISTENCE.md)。本次仅本地修复，未推送或部署。

发布范围：经用户授权同步 master/A100，保留 master 的五项状态同步、接缝索引及采样 Worker 优化；最终合并提交须重新通过正式发布门禁。下方本地修复记录为发布前历史状态，不代表已完成部署；不自动修复或覆盖真实工程。

2026-09-11 M07/M09，协作 M06：`PERF-UV-SOURCE-PREPARE-001` v1.3.0 让无需缩放的静态 PNG 的 CPU 像素消费者复用已验证的软件 Canvas Worker 解码；直接转移完整 RGBA，减少主线程画布读取和等帧。原尺寸/PNG header 门禁、JPEG/缩放/live 兼容路径及 192 MiB 缓存不变。GPU/shader、蒙版/Top-K/深灰斜线、QA、导出和持久化语义不变，无 Schema/资产迁移。4K 冻结解码对照零差异，原工程蒙版准备约 0.8→0.47–0.49 秒；完整组合仍约 3.9 秒。验证与回滚见 [状态同步变更卡](changes/CHG-20260911-UV-STATE-SYNC.md)。

2026-09-11 M07，协作 M06/M09：`UV-SEAM-REPAIR-PLAN/1.3` 对量化位置用数字哈希选桶，再比较完整坐标，避免每个顶点创建位置字符串；碰撞不合并不同位置，保留量化、首次 ID 与 donor 顺序。CPU/Worker/GPU/shader 像素、持久化、导出及深灰斜线不改，无 Schema/资产迁移。冻结核、哈希碰撞/大坐标及真实内置工程验收见 [状态同步变更卡](changes/CHG-20260911-UV-STATE-SYNC.md)；首次接缝约 0.75 秒，整次转换仍未达到即时要求。

2026-09-11 M07/M06/M09：`PROJECTED-MASK-WORKER-BOOTSTRAP/1` 将双线性采样和 alpha 蒙版纯计算独立成模块，Worker 不再导入图像 I/O、项目状态及抠图工具。原入口保留重导出，CPU/Worker 共用相同像素公式；GPU/shader、Top-K、深灰斜线、分辨率、QA、持久化和导出语义不改，无资产/Schema 迁移。Worker 产物约 16.6→2.4 KB；仅声明依赖和包体缩减，不把它当作完整转换加速的证据。验证与回滚见 [状态同步变更卡](changes/CHG-20260911-UV-STATE-SYNC.md)。

2026-09-11 M07，协作 M06/M09：`UV-SEAM-REPAIR-PLAN/1.2` 将相同量化位置映射到稠密整数 ID，以有安全整数上界的配对键代替逐边字符串；超界保留旧字符串路径。共享内边只更新最终记录，保留首 UV 键顺序、最后记录与 donor 顺序。冻结核 RGBA/coverage/count、非流形边、精度边界及真实内置工程验证通过，首次接缝约 1.03→0.88 秒；不是完整转换的即时保证。GPU/CPU/Worker 像素、QA、深灰斜线、分辨率、持久化/导出均不变，无格式迁移；细节见 [状态同步变更卡](changes/CHG-20260911-UV-STATE-SYNC.md)。

2026-09-11 M06/M07/M09：`UV-DISPLAY-DERIVED-CACHE/1.1` 在实际呈现确认后保留当前压缩 UV；F5 恢复的校验结果重新进入有界内存缓存，后台压缩忙时只排队最新一个完整结果，磁盘仍最多两个快照。`UV-TOPOLOGY-LOOKAHEAD/1` 将原几何拓扑准备与来源解码重叠；`UV-POSTPROCESS-CANCEL/1` 在接缝/gutter 让出前后终止过期任务；`UV-SEAM-REPAIR-PLAN/1.1` 对相同索引端点直接确认 UV 相等，其他情况保持原量化及顺序。原像素、Top-K、深灰斜线、分辨率、QA、持久资产/Command/CAS/ownership 和导出不改，无资产或磁盘格式迁移。实际内置浏览器 F5 约 6.19→2.64 秒，新组合仍为秒级，不宣称完成即时更新；审计、容量、验证和回滚见 [状态同步变更卡](changes/CHG-20260911-UV-STATE-SYNC.md)。

2026-09-11 M06/M07/M09：按用户最新授权，将普通常驻 UV 的整工程 CPU 对照移入发布/回归验收；运行时采用 `UV-DEVICE-CALIBRATION/1.0.0`，在当前 WebGL context 上以 256²、6 层输入覆盖质量/alpha 字节、Top-K 和舍入，两个 alpha 模式独立校验，失败阻止发布，context loss 后重新校验。`perfQualityGpuAb=1` 仍执行完整工程对照，稀疏 CPU 舍入修正保留；不是信任跨设备持久批准。`UV-QUALITY-READBACK-PACK/1.0.0` 将校验质量 alpha 原字节四合一传输，不降分辨率；CPU 对照不再启动不会采用的第二遍 WebGPU 求解。`PROJECTED-MASK-FOOTPRINT/1.0.0` 只跳过已证明为零的蒙版双线性范围外像素，原采样舍入/透明 RGB 保留。`UV-DISPLAY-BUFFER/1.1.0` 把可见修补底层用显式合并相同规则纳入最终 RGBA，派生 key purpose 升为 resident-uv-display-2，避免显示阶段的额外 alpha 混合白边；深灰斜线 shader 不改。Worker 空闲让出取消零定时器钳制，真实交互暂停保留。完整 GPU/CPU/Worker/Shader/持久化/导出审计、实测与未完成项见 [变更卡](changes/CHG-20260911-RESIDENT-UV-DISPLAY.md)。

2026-09-11 M09/M07/M06：`ALG-UV-008` v2.0.3 在独立烘焙 renderer 内以最多两条 8 MiB 读回重叠 GPU 等待，可见 renderer 保留串行呈现边界；错误先排空在途读取再释放目标。`UV-TOPOLOGY-SOURCE-CACHE/1.1.0` 按原始 UV/index 字节校验单个有界快照，未变化不重复展开三角形，实际编辑仍使页内和 Worker 缓存同时失效；首次展开按 4ms 预算让出，不逐固定顶点数强制等定时器。CPU/GPU/Worker/shader 像素、Top-K、完整分辨率、QA、导出与持久资产不改，无 Schema 或资产迁移；回滚仅恢复读回/准备调度。实测及仍未达到即时更新的限制见 [常驻 UV 显示变更卡](changes/CHG-20260911-RESIDENT-UV-DISPLAY.md)。

2026-09-11 M07/M06/M09/M11：`UV-PIXEL-SPACE/1.0.0` 对齐 GPU 投影与补边/接缝坐标。UV 映射到完整像素边界范围，不能按 resolution−1 缩小；拓扑 CPU / Worker / WebGPU、CPU 诊断光栅及 PBR 法线烘焙同步，接缝用 floor 定位包含 texel。Merge / bake protocol 9、会话 v13、persistent-4；不降低分辨率、不恢复自动补洞、不重写历史资产，原 QA 保留。实际工程及边界回归、迁移/回滚见 [变更卡](changes/CHG-20260911-RESIDENT-UV-DISPLAY.md)。

2026-09-11 M06/M07/M09：`UV-DISPLAY-DERIVED-CACHE/1` 为常驻 UV 增加浏览器刷新恢复的无损派生缓存。按账号/工程/对象、实际模型与来源字节、参数、分辨率和版本校验，保存 RGBA 与 rendered-color mask；损坏或不匹配重新计算。它不替代 Cloud verified assets 或改变 Command/CAS/ownership，不表示逐层贡献持久化已经完成。显隐验收必须测量点击到模型实际绑定新 UV 的时间，并对照正确合成像素；已有状态命中约 30ms 不能代表新组合即时更新。格式、容量、回滚及未完成项见 [变更卡](changes/CHG-20260911-RESIDENT-UV-DISPLAY.md)。

2026-09-11 M06，协作 M03/M07/M08：`UV-DISPLAY-BUFFER/1.0.0`。投影只作为计算输入，正常视口常驻全分辨率 UV；选择图层和相机交互不重算投影，显隐/内容变化通过现有常驻 Top-K、校正与后处理生成新 UV，上传完成后整体切换。等待时保留上一完整 UV，不叠加新投影作为过渡。派生 UV 和逐层光栅有界缓存，不能为了毫秒指标降低分辨率或跳过 QA。GPU 校正内部标记 `RESIDENT-ROUNDING-RUNS/2` 对完全相同整数候选的相邻 texel 复用精确 CPU 校正；Worker 覆盖混合复用完全相同输入的结果，像素公式不改。普通投影、局部重绘、UV 底层、截图交接、保存/导出及资源失效审计见 [常驻 UV 显示变更卡](changes/CHG-20260911-RESIDENT-UV-DISPLAY.md)。缓存命中与冷计算必须分别测量，不得将常驻 UV 帧率作为所有图层更新已达到毫秒级的证据。

2026-09-11 M05/UI-09，协作 M08：`LAYER-ERASER-MASK-INDICATOR` v1.0.0。图层蒙版图标复用可清除投影橡皮蒙版判定，不再把生成时的 projection capture-mask 或局部重绘 coverage 当成橡皮编辑。笔画撤销/重做恢复已有 eraserAlgorithmVersion，后台精修保留当前历史状态，避免全部撤销后图标重现。GPU/CPU/Worker/shader 像素、投影轮廓、UV/export 与分辨率不变；沿用原 Layer 可选字段、CAS/ownership/verified assets，无 Schema 或存量资产迁移。范围、测试和回滚见 [蒙版图标变更卡](changes/CHG-20260911-ERASER-MASK-INDICATOR.md)。本次仅本地修改，未推送或部署。

2026-09-11 M08：`ALG-LR-UV-PAINT` v1.1.2 / UV_REPAINT_VERSION=4，修复 HiDPI 下局部 UV 笔画分块坐标重复缩放。source/output 两遍 scissor 共用物理 UV 像素适配，保持实际屏幕 DPR、分辨率、可见性和遮挡公式不变。GPU 写入与 CPU 脏瓦片读回、历史和保存一致；Worker/合并/PNG/FBX 消费同一 RGBA，无独立算法改动。旧 v1 图层及已存资产不改写，缺失笔画需重新绘制，无 Schema/CAS/ownership 迁移。DPR 1/1.25/1.5/2 完整像素对照与原模型复测通过，范围、证据和回滚见 [HiDPI 变更卡](changes/CHG-20260911-UV-REPAINT-HIDPI.md)。

### 每次 CI/CD 推送前的强制包体检查

2026-09-11 用户明确要求：每次推送触发 CI/CD 前，必须先处理并通过正式发布包体检查。M15/M13，`RELEASE-PREPUSH/1.0.0`。

1. 先提交准备推送的修改，再运行 `pnpm verify:prepush`。该入口直接读取 `.gitlab-ci.yml` 的 build 变量和命令，带齐 Cloud 模式、性能实验室开关、完整 Git SHA、分支 release ID、版本和构建时间；执行正式构建、云产物检查、全部包体预算及云部署模拟。
2. 普通 `pnpm --filter @liclick/web build` 和没有正式元数据的包体检查不能代替上述流程。失败时必须缩减实际产物并重新检查；禁止为性能补丁提高预算、跳过检查、删除诊断/QA，或降低输出分辨率。
3. 检查通过后才能 `git push`。合入远端、修改代码/依赖/构建配置、变更提交后，必须针对最终提交重新运行。记录最终 SHA、各受限 chunk 和总字节数，并跟踪远端流水线到结果，不能把“已触发”表述为“CI 通过”。
4. 本次失败实例：`6fc08a1` / pipeline `629782` 的 verify 全过、build 阶段包体失败，正式 JS 为 **3,221,231 bytes**，超过 **3,221,000 bytes** 上限 **231 bytes**；普通本地构建为 3,220,729 bytes，少计 502 bytes 发布差异。`3e68405` 同样在 build 阶段失败。以后须读取失败日志确认原因，不能仅凭历史经验认定故障。

此入口不会推送或部署，也不会安装 Git hook；上述规则适用于每次人工或代理推送。构建格式策略 `SHADER-TEMPLATE-FORMAT/1.0.0` 在发布时移除投影着色器模板缩进，保留源文件可读性与计算语义。持续优化必须记录总量和各 chunk 余量，优先去重、不可达代码清理与按需加载；拆包不能冒充总量减少，平均 FPS 不能替代交互延迟验收。验证记录、后续准则及回滚见 [正式发布包体变更卡](changes/CHG-20260911-CI-RELEASE-BUDGET.md)。

2026-09-11 M08/M03：`UV-REPAINT-PREVIEW-BINDING` v1.0.0，修复新旧局部 UV 重绘层不能共存。普通 UV 预览入口同步借用 live registry 的 GPU/Canvas 纹理，禁止将内存 URL 交给静态解码/上传/LRU；最终材质校验保留下方重绘层所在的 UV sampler，不再按“无普通 UV”清零；重绘显隐变化触发 sampler 重新分配。GPU 笔画像素算法仍为 ALG-LR-UV-PAINT v1.1.1 / UV_REPAINT_VERSION=3，CPU/Worker/Shader 混合公式、PNG/合并/FBX、持久 RGBA/Schema/CAS/ownership 不改，无资产迁移。真实 React/WebGL 两层独立显隐、擦除/撤销、三层合成通过；用户原工程及 A100 尚未验收。本次仅本地修复，详见 [变更卡](changes/CHG-20260911-UV-REPAINT-COEXISTENCE.md)。

2026-09-11 M08：`ALG-LR-UV-PAINT` v1.1.1 / UV_REPAINT_VERSION=3，修复局部 UV 重绘细分曲面漏点。可见性由 UV 导数反求深度改为屏幕浮点 face/depth/slope 缓冲及局部连续深度足迹；跨护栏/孔洞深度断层不参与邻域放宽，整数面 ID 使用 flat 插值。小视口的可见性长边至少 1024，输出尺寸不改。保留来源 alpha/作者遮罩、共享 UV 取色与一次擦除、脏瓦片历史及保存/导出 barrier，不恢复自动补洞，不修改单视图。已有 RGBA 不自动补写，旧 v1 图层可读；回滚 984fb1d，无资产/Schema 迁移。显存开销、有限栅格边界及验证见 [白点修复变更卡](changes/CHG-20260911-UV-REPAINT-VISIBILITY.md)。本次为本地修复，未推送或部署。

2026-09-10 M08：`ALG-LR-UV-PAINT` v1.1.0 / UV_REPAINT_VERSION=2，经用户确认，重叠 UV 允许共享颜色和透明度，不再整模型拒绝。不预先压平返图颜色：冻结来源纹理/作者遮罩与相机，在当前可见笔刷命中时逐表面取色；共享 texel 由最强笔刷覆盖获胜，相同权重按固定几何顺序，单次合成避免重叠面重复擦除。缺失/退化/越界 UV 校验、遮挡、源 alpha 与轮廓约束保留。原 RGBA 层协议与 v1 ID 可读，GPU 结果经原脏瓦片读回交给 CPU/Worker/保存/合并/FBX，不自动展开或迁移旧图层。回滚恢复上一发布（共享 UV 新笔画将再次被拒绝，已保存像素仍可读）。详见 [共享 UV 变更卡](changes/CHG-20260910-SHARED-UV-REPAINT.md)。

2026-09-10 发布确认（M07/M08/UI）：用户明确接受去掉 8K 与合并时不自动补洞。贴图工作台输出菜单仅保留 1K/2K/4K，普通投影合成沿用最高 4K/255层门禁和 Merge profile v8；旧 8K 项目类型/资产保留，不静默重采样或重写，需用户手动改选支持的输出。非贴图工作台的远端 UV 处理工具不改。已授权将 UV 重绘与已验证 master 优化一并推送 master、部署 A100，详见 CHG-20260910-UV-REPAINT 发布记录。

`CHG-20260910-UV-REPAINT`：主模块 M08，协作 M03/M05/M07/M11/M12；新增 `ALG-LR-UV-PAINT` v1.0.0。新局部返图冻结来源并准备原分辨率 UV 颜色，当前视口最前可见面决定 UV 笔画覆盖；不锁起笔部件，大笔刷允许同时绘制孔洞里可见后板，不穿透遮挡。新层保存独立 BaseColor RGBA，脏瓦片历史与选区消费共同撤销，PNG/FBX/合并等待读回；原投影重绘兼容保留，单视图及其 UV 预缓存不改，不迁移旧资产。Cloud verified assets / Command / CAS / ownership 保持。110 项回归及真实 Edge WebGL/React 视口夹具通过；复杂用户原工程、8K 内存压力与 A100 验收尚未执行。本次仅本地实现，详见 [变更卡](changes/CHG-20260910-UV-REPAINT.md)。

2026-09-10 M07 / PERF-UV-SOURCE-PREPARE-001 v1.2.0：静态 PNG 源解码/相同软件 Canvas 转换移入 Worker，交付 ImageBitmap，删除完整 CPU RGBA 读回及第二张 Canvas；JPEG 候选对照失败，保留原兼容入口。后台按真实多选/右键意图准备有序 UV 底层，前台加入相同 PNG/GPU 准备任务；最终会话键 v2 包含 live revision。常驻 readback 的 Y 翻转/完整 RGBA/coverage 交 Worker，舍入扫描与私有复制有界让出并避让交互。完整 4K 对照零像素差异，新夹具0 longtask，最大帧间隔33–50ms；不能宣称原工程零卡顿/所有入口毫秒级。GPU/CPU/Worker/shader/persistence/export 审计、公开案例适用边界、测试及回滚见 CHG-20260910-UV-DEFAULT-RESIDENT v1.2.0 记录。持久 RGBA/Project Schema/资产/CAS 不变，release 不动。

2026-09-10 M07 / PERF-UV-SOURCE-PREPARE-001 v1.1.0：GPU 栈以一层 lookahead 重叠源准备与计算，live 源保持消费时同步快照；删除逐纹理固定等帧，保留 4ms 预算、分条上传与交互让出。异常排空在途资源并保护借用 bitmap。真实 WebGL 4K/6层冻结旧核对照 RGBA/coverage/count 零差异，阶段约 1223–1609→851–1044ms；非完整 Merge。GPU/CPU/Worker/shader 像素和 QA、导出、持久化/缓存不变，无数据迁移；回滚只恢复调度。见 CHG-20260910-UV-DEFAULT-RESIDENT 后续记录。

2026-09-10 用户要求先移除自动补洞：M07 / Merge profile v8，关闭 uvCoverageGapPixels 和 uvInteriorHolePixels，旧算法保留但正常合成不调用；接缝 band/gutter 与 QA 保留。新结果保留未覆盖区，会话键 v12、持久派生键 persistent-3，旧补洞缓存不复用；Project Schema/历史资产不变，无 release 变更。详见 CHG-20260910-UV-DEFAULT-RESIDENT 后续记录。

`CHG-20260910-UV-DEFAULT-RESIDENT`：主模块 M07，协作 M06/M09；ALG-UV-003 v2.1.1、准备策略 v2.2.2、ALG-UV-005 v2.0.5。按用户要求普通投影转 UV 入口统一常驻 GPU，旧 CPU 投影/质量路径只在显式 perfLab 对照中可用，不再失败后静默回退；首轮完整 CPU 校验仍保留。补洞仅枚举有相对拓扑邻点的候选，像素顺序/岛屿门禁不变；最终 PNG 在后台提前上传，仅在相同 Blob 正式保存后移动独占缓存所有权。全分辨率、QA、Command/CAS/ownership/verified assets 保留，无 Project Schema 迁移；8K/超 255 层普通质量合成尚不支持新常驻核时明确失败，不降采样、不走旧算法。GPU/CPU/Worker/shader/export 审计及测试见 [变更卡](changes/CHG-20260910-UV-DEFAULT-RESIDENT.md)。

`CHG-20260910-ADAPTIVE-GAP-DISTANCE`：主模块 M07，协作 M05/M06/M08；`LOCAL-BOUNDARY-REPAIR` v1.1.0。生产补缝从按分辨率计算的初始半径开始，沿同 UV 区域内已选缺口自适应扩大直到填满或无可达边界；不跨未选区域找远处颜色、不跨 UV 岛、不恢复全局平均或单色锁定。本次输入的原始边界索引始终固定，不把新补颜色作为新来源重跑。CPU/Worker 共用算法及取消/节流，仍有不可达区域时显示数量提示。GPU/shader/导出公式及 Schema/CAS/ownership 不改，无资产迁移；详见 [变更卡](changes/CHG-20260910-ADAPTIVE-GAP-DISTANCE.md)。

`CHG-20260910-REPAINT-MERGE-ALPHA`：主模块 M07，协作 M05/M06/M08；`ALG-LR-013` 合并一致性 v1.1.0。UV 合并及模型导出预处理透传图层 ignoreSourceAlpha，原模型裁切版本保留源 alpha 与画笔 mask 的乘积，旧全帧重绘仍按 mask 覆盖；压入 alpha 后清除独立 mask，避免重复相乘。复用既有 CPU/Worker 两种模式，无 shader/分辨率/持久化协议改动。合并版本 7、会话缓存 v10；旧合并资产不自动重写，需撤销合并后重合。详见 [变更卡](changes/CHG-20260910-REPAINT-MERGE-ALPHA.md)。

`CHG-20260910-LOCAL-BOUNDARY-REPAIR`：主模块 M07，协作 M05/M06/M08；`LOCAL-BOUNDARY-REPAIR` v1.0.0。补缝生产策略改为同 UV 区域、有限距离、高置信边界多点颜色过渡，不跨岛借色、不锁整块单色、不使用全图平均色兜底；无可靠来源处保留缺口。CPU 与 Worker 共用算法，兼容主线程按需加载；已有图层/历史、GPU 投影、分辨率、导出合成及 Schema/Command/CAS/ownership 不改，无资产迁移。24 项专项测试、109 项回归和真实浏览器 2K Worker/主线程字节一致验证通过；尚未用用户鱼模型原工程验收。详见 [变更卡](changes/CHG-20260910-LOCAL-BOUNDARY-REPAIR.md)。

`CHG-20260910-FBX-TEMPORARY-UV`：主模块 M07，协作 M05/M06；`FBX-TEMP-UV-EXPORT` v1.0.0。场景/对象 FBX 复用颜色导出的 UV 合并计划、局部重绘蒙版、拓扑修补参数和 source-under 合成，生成临时完整 PNG 后直接嵌入，不发布合并图层或烘焙记录、不消费源图层；层/模型/live revision 变化时拒绝混合快照。修复蒙版 Worker 转移共享缓存 buffer 导致重复处理失败，改为任务私有副本并清理 postMessage 失败回调。GPU/CPU 像素算法和质量门禁、1K–8K 分辨率、Schema/Command/CAS/ownership/verified assets 不变；无资产迁移。真实浏览器 2K 未合并/合并后贴图字节差异 0，两个 FBX 均含可解码 PNG；详见 [变更卡](changes/CHG-20260910-FBX-TEMPORARY-UV.md)。
2026-09-10 候选验收：M07 / ALG-UV-003 v2.1.0，普通投影 GPU 常驻 Top-3，稀疏舍入校正，保留实际 CPU 校准门禁、完整 4K、overlay/补缝/持久化。仅 perfResidentQuality=1 启用，完整 Merge 耗时尚待真实工程验收；不代表已达到毫秒级。见 [变更卡](changes/CHG-20260910-UV-RESIDENT-QUALITY.md)。

同卡补充：M07 / ALG-UV-005 v2.0.4 等价移除 gutter pending Map/二次遍历、未使用的 seamLinks 和透明接缝整图复制；按实际几何字节与矩阵有界复用接缝关系。冻结核与拓扑对照通过，隔离 4K gutter 中位约 1296→260ms，接缝关系复用约 7.5ms；不是完整 Merge 时间。GPU/Worker/shader、像素、QA、Schema/CAS/ownership/verified assets 与持久缓存键不变，无数据迁移；回滚仅恢复后处理实现。

同次实测发现并修复 M06 / UV-MERGE-EMPTY-FALLBACK v1.0.0：UV-only 存在 sparse repair 底图且两层完全未覆盖时，普通显示恢复深灰斜线，避免 Merge 后变白模。96 组真实 WebGL 对照保留所有有效 RGBA 与 capture mode=0/2，无额外 pass/采样/读回；UV/export/CPU/Worker/持久像素与缓存键不变，无迁移。见 [变更卡](changes/CHG-20260910-UV-MERGE-EMPTY-FALLBACK.md)。

`CHG-20260910-PROJECTION-EMPTY-DISPLAY`：主模块 M06，协作 M03/M08；`PROJECTION-EMPTY-DISPLAY` v1.0.0。按用户要求恢复有可见投影/UV 时未覆盖区域的深灰斜线预览；单层、stack/array、UV-only 一致。flat 截图按 tile 临时使用模式 0，coverage 截图模式 2，结束或失败恢复视口模式，斜线不进入 GPT 引导图。保留可靠区域裁切和单/多视图投影一致性，不改 CPU/Worker/UV 烘焙公式、分辨率、作者 mask、历史和持久化协议，无迁移；本次仅部署 A100，不推送 master。详见 [变更卡](changes/CHG-20260910-PROJECTION-EMPTY-DISPLAY.md)。

`CHG-20260910-TEXTURE-PROJECTION-PARITY`：主模块 M06，协作 M04/M05/M08；`TEXTURE-PROJECTION-PARITY` v1.0.0。每个 texture-map 单/多视图结果共享原模型 capture-mask、边缘颜色清理、ignoreSourceAlpha、0.18 minimum facing 和 standard visibility；新增图层及显式重新投影使用统一入口判断。组内两张并发/组间串行不改，局部重绘和材质参考生成不纳入。GPU/CPU/Worker/shader/UV/export 复用既有单视图参数契约，无像素公式、分辨率或 Schema 变更；不自动迁移旧多视图、清除橡皮或重写历史资产。108 项回归与真实 WebGL 同相机/同返图六组逐像素一致检查通过。详见 [变更卡](changes/CHG-20260910-TEXTURE-PROJECTION-PARITY.md)。

`CHG-20260910-PROJECTION-RELIABLE-FOOTPRINT`：主模块 M06，协作 M03/M04/M07/M08/M09；`PROJECTION-RELIABLE-FOOTPRINT` v1.0.0。普通投影对原 angle/visibility/facing/image-edge 几何支撑乘积应用 0.98 硬边准入，准入后仍保留作者 opacity/source alpha/mask；surface-locked 重绘不变。单层/直接多层/compact array、GPU UV/CPU loose fallback/预览合成共用阈值。默认未覆盖显示白模；新 flat-target-coverage 捕获用 PNG alpha 传递实际合成覆盖，Worker 按 alpha 补白模，不再通过斜线 RGB 猜缺口。UV-only、底图、上下 UV 与 overlay 顺序纳入覆盖，内孔和原深度/背面/相机/2048保持。UV bake cache v8、UV merge v6、content-aware projection cache v2 不复用旧几何羽化结果；无 Layer/Project Schema/Command/CAS/ownership 改动，不批量重写历史资产。详见 [变更卡](changes/CHG-20260910-PROJECTION-RELIABLE-FOOTPRINT.md)。

`CHG-20260910-GPT-GUIDE-CAPTURE-ISOLATION`：主模块 M03，协作 M04/M06/M08；新增 `CAPTURE-MATERIAL-ISOLATION` v1.0.0。GPT 成对生成先冻结已有纹理截图，再捕获带明暗的 clay/原模型 mask/depth；避免临时白模异步恢复前被无光照截图转为纯白剪影。flat 捕获逐 tile 同步借用/恢复材质与 uniforms，不跨帧占用；源材质中途替换则拒绝混合截图。GPT 输入仍为模型引导图和原材质参考图，完整 2048、原相机/蒙版/Worker 补全和投影裁切不变。GPU 仅捕获生命周期调整，CPU/Worker/shader 公式、UV/export、Schema/Command/CAS/ownership/verified assets 不改，无数据迁移。详见 [变更卡](changes/CHG-20260910-GPT-GUIDE-CAPTURE-ISOLATION.md)。

`CHG-20260910-GPT-MULTIVIEW-PAIRS`：主模块 M04，协作 M03/M05/M06/M12/M15；`GPT-MULTIVIEW-PAIR-SEQUENCE` v1.0.0。GPT 多视图按预设固定相对视角两张一组，组内请求/等待并行，返图按组内固定顺序提交，组间串行。每组仅捕获本组白模，结合此时实际已有纹理生成引导图，保留原 capture 相机/depth/完整模型 mask；发布本组预览后验证实际材质 bindings 和两帧呈现，再开始下一组。新加角度独立生成，继承预设视角仍配对，顶底最后，不重排缩略图、不新增提供方标识。部分失败保留成功结果并停止后续组，取消沿用同一 batchId；最后仅补缝一次。单视图与隐藏远端兼容路径保持。GPU/CPU/Worker/shader/UV/export 像素、分辨率、Project Command/CAS/ownership/verified assets 不改，无 Schema/资产迁移；详见 [变更卡](changes/CHG-20260910-GPT-MULTIVIEW-PAIRS.md)。

2026-09-10 `CHG-20260910-GENERATION-CAMERA-FRAMING`：主模块 M03，协作 M04/M08；新增 `ALG-CAP-007` v1.0.0。单视图与局部重绘生成前复用现有单视图全对象包围盒和 0.88 留边取景，屏幕相机以 240ms 缓动适配；保持选定方向及透视 FOV，正交调整 zoom。仅一次取景计算，动画无图像读回/渲染调用，用户移动相机或取消则中止提交。局部重绘必须按冻结新相机重新捕获作者 UV 蒙版，不回退旧截图。GPU/CPU/Worker/shader、投影/UV/export 仍使用同一序列化相机与原公式，分辨率、QA、Schema、Command/CAS/ownership/资产不变，无数据迁移。详见对应变更卡。

`CHG-20260909-SINGLE-PROJECTION-RESTORE-REVEAL`：M06/M03，协作 M08；PROJECTED-MATERIAL-IDENTITY v1.0.0。A100 实际工程恢复已完成 full 模型/2048 UV/单投影编译，原显示门禁只识别 Stack 名称，遗漏单层工厂返回的 LiclickProjectedLayer，导致无限旋转。统一常驻材质身份，覆盖初次显示、结构复用、UV bootstrap 和临时保留；不接受 Warmup/白模/不完整投影。GPU 仅显示与驻留生命周期变化，shader/CPU/Worker/蒙版/UV/export/分辨率及持久化契约不改，无迁移。详见 [变更卡](changes/CHG-20260909-SINGLE-PROJECTION-RESTORE-REVEAL.md)。

`CHG-20260909-REPAINT-LAYER-SELECTION`：M08/M06，协作 M05/M12；REPAINT-LAYER-SELECTION v1.0.0。普通图层选择不恢复重绘编辑源、不重启 overlay 交接，停用的 progressive compositor 不再因选中 ID 生成新材质依赖。显式橡皮擦目标准备、实际图层显隐/编辑/删除与生图预热保持；迟到蒙版编码重新校验工具。GPU 仅生命周期调度变化，shader/CPU/Worker/蒙版/UV/export、分辨率、Schema/Command/CAS/ownership/verified assets 不变，无迁移。回滚恢复原触发条件即可，详见 [变更卡](changes/CHG-20260909-REPAINT-LAYER-SELECTION.md)。

`CHG-20260909-UV-MERGE-REPAINT-CONSUMPTION`：主模块 M05/M07，协作 M06/M08/M12；`UV-MERGE-SOURCE-CONSUMPTION` v1.0.0、`UV-MERGE-EMPTY-PREVIEW` v1.0.0。合并完成并发布已验证资产后，原子删除本次参与合并的原图层，保留/选中新合并 UV，清理已无其他结果引用的内部重绘目标和被消费的活动重绘会话；不删除历史资产，原快照可撤销。单层/整栈 shader 的未覆盖区域诊断同时考虑仍显示的 UV 底图，不因重绘 live overlay 暂停普通投影绑定而切为白模。像素合成/覆盖、CPU/Worker/UV/export 不变，仅预览空白诊断变化；无 Schema/旧工程自动迁移，Command/CAS/ownership/verified assets 不变。详见 [变更卡](changes/CHG-20260909-UV-MERGE-REPAINT-CONSUMPTION.md)。

同卡补充 `UV-MERGE-RASTER-PARITY` v1.0.0：清晰录像及真实 WebGL 复现 MSAA 下 UV-only 隐式逐采样深度与 live 回贴显式逐片元深度不一致。UV-only 改为显式写几何深度，保留深度测试，不加前向偏移、不禁用抗锯齿。三个斜面内区错误像素 37488 / 36212 / 29764 → 0，前景遮挡穿透 0；不改 CPU/Worker/UV 烘焙/导出和持久化，回滚恢复隐式深度。102 项完整回归通过，详见同卡验证脚本。

`CHG-20260909-SINGLE-VIEW-PROJECTION-LATENCY`：主模块 M04，协作 M05/M06/M12；`SINGLE-VIEW-AUTO-PROJECTION` v1.1.0。单视图不再开启多视图整批预览冻结，图片资产持久化后发布图层即可开始准备视口材质，不等待工程 CAS 保存；多视图冻结及保存验证保持。成功记录变化和任务解锁立即唤醒恢复检查，5 秒定时器仅用于失败重试兜底，in-flight 去重/项目隔离/取消/已删除不复活保持。GPU/CPU/Worker/shader、蒙版/像素/UV/export、分辨率与 Schema 不变，无数据迁移。回滚恢复无条件批冻结并移除事件唤醒；详见 [变更卡](changes/CHG-20260909-SINGLE-VIEW-PROJECTION-LATENCY.md)。

`CHG-20260909-SINGLE-VIEW-AUTO-PROJECTION`：主模块 M04，协作 M05/M06/M12；`SINGLE-VIEW-AUTO-PROJECTION` v1.0.0。单视图成功结果统一使用既有串行投影事务；补齐刷新/重新进入后的后台成功结果回贴，每 5 秒及回到窗口/恢复网络时检查未提交记录，只重试图片/资产，不重新生图。与活动生成互斥，按原 capture 相机回贴，提交回执与图层同次保存；已提交后删除不复活，重复返回不覆盖既有橡皮和可见性。持久化保留 Project Command 幂等、Revision CAS、ownership 和 verified assets；GPU/CPU/Worker/shader、像素/深度/蒙版/UV/export、分辨率不改。复用原 metadata 字段，无 Schema/资产迁移。详见 [变更卡](changes/CHG-20260909-SINGLE-VIEW-AUTO-PROJECTION.md)。

2026-09-09 UI-05 / M05 图层行文案样式：移除行 hover 背景高亮，保留 selected 背景及 active 底线；按钮自身交互、拖拽、待显示诊断和图层逻辑不变。仅样式，无算法/Schema/迁移；回滚恢复行 hover 类即可。

2026-09-09 UI-02 / M01 文件夹文案：创建文件夹输入框的 folderPlaceholder 从“客户概念”改为“文件夹1”（英文对应 Folder 1）。仅替换占位提示，创建/重命名校验和现有文件夹名称不变；无算法、Schema 或资产迁移。回滚恢复该翻译键即可。

`CHG-20260909-GENERATION-LAYER-DELETION`：M05/M04，协作 M08/M12；`GENERATION-LAYER-DELETION` v1.0.0。生图等待阶段独立放开单/多选图层删除和确认清空，输入快照、局部输入准备/启动交接、内容识别填补仍锁定；其他模型/图层修改锁不放开。仅行选择、菜单入口、删除按钮通过全局事件门禁，Delete/Backspace 仅在图层区域获得焦点时放行。保留现有历史、局部重绘双层及 live session 清理；关键保存每次 CAS 尝试从当前图层 store 获取列表，避免生图旧快照恢复删除。GPU/CPU/Worker/shader/UV/export 不改，无 Schema/资产迁移；回滚恢复独立锁与旧保存读取方式。见 [变更卡](changes/CHG-20260909-GENERATION-LAYER-DELETION.md)。

`CHG-20260909-TEXTURE-GPT-ONLY`：主模块 M04 / UI-05，入口策略 `TEXTURE-GENERATION-PROVIDER` v1.0.1。单视图和多视图共同固定 GPT-only 会话值，不提供 setter，也不读取历史 provider；移除 GPT2/远端整行选择 UI。GPT 提示词、参考图、视角排序、取消与回贴不变；局部重绘、历史远端结果和后端接口保持。GPU/CPU/Worker/shader/UV/export 与 Schema/CAS/资产无变化，无迁移。回退恢复 provider setter 和选项行即可；详见 [变更卡](changes/CHG-20260909-TEXTURE-GPT-ONLY.md)。

`CHG-20260909-MODELVIEW-CONNECTION-LIFECYCLE`：主模块 M04，协作 M08/M15；请求生命周期契约 `MODELVIEW-CONNECTION-LIFECYCLE` v1.0.1。共享 ModelView 请求仅对新连接启动 10 秒建连计时，keep-alive 复用连接不再等待不会重发的 connect/secureConnect；HTTPS 新连接仍等待 TLS 握手。总任务超时、取消、证书验证、幂等性、输入输出与持久化不变，结束时清理监听。无 Schema/资产迁移，回退仅还原请求函数。见 [变更卡](changes/CHG-20260909-MODELVIEW-CONNECTION-LIFECYCLE.md)。

CHG-20260909-MASK-TEXTURE-PREPARATION：M06/M09，ALG-PROJ-007 v2.1.9。颜色蒙版与 UV 准备按实际色彩空间复用，去除同一未变蒙版的重复 GPU 上传。首次/内容 revision/角色转换仍上传；WebGL 4K 输入重复 20 次额外上传 20→0，对照输出零差异。像素、shader、分辨率、QA、持久化/导出不变，无迁移。见 [变更卡](changes/CHG-20260909-MASK-TEXTURE-PREPARATION.md)。

CHG-20260909-PERFORMANCE-LAB-STRESS：M13/M15，ALG-PERF-SESSION-001 v1.0.4 / collector 2.2.1。精确统计复用排序，停止录制 drain 滚轮尾批；S2/S3/S5 解除普通 UV 覆盖，S7 预热后才获取交互测量锁。新增长期录制、输入洪峰、资源清理与保留上限回归。Schema 2、生产像素/4K/QA/持久化契约不变，无迁移。详见 [变更卡](changes/CHG-20260909-PERFORMANCE-LAB-STRESS.md)。

`CHG-20260909-UV-COMPOSITE-RESOURCES`：M07，ALG-UV-003 v2.0.1 / ALG-UV-005 v2.0.3。质量 Worker 按任务复用精确 tile 缓冲，接缝提前去重等价记录，实际合成阶段诊断独立于 S4；PERF-UV-SOURCE-PREPARE-001 v1.0.1 静态Canvas分条读取，live同步快照保持。RGBA、shader、校验门禁和分辨率不变；无 Schema/资产迁移。见 [变更卡](changes/CHG-20260909-UV-COMPOSITE-RESOURCES.md)。

CI 修复（2026-09-09，M15）：GitLab #628349 / job #3561523 的 `test:repaint-selection-consumption` 因 Vite/chokidar 文件监听报 EMFILE。最新 #628365 虽通过，同一脚本仍开启监听；本次为一次性 SSR 回归设置 `server.watch=null`，并断言加载后 watcher 列表为空，避免依赖共享 runner 的剩余句柄。全部选区、撤销与资源释放断言保留；不修改运行时/算法/Schema、CI 门禁或输出质量，无迁移。回退只恢复测试监听配置和移除资源断言，将重新暴露句柄风险。

变更卡 `CHG-20260909-REPAINT-DEFAULT-SEAM`：主模块 M08/M04，`ALG-GEN-005` 请求策略 `qwen-to-klein-default-seam-v9`。局部输入框保留空草稿，不显示/回填默认内容；发起任务时 trim，空白统一按“修补接缝”发送 Qwen，非空仅采用用户要求。服务端对旧客户端空请求同样兜底；移除空输入 diagnosis/JSON 分支与旧诊断构造器，直接走现有四图英文提示词转换，非空删除/无文字等约束不变。缓存指纹升级并区分 default-seam/user-request，旧自动诊断缓存不能命中；历史记录不改写。取消、请求快照及生图期间草稿编辑保持。GPU/CPU/Worker/shader、蒙版/投影/UV/export、输出分辨率、Schema/CAS/ownership/verified assets 不变，无迁移；回退恢复旧策略和诊断分支即可。测试覆盖空串/空格换行/全角空格、用户覆盖、单次 Qwen 请求、无诊断 JSON、四图顺序、空响应/截断/过滤/HTTP 错误和缓存版本。

变更卡 `CHG-20260909-REPAINT-SELECTION-CONSUMPTION`：主模块 M08，协作 M06/M12，新增 `ALG-LR-014` v1.0.0。仅左键应用重绘记录本笔实际裁过 falloff 的脏区，pointer-up 复用正式 literal repaint 材质的 source alpha、冻结相机 depth/surface-lock、朝向和 inward-crossfade alpha，将覆盖投到工作选区 UV；普通选区乘以 (1-coverage)，反选选区更新其补集，正反面 R/G 独立，镂空/遮挡/原模型裁边/未涂区域不清除。绝不修改生成时冻结的 allowedMask，也不清空历史贴图。右键/橡皮擦不补回选区；一笔重绘与对应选区差异共用原 runtime undo/redo。GPU pass 在原 overlay 准备阶段预编译；绘制中只追加本笔脏区，不编码 PNG；松手时 GPU 更新及原始字节读回，历史仅保存变化行区间（不保存两张整图），下一次生成仍走原 canonical UV mask 捕获。工作蒙版仍是会话态，不新增持久化字段；作者蒙版、Layer 保存/UV合成/CPU/Worker/export 使用原路径，Project Command 幂等性/Revision CAS/ownership/verified assets 和输出分辨率不变，无数据迁移。异常恢复消费前选区，空覆盖不消费。回退移除本模块及调用即可；旧工程无重算要求。测试包含稀疏历史/空操作/两面分离/资源释放及 2048² 真 WebGL 内孔、遮挡、上下坐标、反选、精确撤销重做；用户复杂模型的实际交互仍需 A100 验收。 发布包体：候选全参数构建 3,144,697 bytes，对比上一功能基线 3,139,864，新增 GPU/差异历史约 4.9 KiB；总 JS 门禁按本次功能增量调整到 3,147,500，shell/editor/bake/shared 各热路径硬门禁不变，未删除 QA 或降低输出分辨率。93 项完整 Web 回归通过，lint 无错误（15 项既有警告）。
`CHG-20260909-UV-SOURCE-PRESENTATION`：M07，PERF-UV-SOURCE-PREPARE-001 v1.0.0 / ALG-UV-005 v2.0.2。静态图片等待 decode 与绘制，原 Canvas 转纹理前后让帧，透明清理按约 8ms CPU 预算等待绘制；保留 live 快照、fallback、缓存、完整尺寸与全部 RGBA/coverage 公式。真实原工程首轮面板最大帧 83.4→33.5ms，仍有 61.2ms LoAF，不宣称零卡顿或速度已达标。无 shader、Worker、Schema、Command/CAS 或资产语义改变，无迁移。见 [变更卡](changes/CHG-20260909-UV-SOURCE-PRESENTATION.md)。

`CHG-20260909-UV-GUTTER-COOPERATIVE`：UI-09/M07，ALG-UV-005 v2.0.1（调度/实现 Patch，像素语义保持）。接缝、拓扑、补洞、gutter 在约 8ms CPU 后让出绘制；单次顶点复用与邻点索引读取减少重复开销。冻结旧核 1140 组及浏览器拓扑 80 组对照通过，原工程分段核同输入逐字节零差异。S4 最大帧 1701.3→83.4ms、掉帧 19%→3%，但 bake 阶段 23.2→25.5s，缩短总耗时尚未达标；不同轮次视口/缓存有差异，不宣称严格收益比例。Schema、UV merge version、Command/CAS/ownership/verified assets 不变，无迁移。回退恢复同步入口、旧扫描和接缝构建。详见 [变更卡](changes/CHG-20260909-UV-GUTTER-COOPERATIVE.md)。

CI 检查修正（2026-09-09，M15）：`test-generation-draft-preview.mjs` 正则的两个字面空格改用 ` {2}`，保持匹配范围和断言不变，消除 ESLint `no-regex-spaces` 错误。仅测试脚本变化，业务/GPU/CPU/Worker/Schema/资产及运行时版本不变，无迁移；回退此行会重新引入 lint 失败。

变更卡 `CHG-20260909-GENERATION-DRAFT-PREVIEW`：M04/M08，UI-05，GENERATION-INTERACTION-LOCK v1.0.1。生图期间提示词 textarea 使用只读预览白名单通行（草稿编辑例外），不再 readonly/被强制 blur；输入修改下一次任务草稿，现有请求继续使用发起函数冻结的提示词。参考图在任务/准备锁内点击任意缩略图仅打开预览，缩放与关闭可用；不改变选中项，不开放上传、删除、复制或重复生成。任务取消、模型编辑及其他配置锁保持；GPU/CPU/Worker/shader、图像算法、Schema/CAS/ownership/资产无变化，无迁移。回退恢复 textarea 锁与参考图 disabled 即可，不回写已发出任务。

`CHG-20260909-PROJECTION-PENDING-DISPLAY`：M05/M06，ALG-PROJ-007 v2.1.8。关闭不等价分批显示，设备预算内底层显示，超限行运行期标记，常驻原风格合并引导；合并包含待显示行。M09 会话缓存 v9 在临时蒙版编码之前以作者输入和 live revision 查询。89 项 Web 回归、类型和构建通过，实际复杂工程效果及帧率仍需验收。详见 [变更卡](changes/CHG-20260909-PROJECTION-PENDING-DISPLAY.md)。以下 v2.1.7 分批准入已被本条替代。

`CHG-20260909-PROJECTED-UNIFORM-BUDGET`：M06 / ALG-PROJ-007 v2.1.7，按设备参数上限阻止超限整栈材质与预热，进入已有分批预览并提示合并 UV。详见 [变更卡](changes/CHG-20260909-PROJECTED-UNIFORM-BUDGET.md)。

`CHG-20260909-PROJECTED-COMPILE-LIFETIME`：M06 / ALG-PROJ-007 v2.1.6，编译期间保留生成材质至所有轮询完成，再释放资源；不改变像素和图层语义。详见 [变更卡](changes/CHG-20260909-PROJECTED-COMPILE-LIFETIME.md)。

`CHG-20260909-UV-READBACK-DIRECT`：主模块 M09，ALG-UV-008 v2.0.1。GPU 条带异步读回直接写最终 Uint8Array 的 subarray，移除临时 RGBA 条带和主线程 pixels.set。8 MiB 条带、逐条等待、让出浏览器绘制及 Worker 转换不变。真实 4K GPU 对照 67,108,864 字节零差异，省掉每次读回 64 MiB 临时分配/复制；不据此宣称总耗时提升。见 [变更卡](changes/CHG-20260909-UV-READBACK-DIRECT.md)。
变更卡 `CHG-20260909-REPAINT-TOOL-PANEL`：主模块 M08，UI-05/UI-10，交互契约 LOCAL-REPAINT-PANEL-NAVIGATION v1.0.0。底部蒙版、局部生图、应用重绘三个按钮的 click 请求展开生成面板并选择 repaint 页签及预览；重复点击已激活工具同样导航。导航使用独立递增 key，与生图请求 key 分离，不因打开界面提交任务、重新生成或重置提示词/参考图。手动切回单/多视图不受旧 key 干扰；原任务锁、点击行为和回贴逻辑保持。GPU/CPU/Worker/shader/投影/UV/export/持久化与 Schema 均无变化，无迁移；回退移除导航 callback、key 与 effect 即可。

变更卡 `CHG-20260909-MASK-BRUSH-DEFAULT-45`：主模块 M08，UI-10，参数契约 MASK-BRUSH-DEFAULT v1.0.1。蒙版画笔默认大小由 10 调为 45；回贴画笔拆分独立默认常量保持 10，普通画笔 32、橡皮擦 42 与羽化均不变。参数不是持久化字段，新页面初始化生效，会话内手动调整不被覆盖。GPU/CPU/Worker/shader、作者 mask 算法、投影/UV/export、Schema/Command/CAS/ownership 与资产不变，无迁移；回退默认常量即可。

本次裁切按需加载；图像 I/O 原模块独立为缓存 chunk，避免懒加载裁切反向依赖整个 EditorPage。仅调整构建分块，原包体门禁与图像处理行为保持，不修改提示词准备逻辑。

变更卡 `CHG-20260909-UV-STACK-REMERGE`：主模块 M09，协作 M05/M06；`ALG-UV-006` v2.1.0，UV_MERGE_COMPOSITION_VERSION=5。再次合并时接收所选 merged-uv 作为底图；多 UV Worker 合成已预翻转，DataTexture 条带上传必须保留工厂 flipY=false，不能根据 image 非 ImageBitmap 再置 true。真实 Worker/WebGL 1024² 输入与单图参考比较：旧分支 12,288 字节不同，新分支 0；验证 UV1 入选及透明区域保留底色。无旧资产自动重写；先前遗漏 UV1 的 UV2 需从原图层重新合成。GPU/CPU/Worker source-over 公式、shader、分辨率、QA、Command/CAS/ownership 不变。详见 [变更卡](changes/CHG-20260909-UV-STACK-REMERGE.md)。

变更卡 `CHG-20260909-FILE-RESPONSE-CLOSED-DESTINATION`：主模块 M14；`FILE-RESPONSE-LIFETIME` v1.0.1。4517 日志证实文件响应向已关闭目标 pipeline 抛出同步异常，顶层 catch 再次写 JSON 引发 ERR_HTTP_HEADERS_SENT 并使进程退出。文件流启动前检查响应关闭状态，同步失败销毁源流；顶层错误响应仅在尚未发送头时写 JSON，已发送头则关闭连接，已结束则返回。真实 HTTP 回归覆盖提前关闭、已结束、部分响应失败、正常 500、取消下载与完整字节，并确认后续请求继续成功。认证、路径、ownership、Command/CAS、资产与 GPU/CPU/Worker/shader/export 均不变；无数据迁移。回退还原三个服务端文件会重新引入该崩溃风险。此修复不代表已解决多图层渲染；详见 [变更卡](changes/CHG-20260909-FILE-RESPONSE-CLOSED-DESTINATION.md)。
变更卡 `CHG-20260909-REPAINT-MODEL-SILHOUETTE`：UI-05/UI-06/UI-10 → M08，协作 M03/M06/M07/M12，新增 `ALG-LR-013`（Model silhouette inset clip / 原模型轮廓内缩裁切）v1.0.0。维护者明确批准：使用生成时冻结相机及对象的原模型实体轮廓，而非返图颜色识别或作者蒙版，外轮廓内缩且内部孔洞同时扩大 2px@2048。专用深度捕获显式提升到真实 2048，其他调用仍默认 1024；新返图在发布前使用深度 RGB 非全 >=254 的实体 coverage 做欧氏圆盘腐蚀，半径 round(2×最长边/2048)、最少 1px。RGB、完整画布、位置及相机不变，只按裁后 coverage 写 alpha；不重采样、不按主体包围盒裁图、不校色。窄于腐蚀直径的部件可能消失，由本次 A100 美术验收决定后续阈值，不静默扩大覆盖。

Generation.resultUrl 保存裁后同尺寸 PNG，metadata.modelSilhouetteClipVersion=1，rawResultUrl 保留原始远端资产。预览继续从结果派生；新投影 source 显式 ignoreSourceAlpha=false，exact overlay、常驻层、冷恢复/橡皮及 GPU UV/CPU raster/Worker/export 复用已有 source alpha 规则，不改 shader 公式。作者 mask、外扩提交 mask、深度表面锁定仍独立，最终覆盖是原作者覆盖与裁后 source alpha 的交集。缺少/空深度、尺寸不符或解码失败停止本次应用，不以颜色扣图回退；远端原始资产仍由生成服务保留。只对部署后新生成任务生效，既有图层/Generation 不重算、不批量迁移；原 Project Command、Revision CAS、ownership 和 verified assets 不变，新增 metadata 不升级 Schema。回退恢复前一构建；已裁结果和显式 false 的合法 Layer 继续可读，原图仍可恢复。跨文件仅为捕获、编排、source 类型、四个投影/持久入口与测试同步，未重构其他模块。实施 Codex，效果验收维护者；自动回归和浏览器验证结果以最终记录为准。

验证记录（2026-09-09）：Web 全量 89 项回归通过，类型检查通过，变更文件 lint 无错误。Edge 浏览器执行实际 helper 完成 2048×2048 PNG 解码→内缩→编码→重新解码，外边界退 2px、封闭孔洞扩 2px、内部 RGB 和画布尺寸保持；缺少遮罩及取消均拒绝。该机完整处理约 375ms（一次性返图处理，非每帧）。真实远端生成及美术效果留待 A100 用户验收，未声称完成实际项目端到端生图。

变更卡 `CHG-20260908-REPAINT-WORKFLOW-GUIDE`：UI-06/UI-10 → M08，前端交互契约 `UI-LOCAL-REPAINT-GUIDE` v1.0.1。旧生图成功 effect 在 GPU 画笔未 ready 时就消耗 success key，同时侧栏发起生成不清除工具栏生图按钮的引导。改为唯一互斥步骤状态：任一入口开始生成均清除旧引导，成功立即登记待应用引导，跨任务解锁/GPU 准备保留，画笔真正可用后显示呼吸效果；点击/进入应用画笔后停止。失败/取消不引导旧结果，恢复蒙版工具不覆盖待应用引导，新一轮显式操作仍可重新引导。不自动切工具或提交任务；生成、GPU/CPU/Worker/shader、mask/回贴/UV/export、Schema、Revision、ownership 和资产不变，无迁移。回退恢复 BottomToolDock 的原三组 effect 并移除 UI helper 即可，不改用户数据。

步骤引导验证：真实 Edge 挂载 BottomToolDock，执行蒙版点击→侧栏任务开始→成功但画笔未 ready→延迟 ready→点击画笔；基线 HEAD 组件仍为生图 pulse=true/画笔=false，修复后未 ready 两者=false、ready 后生图=false/画笔=true、点击后停止，浏览器 pageerror=0。时序回归另覆盖成功先于解锁、蒙版恢复、失败/取消、第二轮和已确认引导不复活；88 项 Web 回归、TypeScript/Vite 构建及修改文件 lint 通过，包体 3,133,466 bytes 通过原预算。测试不运行生图服务或修改用户工程；本次尚未提交/部署。

变更卡 `CHG-20260908-REPAINT-RASTER-OCCLUSION`：UI-06/UI-10 → M06，`ALG-PROJ-006` v2.1.0。真实 WebGL 隔离复现证实，局部重绘 accepted fragment 的 -0.000080 深度前推与常驻投影的 -0.000006 不一致，会让内部表面盖过当前相机下的外壳。单独清零 overlay 又会被仍前推的常驻层挡住。单层、direct stack、texture-array stack 和实时 overlay 现在共用当前相机深度 helper：有材质片元保持几何深度，仅空诊断片元保留原 +0.000006 后移；overlay 关闭额外 polygonOffset，沿用 LessEqualDepth、末尾绘制及不写深度。捕获可见性阈值、mask/source-over、UV/CPU/Worker/export、Schema/Revision/ownership/资产不变，无迁移。隔离 3,240 状态旧规则失败 1,362、新规则 0（含不同细分的重合诊断面、显隐及 mask 更新）；不据此宣称用户原项目或所有 GPU 已验收。详见 [变更卡](changes/CHG-20260908-REPAINT-RASTER-OCCLUSION.md)。

变更卡 `CHG-20260908-LOCAL-REPAINT-DIRECT-ERASER`：UI-06/UI-10，主模块 M08，协作 M05/M06；`ALG-LR-007` v2.2.2。新生成的局部重绘已经持有实时 composite、GPU overlay/常驻蒙版和新发布的重绘行，但生成链路中的运行时 source 尚未携带冷恢复使用的 `projectionLayerId`。直接切换橡皮擦时，持久行预热过去会把同一来源误判为冷恢复并重新发布，source key 改变后首个 pointer-down 被精确驻留门禁拒绝。现在仅当 source 的 generation/capture/target 校验通过，且实时 composite 的 `layerId` 与 `sourceKey` 同时证明其拥有当前行时保留热源；重载、无 composite 或切换历史重绘行仍发布带精确 `projectionLayerId` 的恢复源。GPU/CPU/Worker/shader、作者蒙版像素、投影/UV/export、分辨率、Project/Layer/Generation/Capture Schema、Command/Revision、ownership 与资产不变，无迁移；回退热源所有权判断会重新引入首次擦除需切换工具的问题。

变更卡 `CHG-20260908-SINGLE-PROJECTION-RESTORE-REVEAL`：UI-04/UI-06，主模块 M03，协作 M05/M06/M12/M15；`PROJECT-TEXTURED-ATOMIC-REVEAL` v1.0.1。刷新或重新进入只有一个可见投影贴图的项目时，完整模型可能复用同一 Group 上已驻留且结构键一致的投影材质；旧快速路径直接返回，没有把该 Group 发布给模型级原子显示门禁，导致贴图实际已就绪但模型仍被加载动画隐藏，直到用户切换图层眼睛触发后续材质流程。现在驻留材质快速返回前同步发布当前 Group，保持零重复 4K 上传，同时结束对应模型加载态。Cloud Web 总 JavaScript 实测 3,134,406 bytes，总量门禁按约 8 KiB 余量重定标为 3,142,400 bytes，应用壳、编辑器、烘焙与共享 3D 管线独立硬门禁不变。多层/UV/白模恢复、图层显隐、投影公式、GPU 纹理内容、CPU/Worker/shader、UV/export、分辨率、Project/Layer Schema、Command/Revision、ownership 与资产不变，无迁移；回退移除该发布调用会重新引入单投影恢复假死，不删除历史结果。

变更卡 `CHG-20260908-AUTO-UV-IMPORT-TRIANGLE-LIMIT-70K`：UI-14，主模块 M10。UV 导入模型的前置三角面保护由 20,000 放宽至 70,000，错误提示同步按真实阈值显示“7 万面”；贴图工作区 200 万面限制及本地 UV 内核 200 万面安全上限保持不变。加载、解析、UV 算法、导出、Schema、Revision、ownership 与资产不变，无迁移。

变更卡 `CHG-20260908-PAIRED-MULTIVIEW-TAB-PRESERVATION`：UI-05，主模块 M04。单视图纹理生成在后台补全并保存配对多视图参考图时，只更新参考图分组与当前材质参考，不再强制切换生成页签、预览模式或视图模式；用户从单视图发起后始终停留在单视图，显式页签操作保持唯一导航入口。参考图资产、后续生图输入、投影、提示词、Schema、Revision、ownership 与服务端接口不变，无迁移。

变更卡 `CHG-20260908-REMOTE-MULTIVIEW-SEQUENTIAL`：UI-05/UI-06/UI-12，主模块 M04，协作 M03/M05/M06/M09/M12/M15；`ALG-GEN-006` v1.1.0。多视图预览数组成为远端串行执行的唯一顺序，取消当前活动视角二次重排；预设 1、预设 2 和自定义基础预设按维护者指定顺序排列且顶/底最后。用户新增普通视角按邻近方向插到极向分组前，归一化方向 `y>=0.9`/`y<=-0.9` 的顶部/底部视角自动进入 GPT2 分组。普通视角仍走 ModelView，GPT2 视角复用现有单视图请求/轮询/取消，所有视角均在返图投影并正式驻留后才继续；完整覆盖仍跳过，末尾仍只执行一次内容识别填补。批次开始前同时校验两种服务账号。不改分辨率、质量门禁、提示词模板、投影公式、GPU/CPU/Worker/shader、UV/export、Schema、Command/Revision、ownership 和资产，无迁移；回退恢复 v1.0.0 排序与全 ModelView 路由，不删除已生成成果。

变更卡 `CHG-20260908-GPT2-TEXTURE-COMPLETION-PROMPT-V2`：UI-05，主模块 M04；`ALG-GEN-001/002` v1.2.0。GPT2 单视图初始白模、已有贴图补全及多视图继续共用唯一提示词构建器，主模板替换为用户指定的精简版本。Image 1 是画布、相机、几何、轮廓、孔洞、真实部件边界、视图数量和排版的唯一依据；仅白色、浅灰色、Clay、Primer 或未贴图区域可修改。Image 2 只提供其特有的 Base Color、颜色变化、纹理颗粒、尺度、方向、粗糙度和磨损，不提供形状、构图或光照；白模内部低模三角面灰度、Flat Shading 和硬法线明暗不得作为材质。用户补充要求仍追加在主模板末尾。服务端 purpose-built 标记同步更新，避免再次拼入旧通用光照约束。生成输入图、LiClick/Atlas 供应方、任务轮询/取消、投影、GPU/CPU/Worker/shader、分辨率、Project/Layer/Generation/Capture Schema、Command/Revision、ownership 与资产不变，无迁移；回退恢复旧模板和识别标记即可。

变更卡 `CHG-20260908-PROJECTED-ERASER-UI-REBUILD-HANDOFF`：UI-05/UI-06/UI-09/UI-10，主模块 M08，协作 M04/M05/M06/M12；`ALG-ERASE-001` v1.3.6。普通 projected 橡皮的 512/1024 实时 keep-mask 已同时绑定当前材质与共享注册表。v1.3.5 只等待全分辨率提交完成，但多投影纹理数组不能在旧材质中原位替换 authored mask URL；提交已进入 LayerStore、SceneRoot 新材质尚未发布的窗口内，退出工具、启动单视图、选择图层或切换 Flat/PBR 仍会提前清除共享实时权威，重新显示旧蒙版。现在交接分为两段：先等待像素提交，再保持实时 multiplier，直至 `liclick:projected-material-resident` 后验证新材质的 direct mask uniform 已绑定当前 `layer.assetUrl`。切换投影层还会等待该驻留握手后才复用唯一实时采样器；隐藏层可直接释放，重新显示时从已提交蒙版恢复。提交失败仍恢复旧持久蒙版后清理。擦除覆盖、作者 mask、GPU shader、CPU/Worker 补缝、UV/export、最终分辨率、Project/Layer Schema、Command 幂等性、Revision CAS、ownership 与资产不变，无迁移；回退移除驻留握手会重新引入材质重建窗口内的回弹。

变更卡 `CHG-20260907-FILE-RESPONSE-ABORT-CLOSE`：主模块 M14，协作 M01/M10/M13；文件响应生命周期契约 `FILE-RESPONSE-LIFETIME` v1.0.0。用户删除 11-20 工程时 Windows rename 到回收站报 EPERM。源码发现 workspace、烘焙单张产物、Web 静态文件响应直接 ReadStream.pipe(response)，取消下载后可能将源流留在背压暂停状态，继续持有文件描述符。改为共用 Node pipeline，由响应提前关闭/读取失败联动销毁源流；完整响应和背压不变，不将网络中断升级为未处理异常。真实 HTTP 测试用 16 MiB 文件中途取消，旧 pipe 实现在句柄关闭断言失败，新实现通过；同测验证完整字节、源读取失败及保留数据的目录移入回收站。该证据证明文件句柄泄漏，不据此认定所有 EPERM 都来自相同原因；旧进程句柄需重启释放。调用前的认证、owner、路径包含/realpath、安全响应头、HEAD 与烘焙状态门禁保持，删除仍走原回收站 rename，不以强制删除代替。GPU/CPU/Worker/shader、投影/UV/重绘/export 内容、分辨率、QA、Schema、Command 幂等性、Revision CAS 与 verified assets 不变，无迁移；回退仅恢复三个响应入口的 pipe，但会重新引入中断资源泄漏。

文件响应修复验证：后端完整 13 项回归通过，修改文件 lint、Cloud/repository 边界及 diff 检查通过。重启本地 4517 加载修复并释放旧进程句柄后，通过正常页面菜单与确认框删除 11-20 成功；列表仅剩其余三个项目，原目录不存在，回收站保留 `11-20-0c9af007-1788770255481`。未强制删除工程数据；本次实测证实恢复删除，但不能区分旧进程具体哪个文件句柄造成原 EPERM。

推送竞态处理：首次推送被远端新增 `c0c15cb` 拒绝后，已将四个本地提交重放到该提交上，未强推。完整保留上游 `previousRoot?.visible === false` 运行时修正；重叠测试使用真实 handoff helper，覆盖原上游同/跨对象断言，并保留隐藏、未指定 visible 与 legacy 无归属用例。此前 86 项 Web/12 项 Server 全回归通过；重放后重新执行 ordered-composition 与 layer-retention 两项相关回归均通过，最终构建另行核对。

2026-09-07 本批推送前集成：快进合入 master `4fe9a58` 的跨对象预览交接修复，完整保留运行时代码。其新增 previousRoot.visible/对象身份门禁暴露了 ordered-composition 旧测试使用空对象模拟根节点的问题；测试改为可见根节点及真实 isLocalRepaintHandoffForObject，保留原同对象 resident/merged-UV 断言，新增隐藏、跨对象和 legacy 无归属用例，不放宽运行时门禁。M15 测试契约更新，不改变算法/Schema，无迁移。后端 12 项回归、完整 Cloud build:release、artifact/包体门禁通过：80 chunks / 3,131,704 bytes；全仓 lint 为 0 errors / 15 条既有 warnings，部署策略 5 项测试通过。历史段落中的“未推送”表示各阶段记录，本批提交/流水线状态须以最终回复与 GitLab 为准，release 保持不动。

变更卡 `CHG-20260907-SERVER-ARCHIVE-CRC`：主模块 M11，协作 M10/M13，`PERF-EXPORT-ZIP-001` v1.0.2。后端烘焙归档 updateCrc32 同样改为 Buffer 索引读取，保留跨流分块的 CRC 状态和所有 ZIP 结构。Node 24 / 16 MiB 按 64 KiB 分块、三次预热及七轮交替测量，中位 46.90→25.60ms；这是累计 CRC CPU 时间，不是单次事件循环阻塞或下载总耗时。实际生产模块经 TypeScript 编译后与冻结旧实现对照，以真实文件 ReadStream 和 highWaterMark=1 的慢 Writable 验证完整 ZIP 字节、背压、尺寸变化拒绝、ZIP32 上限及 400 组不同分块边界；原任务 ownership/成功状态门禁、流式发送、归档文件内容及 HTTP 路由未改。GPU/CPU 图像算法、Worker/shader、投影/UV/重绘、输出分辨率、QA、Schema、Command/Revision/ownership 与 verified assets 不变，无迁移；回退只恢复 updateCrc32 的 for-of。未移除客户端断开、流式文件 I/O 或任务扫描等其他潜在开销。

CRC 索引读取集成验证：86 项 Web 回归通过，正式身份构建 80 chunks / 3,131,527 bytes，通过原 3,134,000-byte 门禁；修改文件 lint、Cloud/repository 边界和 diff 检查通过。本轮仅新增 CRC 读取优化，未进行新的浏览器帧率或付费生成测试，未提交/推送；此前 ZIP 内存与模型订阅本地补丁完整保留。

变更卡 `CHG-20260907-ZIP-CRC-INDEXED-READ`：主模块 M11，资源/计算契约 `PERF-EXPORT-ZIP-001` v1.0.1。createZipBlob 的 CRC32 改为 Uint8Array 索引读取，省去逐字节迭代器开销；CRC 查表、初值、多项式、移位/XOR 顺序、终值及字节访问范围不变。仍同步完成同一数据视图校验，不引入异步期间调用方修改数据的竞态。Node 24 / 16 MiB、三轮预热后七轮交替测量：旧中位 80.55ms，新中位 26.25ms；只是该机器隔离 CPU 测量，不等同于浏览器导出总时长或 FPS 提升。标准 CRC 向量、400 组偏移/长度/随机/全零/全 255 夹具同时对照冻结旧实现与独立 bitwise oracle，完整 ZIP 字节对照保留。OBJ/MTL/纹理与 Comfy 控制图仍经相同 ZIP 入口，现有 manifest/QA 验证不变；不修改 GPU/CPU 图像算法、Worker/shader、投影/UV/重绘/export 像素、分辨率、Schema、Command/Revision/ownership 或 verified assets，无迁移。回退仅恢复 CRC for-of；同步 CRC 仍可能超过一帧，未承诺零掉帧。

2026-09-07 后续性能集成验证：已将前一批优化推送 master `2dc1c02`，release 仍为 `2c49d52`；GitLab 页面需要双重验证，维护者要求先继续性能，因此不宣称该 CI 已通过。推送后的 ZIP/模型订阅补丁仍在本地：86 项 Web 回归、typecheck、修改文件 lint（0 errors、SceneRoot 一条既有 warning）、Cloud/repository 边界与 diff 检查通过；正式身份构建 80 chunks / 3,131,497 bytes，原 3,134,000-byte 门禁通过。4517 九模型工程恢复、杯子/桶切换与贴图显示正常，已恢复桶并显示 Saved，浏览器 error 为空；初次切换窗口仍见 83ms 峰值，没有严格前后 FPS 对照，不宣称零掉帧或所有热点已消除。未执行付费生成或生产导出。

变更卡 `CHG-20260907-VIEWPORT-PROJECT-SUBSCRIPTION`：主模块 M03，订阅契约 `PERF-VIEW-PROJECT-001` v1.0.0。ImportedModel 对当前 project 的实际消费仅为 id/captures/bakedTextures；原整个对象订阅使改名、选中对象及保存元数据更新也使每个模型订阅失效。改用已安装 Zustand useShallow，仅比较上述三项身份；当前工程缺失继续返回 undefined，工程切换、捕获和烘焙贴图替换仍即时通知。findExactLayerStackTexture 仅将 TypeScript 入参缩窄为其实际读取的 bakedTextures，无运行时代码变化。回归执行 SceneRoot 实际 selector 和已安装 useShallow，九模型×100 次无关更新从预期 900 次失效降为 0；捕获/贴图/工程切换/移除/恢复逐项通知通过。这是订阅失效计数，不是浏览器总 render 数或 FPS 提升比例；其他 store/props 仍能触发组件渲染。GPU/CPU/Worker/shader、投影/UV/重绘/导出、缓存匹配公式、像素、分辨率、QA、Schema、Command 幂等性、Revision CAS、ownership 与资产不变，无迁移。回退恢复整个 project 订阅和原类型即可。

变更卡 `CHG-20260907-ZIP-COPY-REMOVAL`：主模块 M11，资源契约 `PERF-EXPORT-ZIP-001` v1.0.0。OBJ 材质打包与 Comfy 控制图导出共用 createZipBlob，原实现为所有 chunk 分配同尺寸 ArrayBuffer 并复制，再构造 Blob；现在直接把 ArrayBuffer-backed Uint8Array 视图交给 Blob，由构造器按 byteOffset/byteLength 拍下不可变快照，移除 JavaScript 层整包重复复制。CRC、ZIP 顺序/头/目录/时间/编码/偏移、输入文件内容、PNG/材质/蒙版及分辨率均不变；不修改 GPU/CPU/Worker/shader、投影/UV/重绘、生产服务、Schema、Command/Revision/ownership 或 verified assets，无迁移。固定时间戳下对冻结旧实现逐字节对照，覆盖空包、Unicode/反斜杠文件名、Blob、ArrayBuffer、偏移 TypedArray/DataView、空文件和 16 MiB 文件；构造后修改输入不改变输出。测试夹具显式 ArrayBuffer 复制由 16,777,979 bytes 降到 0，不代表 Blob 零拷贝或 RSS 同幅下降。CRC 同步循环仍在，不宣称导出零掉帧。回退只恢复原 chunks.map 复制。此补丁在 master `2dc1c02` 推送之后，本地验证与该提交 CI 状态需分开报告。

变更卡 `CHG-20260907-BAKE-ROUGHNESS-ASYNC-IO`：主模块 M10，I/O 调度契约 `PERF-BAKE-IO-001` v1.0.0。合入 master `5c672ca`（含上游输入 bitmap 修复与提示词更新）后，粗糙度自动生成阶段改用 fs.promises.readFile/writeFile 读取 BaseColor 和写入原始 PNG，等待整次读取后才远程提交、等待写入后才执行既有 PNG 头与分辨率检查并发布。24 字节头校验、小型任务记录和远端取消语义未变，不宣称完全无同步 I/O。回归执行编译后的真实阶段，覆盖成功、读失败、远程失败、非 PNG、写失败、尺寸不匹配；验证异步读取让出事件循环、原 Buffer 身份、发布顺序及失败不发布。GPU/CPU/Worker/shader、生产烘焙公式、mask、投影/UV/export、分辨率、QA、Schema、Command 幂等性、Revision CAS、ownership 和 verified assets 不变，无迁移；回退只恢复这两处同步读写。上游 generationInputWorker 原修复完整保留，本地只补充 local/single 两入口参数与三图顺序回归，不重复更改其算法。

变更卡 `CHG-20260907-PROJECT-LIST-PROJECTION`：主模块 M14，协作 M01；查询契约 `PERF-PROJECT-LIST-001` v1.0.0，图像算法版本不变。PostgreSQL 项目列表由读取完整 document_json 改为同一 JSON 中七项摘要字段的 jsonb_build_object，保留 slug、用户/软删除过滤、排序、缩略图 URL 与旧字段默认值。现有部分索引足够，不新增 Schema 或摘要持久列。PGlite 实际 SQL 测试中含 2 MiB 捕获元数据的工程集合由 2,099,910 bytes 降到 921 bytes，公共摘要逐项与旧查询对照一致，完整加载、旧工程默认值与账号隔离通过；后端完整 11 项回归通过。此数字仅为夹具的数据库响应大小，不代表线上延迟或数据库 CPU 降幅。GPU/CPU/Worker/shader、投影/UV/重绘/export、分辨率、QA、Command 幂等性、Revision CAS、ownership、verified assets 和 Schema 不变，无数据迁移。回退只恢复列表原 SELECT 和类型，无需恢复工程数据。全仓扫描范围、M01–M15 覆盖、已证实/待测热点及验证限制见 [2026-09-07 全仓性能审计](PERFORMANCE_REPOSITORY_AUDIT_2026-09-07.zh-CN.md)。

变更卡 `CHG-20260907-REPAINT-IMAGE-DECODE`：主模块 M08，`ALG-LR-008` v2.4.5，入口在 M03 ViewportCanvas 的共享 image loader。前次 LoAF 指向 `loadImageElement` 的 IMG.onload 后续工作，读取代码确认此加载器在 onload 即发布 HTMLImageElement，Canvas drawImage/GPU initTexture 消费前没有显式解码等待；这只能证明存在同步解码风险，不能把整个长帧都归因于解码。本次让同一个缓存 Promise 等待原图 decode 后再发布，阻止并发消费者绕过解码阶段；不创建缩小版、替代图或新 Canvas。缺少 decode 或可选 decode 拒绝时仍返回已经加载的原图；网络加载失败保持拒绝并清除失败缓存。六项 LRU、URL 身份、失败重试、调用方取消与 20 秒准备预算不变。对照测试在修改前确认 onload 即发布，修改后覆盖解码未完成不发布、重复消费者共享、4K 原图对象及尺寸、旧浏览器/解码拒绝回退、加载错误重试与六项 LRU。审计消费路径包含作者蒙版提前准备、UV 绘制底图恢复、返图原图/allowed mask、保存蒙版恢复与 UV commit 旧图加载；原有 session/revision/取消检查保持不变，live Canvas 分支保持直接复用。GPU/CPU/Worker/shader 算法、颜色/Alpha/深度/投影矩阵、UV 合成/导出与输出分辨率不变；Project Command 幂等性、Revision CAS、ownership、verified assets 和 Schema 均不变，无迁移。回退只恢复 onload 直接 resolve，不更改缓存资产或工程。真实浏览器收益须按相同可见面板和缓存状态实测，不承诺单次更改消除所有长帧。

本次 decode 验证：84 项 Web 回归通过，新增解码屏障测试在旧实现失败、修改后通过；typecheck/build、目标 lint（0 errors、现存 6 warnings）、Cloud/Project repository 边界与 diff 检查通过。使用 master 正式发布身份参数的 Web 构建为 80 chunks / 3,133,997 bytes，原包体门禁通过。测试合集九模型/4K/1280×720/双侧面板展开，36 次同序切换：修改前首次 57.0 FPS/P95 16.8ms/峰值 67ms/丢帧 33，复测 59.0/16.8/50/10；修改后首次 58.5/16.8/50/16，复测 58.6/16.8/50/14。样本不足以证明稳定 FPS 提升，明确收益是共享消费者不再在 decode 未结束时开始绘制/上传。新构建剩余 LoAF 见 React Scheduler MessagePort 49.3ms，仍有 50ms 帧峰值；不宣称零掉帧，未执行付费生成或生产导出。

变更卡 `CHG-20260907-MASTER-RELEASE-BUDGET`：M08 / `ALG-LR-011` v1.2.1，M15 发布验证。推送前使用 master 完整发布身份参数验证，3,134,284 bytes 超过原门禁 284 字节；此前 3,133,993 bytes 是普通开发构建，不能代替 CI 发布构建。生成显示与 capture-mask 显示共用一次无缩放 canvas crop，调用方仍分别计算原 alpha bounds / 6% padding，并在缺少 context 时保留各自 alignedUrl/sourceUrl 回退。PNG 编码和非零透明 RGB、画布颜色/过滤参数、draw/read 矩形不变；临时画布在完成和异常时释放。没有改动 subject-filled 路径的 high-quality smoothing，也没有提高包体门禁。真实 helper 与两条实际调用函数回归覆盖裁切坐标、各自留白、缺少 context、读/绘制失败、返回 ImageData 独立性。算法语义及版本、GPU/CPU/Worker/shader、投影/UV/export、正式资产、分辨率、Schema、Command 幂等性/Revision CAS/ownership 均不变，无数据迁移；回退仅内联两份原裁切段。master 按现有 CI 执行 verify/build/container:verify，生产部署仍仅由 release 的既有规则决定；本次不修改 release。

发布验证结果：完整 Cloud build:release / check:cloud-artifact 通过，正式发布参数下 80 chunks / 3,133,956 bytes，低于原 3,134,000 门禁；84 项 Web 回归通过，追加 400 组边界公式对照及真实裁切/调用方回归通过，目标文件 lint 与 diff 检查通过。

变更卡 `CHG-20260907-DISPLAY-SCRATCH-RELEASE`：主模块 M08，`ALG-LR-011` v1.2.1。继续处理图层显示副本的临时内存：`urlToImageData` 的 scratch canvas 在读回完成、取消或异常时通过 finally 清空 bitmap；`resizeImageData` 在最后读回后释放输入及输出画布，包括 context/put/draw/read 失败。一个 4096² RGBA scratch bitmap 对应约 64 MiB 像素存储；此前释放时间依赖浏览器 GC，本次不再保留该画布的非零尺寸到 GC。此为资源生命周期优化，不宣称进程 RSS 必然即时下降，也不把没有脚本归因的 LoAF 直接认定为 GC。ImageData 返回值独立持有像素；源图、完整一次绘制、原尺寸/过滤/颜色空间、分条读取、遮罩、裁切和 PNG 路径不变。图层作者 mask 分支仅移除前置 guard 后不可达的条件，异步 PNG 调用保持原错误传播。共享 imageUtils 消费者审计包含局部重绘、CPU projection/UV 辅助调用：不释放调用方画布、ImageData、纹理或 live registry 对象；GPU、Worker、shader、正式服务、持久化、export 与输出分辨率不变。Schema、Project Command 幂等性、Revision CAS、ownership、verified assets 无变更，无迁移。回退只移除两个 finally 释放段及等价条件整理，已有项目无需恢复操作。回归执行真实 helper，覆盖成功/中途取消/加载及读回失败、resize 各 context/put/draw/read 异常、无尺寸变化零分配、返回像素独立性；沿用 600 组遮罩和 400 组边界精确输出对照。真实交互需在页面 visible、同构建/同面板/同缓存条件下比较；后台 1 秒节流的录制不得计入结果。

本次 scratch release 验证：84 项 Web 回归通过；600 组遮罩/400 组边界精确对照、真实渲染分支的作者 mask 与 live canvas 保护通过；typecheck/build、Cloud 与 Project repository 边界、diff 检查通过，lint 0 errors（现存 warnings 保留）。80 chunks / 3,133,993 bytes，原 3,134,000 字节门禁未提高。4517 实际九模型均完成可见小图加载，放大 UV 仍为 4096²，无浏览器 error。新构建同序 36 次切换两次为 56.4/55.7 FPS、P95 均 16.8ms、峰值均 67ms；此前已驻留页面为 58.9 FPS，重新加载对照构建后预览加载延迟使缓存条件不一致，不能据此给出本轮 FPS 提升或回退的因果结论。LoAF 另见局部重绘 loadImageElement 的 IMG.onload 后续任务与 React Scheduler，仍需进一步分段归因，未承诺零掉帧。

变更卡 `CHG-20260907-LAYER-THUMBNAIL-CACHE`：UI-09 → 主模块 M08，`ALG-LR-011` v1.2.0。真实“测试合集”/九模型/4K/1280×720，同序 36 次选择：生成与图层面板收起时 59.4 FPS/P95 16.8ms/峰值 33ms，仅生成展开为 59.5/16.8/33；图层展开后为 45.2/50.0/150。DOM 确认约 48px 图层格正在读取 4096² UV、2048² 修补图，以及每项 78–118 万字符的 700–1000px 显示 PNG。原完整显示缓存不足以同时保留这些多模型大图，切换还会先挂载原图 img 再替换为处理后的 PNG。

图层小缩略图现在使用独立 4 MiB/128 项的串行可取消 LRU，保留最长边 128px（覆盖现有 48px 小图的两倍像素密度以上）的 PNG。普通投射层先走原完整 depth/fallback mask、精确 bounds 和 padding 管线，只对最终 fitted 结果生成小图；UV 小图直接使用原资源，不套生图背景遮罩。仅这一调用使用 urlToImageData 的 maxSize 选项；它按原长宽比只缩小不放大，draw/readback 上限 128²。原生图、图层源资产、1024 显示/放大预览、生产投影/UV/导出尺寸不变，未降低 QA。小图栅格尺寸是明确的 UI 新派生，不把它说成与原高清 PNG 逐字节相同；原遮罩与裁切算法及正式资产仍保持原结果。

图层列表加载中不先启动高清 img，名称/显隐/选择/预览入口保持可操作；失败回退原图。source/depth/revision/type/消费者模式共同保护结果归属，取消旧请求不得覆盖新图；live source 和局部重绘作者 mask 继续原 Canvas/CSS 路径，放大预览继续完整处理。GPU、Worker、shader、生产 CPU/持久化/export 对应算法与分辨率不变，Schema、Command 幂等性、Revision CAS、ownership 和 verified assets 无变更，无迁移。回退去掉小图调用/独立缓存/maxSize 可选参数，恢复图层行原预览分支；不删除工程或资产。

回归执行真实小图函数和图层 hook，覆盖原投射遮罩/UV 分流、修订/图像替换、取消后迟到结果、live/作者蒙版排除、放大预览分流和失败回退；读取回归验证 4K/竖图/单列/小图的 128px 约束及默认路径不变。现有 600 组遮罩像素对照保留。选择预热队列仅移除多余 async/await 包装，继续由 Promise 链等待原任务终态，71 次切换/失败恢复回归保留。构建和原包体门禁通过：80 chunks / 3,133,999 bytes，预算未提高；本卡未提交、未推送。

本卡完整 84 项 Web 回归、Cloud/repository 边界、typecheck/build 和修改文件 lint 通过（零错误、LayersPanel 五条原有 warning）。4517 实际加载 index-DyYiINPt、两个面板均展开，DOM 核对桶的八个小图最长边均 <=128，PNG 约 1–4.5 万字符；从正常图层“查看”入口打开仍为 4096² UV 原图，模型/小图视觉正常，无 console error。同序 36 次选择：前两轮 56.1/56.9 FPS、P95 16.9/16.8ms、峰值 133/167ms、错失 43/34 帧。逐模型等待当前可见小图呈现后复测 58.5 FPS、P95 16.8ms、峰值 117ms、错失 16 帧。food bowl 一次自动等待超时后小图随后完整呈现，首次准备仍有等待，不能把空白加载期计作所有小图已就绪；最终峰值仍不满足零掉帧。剩余 LoAF 有无脚本归因的 157–175ms 段及 React MessagePort 37–46ms，未据 phase 标签认定 GPU 根因。未执行收费生图或正式导出，不以本轮缩略图收益宣称所有算法路径已无卡顿。

变更卡 `CHG-20260907-WIREFRAME-RESIDENCY`：UI-04/UI-06 → 主模块 M03，`ALG-VIEW-SELECT-001` v1.0.4。ImportedModel 在贴图工作区未选中时返回 null，导致已准备的 TopologyWireframeOverlay 每次卸载并释放材质；再次选中会重新遍历几何、创建辅助网格/材质、compileAsync 和 1×1 真实几何预热。现让已完成首次材质呈现的辅助层位于稳定的返回树位置，模型/工作区隐藏只将其 visible=false；未准备模型不提前创建，真实模型卸载/几何替换仍按原生命周期释放。隐藏辅助层帧回调不更新矩阵，重现时按最新对象变换更新；原模型 primitive 继续在隐藏时脱离场景，不影响拾取或加载提示。

仅调整辅助网格驻留，不改 wireframe 颜色/透明度/depth/polygonOffset、几何索引或着色器公式。捕获 renderTargetUtils/captureCurrentView 与 exportUtils 均继续排除 liclickViewportHelper/liclickWireframeOverlay；投影/UV/重绘 GPU、CPU、Worker、shader、持久化和导出像素、输出分辨率及 QA 均不改。Schema、Command 幂等性、Revision CAS、ownership、verified assets 不变，无迁移；回退恢复隐藏时的返回树和矩阵更新，不删除工程或资产。新增回归执行 ImportedModel 真实返回片段和 TopologyWireframeOverlay 真实 Three 资源，覆盖可见/隐藏/未准备组合、71 次切换仅一次编译和真实几何预热、隐藏矩阵不更新、重现跟随变换与卸载释放。保留每个已呈现模型的一份小型辅助材质/网格，几何仍引用原 BufferGeometry。

本卡 84 项 Web 回归、含 typecheck 的 build、修改文件 lint（零错误、SceneRoot 一条原有 warning）和原包体门禁通过：80 chunks / 3,133,561 bytes。4517 加载 index-6CYHPJX7，1280×720、“测试合集”/九模型/4K，线框在桶/杯之间切换只呈现当前模型，回到平面显示正常、console error 为空。完整恢复后 36 次同序选择：44.0 FPS、P95 66.7ms、峰值 134ms；前一版为 42.9/P95 66.9/峰值 133ms，不能据此宣称端到端显著提速或百毫秒长帧已解决。确定性收益是消除已预热线框的重复创建/编译/预热；本卡未提交、未推送，未运行收费生图或正式导出。

变更卡 `CHG-20260907-DISPLAY-MASK-CPU`：UI-05/UI-09 → 主模块 M08，`ALG-LR-011` v1.1.3。接续此前显示遮罩 CPU 段：暗背景连通扫描先按原 Alpha 阈值接受透明像素，只有需要 RGB 判定时才计算原 luma/max/chroma 标量，取消每次 getTone 对象创建；RGB 运算顺序、seed/candidate 阈值、邻居访问、连通域与 changedPixels 完全不变。深度显示遮罩仍按原 RGB >=254 判定，只把四字节清零/非零计数合并为 Uint32 读取与写零；新复制的输出缓冲对齐，零值不依赖字节序，输入不修改。

输入仍为原尺寸 RGBA 与 packed depth，输出逐字节一致；不改显示缩放/裁切/PNG、生产投影/UV/重绘的 GPU、CPU、Worker、shader、持久化和 export 对应路径，不降低分辨率或 QA。Project/Layer/Generation/Capture Schema、Command 幂等性、Revision CAS、ownership、verified assets 无变更，无迁移。回退恢复这两个显示函数原标量实现，不删除工程或资产。冻结 5c0764ff 两个函数为测试 oracle；600 组透明 RGB、阈值边界、非对齐输入、不同尺寸逐字节及 changedPixels 对照通过，验证输入不变和尺寸错误。1024² 隔离中位数（预热 5 次、记录 20 次）：深度清空 3.37→3.07ms、透明连通背景 31.04→17.96ms、不透明黑背景 28.39→19.15ms；不是端到端帧率收益，原生编译尖峰不属于本卡。

本地显示读取/阶段取消、预览队列、generation-preview-edge-decontamination、local-repaint-result-composite、background-scheduling、projection-performance-safety、model-export-texture-orientation 回归及含 typecheck 的 build、修改文件 lint 通过；包体 80 chunks / 3,133,504 bytes，通过原门禁。4517 前后端已按请求重启，本卡未提交或推送。

浏览器加载 index-DEMRl1gj，实际 1280×720、“测试合集”/九模型/4K，恢复完成后连续 36 次切换：42.9 FPS、P95 66.9ms、峰值 133ms，模型与缩略图显示正常、console error 为空。此前同场景最后一轮为 41.5 FPS/P95 83.4ms/峰值 134ms；此为顺序采样且缓存/环境存在波动，不将差异归因于本次像素循环，也不宣称总体流畅度达标。未运行收费生图或正式导出。

变更卡 `CHG-20260907-SELECTION-PREWARM-QUEUE`：UI-04/UI-06 → 主模块 M03，`ALG-VIEW-SELECT-001` v1.0.3。选择 effect cleanup 无法中止 Three.compileAsync 已启动的原生轮询；原先新选择可在旧编译尚未完成时分配下一套预热资源并再次编译。本次按 renderer 串行安排选择预热，任务入队后、真正分配前核对原模型/工具/图层所有权，跳过失效选择；原任务仍在现有帧边界检查取消。队列等原任务真正结束才释放，失败保留原异常且不阻断下一任务，不同 renderer 互不阻塞。最终选择仍完整上传原纹理、编译 overlay/depth 程序并捕获相同深度。

仅改变 M03 预热调度；投影/UV/重绘的 GPU、CPU、Worker、shader、持久化与 export 算法、分辨率和 QA 均不改。Project/Layer/Generation/Capture Schema、Command 幂等性、Revision CAS、ownership、verified assets 无变更，无迁移；回退仅移除队列包装及 helper，保留原 prepare 和所有资产。`test:model-selection-residency` 执行生产 effect/helper，挂起真实调用边界的编译 Promise 后切换 71 次，验证中间任务零新增分配/上传/编译，最终选择完成两次编译与深度捕获；另覆盖编译拒绝、队列恢复和不同 renderer 独立运行。此证明避免重叠及过期工作，不证明单个原生 isReady 阻塞已解决，也未串行化其他材质编译或全局 GPU 上传。

本卡本地验证：84 项 Web 回归、含 typecheck 的 build、修改文件 lint（零错误、6 条原有警告）、Cloud/repository 边界及原包体门禁通过（80 chunks / 3,133,661 bytes，预算未改）。4517“测试合集”/九模型/4K，实际 1280×720、恢复完成后每轮 36 次切换：新版两轮 36.8/28.3 FPS、P95 83.5/150.2ms、峰值 183/217ms；同标签重建旧 HEAD 对照 33.5 FPS、P95 100ms、峰值 1001ms（最长 LoAF 无脚本归因且 blockingDuration=0，不能归因编译或计作本补丁收益）；恢复新版并结束本地测试进程后 41.5 FPS、P95 83.4ms、峰值 134ms。构建标识 index-N95RefJQ；图像正常、蒙版工具进入/退出正常、未见 console error。仍有约 100ms 呈现段和环境波动，不能宣称总体流畅度达标或给出因果提升比例；未执行收费生图/正式导出。本卡为本地未提交优化，master 流水线 626589 对应先前 5c0764ff，不覆盖本卡。

变更卡 `CHG-20260907-DISPLAY-PREVIEW-STAGES`：UI-05/UI-11 → 主模块 M08，`ALG-LR-011` v1.1.2。接续上一轮剩余 Scheduler.yield 长任务，临时调用栈确认消费者是 createGeneratedDisplayPreviewUncached / urlToImageData，不是多视图法线捕获；draw/readback 单段未超过 8ms，但后续 resize 为 13–23ms、depth mask 为 5–8ms、bounds 为 2–5ms，空闲检查立即 resolve 时会继续连成同一任务。generated-display 现于读取后、缩放后、depth 读取后、遮罩后及对齐编码后跨过浏览器呈现边界，再检查原交互门控和 AbortSignal。旧消费者切换后不继续后续像素阶段；隐藏页沿用 waitForBrowserPaint 的现有 timer 兜底。capture-mask、原图读取、正式投影与导出路径不改。

精确 Alpha bounds 扫描只查每行首/末非零像素，行内部不会扩大同一行边界；Alpha=1 仍算内容，透明行、内部孔洞和全透明返回保持原值。400 组对照逐项等于原全像素扫描，1024×1024 全不透明图隔离测量约 1.2→0.003ms（20 次均值，非端到端收益）。缩放仍使用原 Canvas 操作，深度/暗背景判定、1024 显示上限、6% padding、RGBA、裁切与 PNG 编码不变；GPU、CPU/Worker 投影和重绘、shader、UV/export、最终分辨率与 QA 均不变。无 Project/Layer/Generation/Capture Schema、Command 幂等性、Revision CAS、ownership 或 verified assets 变更，无迁移；回退只恢复 bounds 全扫描及这些阶段的原空闲检查，不删除工程或结果。

验收：display-image-readback 执行实际生产函数，覆盖每个有/无 depth 呈现边界取消、原像素读取及 400 组精确边界对照；display-preview-queue、generation-preview-edge-decontamination、local-repaint-result-composite、local-repaint-background-scheduling 通过，typecheck/build 与原包体门禁通过（80 chunks / 3,133,468 bytes）。4517 同一“测试合集”，4K、实际 DOM 确认 1280×720、36 次九模型切换；定位版本 39.2/39.9 FPS、P95 83.4ms、峰值 134ms，新版两轮 44.3/44.2 FPS、P95 50.0/66.7ms。第一轮峰值 651ms，LoAF 667.7ms 明确归因 Three.compileAsync 的 currentProgram.isReady 定时轮询；第二轮峰值 117ms。临时日志全部移除；不能宣称冷编译尖峰或整体流畅度已达标，后续需单独审计编译轮询与上传的竞争。未运行收费生图/生产导出。

变更卡 `CHG-20260907-SELECTION-PREWARM-METADATA`：UI-04/UI-06 → 主模块 M03，`ALG-VIEW-SELECT-001` v1.0.2。九模型真实项目“测试合集”连续选择时，LoAF 指向选择蒙版预热的 post-paint continuation；逐段诊断确认 `sourceMesh.clone(false)` 单次同步耗时 389.8ms。模型加载器把原材质存入 mesh.userData，Three Object3D.copy 对 userData 执行 JSON 序列化，连带访问原材质及纹理的 toJSON。新增 cloneShaderWarmupMesh，以只覆盖 userData 的继承源调用原 Three 子类 clone(false)，跳过应用元数据复制；原网格、原材质及 userData 不修改，几何、蒙皮、形变、实例属性和矩阵沿用 Three 原复制契约。预热仍执行相同 overlay/depth 程序编译、GPU 深度捕获、所有权检查和空闲门控。

变更卡 `CHG-20260907-PREVIEW-CACHE-LEASE`：UI-06 → 主模块 M06，`ALG-PROJ-007` v2.1.3。真实恢复中复现 Worker “Decoded preview texture is no longer resident”。原 bulk prewarm 已固定缓存，但普通预览 hook 的解码/上传没有固定，同组其他请求可在超过 24 项时提前释放它。普通消费者现在从解码前到上传/重试终态持有引用计数租约；effect 取消不提前回收仍在上传的共享资源，解码后已取消则不启动无用上传。bulk prewarm 复用相同幂等释放函数；所有持有者结束后恢复原 24 项 LRU 上限。旧请求失败只清理仍属于该 Promise 的缓存，避免删除新请求的 resident entry。

两项变更只调整 CPU 元数据复制和预览资源生命周期。GPU/CPU/Worker 的投影、UV、重绘、coverage、depth/normal 门控、颜色空间、shader、最终分辨率、持久化和 export 算法均不改；不降低 QA。Project/Layer/Generation/Capture Schema、Project Command 幂等性、Revision CAS、ownership、verified assets 不变，无数据迁移。回退可分别恢复预热 clone(false)，或普通 hook 的原无租约路径及 bulk 原固定实现；无需删除、重写工程/蒙版/图层/结果资产。

验证：扩展 `test:model-selection-residency`，执行真实 Three Mesh/SkinnedMesh/InstancedMesh 的复制，使用会抛异常的原材质 toJSON 证明不会读取元数据，并核对几何/材质身份、矩阵、morph、skin、instance、源层级与完整预热。扩展 `test:texture-load-recovery`，执行生产 hook/cache，覆盖 26 个超容量并发 4K 解码/上传、乱序解码、上传中取消、解码前取消、双持有者幂等释放、bulk 整组上传和最终 24 项回收。投影性能安全、多模型恢复、重绘性能/显示契约、导出纹理方向、投影显隐、滚轮回归及 web typecheck/build、cloud/repository/artifact/bundle 边界检查通过。

体验审计（Windows/RTX 4070 Ti SUPER，4517，真实“测试合集”，4K，固定 1280×720 浏览器视口，9 模型循环 4 次，共 36 次选择）：修复前多个热缓存录制峰值 701–901ms；临时定位单独确认 clone 389.8ms，全部诊断代码随后移除。修复后两次录制峰值 234/200ms，未复现缓存错误；但 P95 为 133.4/133.3ms，平均 23.6/25.4 FPS，仍未通过流畅度目标。旧录制负载/恢复阶段与新录制不完全相同，因此只报告尖峰观察，不宣称总体帧率提升。剩余最慢帧的脚本归因为 Scheduler.yield continuation（48–74ms）及浏览器呈现间隔，具体消费者尚需下一轮定位，不把旧全局 phase 标签当作 GPU 根因。未执行真实收费生图或生产导出作业，算法保持证据来自源码边界与回归，不能替代这些端到端验收。

变更卡 `CHG-20260903-REPAINT-DISPLAY-READBACK`：UI-05/UI-10 → M08，`ALG-LR-011` v1.1.1（Cooperative display image readback / 返图显示读取让步），production，实施 Codex、体验验收维护者。接续 `e0a0ed71`：上轮返图 LoAF 中 IMG.onload 为 237.1ms，读取入口为 imageUtils 的 HTML Image 加载及后续 Canvas/预览微任务。局部重绘实际走 createGeneratedDisplayPreview，不走 capture-mask；曾试验的捕获蒙版零梯度优化不在此主路径，已撤除，52→36ms 隔离结果不计入本次收益。

仅 generated-display 的原图和 depth 读取开启 cooperative 选项：已加载 Image 在支持时等待 decode，保留同一个原尺寸/原过滤 Canvas 完整 drawImage，然后以最多 262,144 像素（约 1 MiB RGBA）逐条 getImageData，无缩放地复制到完整输出。每条前让出浏览器任务、尊重已有 180ms 交互空闲门控并检查取消；隐藏页沿用既有任务兜底，不新加 rAF 依赖。加载中取消释放监听和 Image 请求；decode 提示拒绝时仍可使用原已加载图片，但加载、Canvas/readback 真正错误保留失败。默认调用者继续原整图读取，无新等待。

输入为相同 URL、目标尺寸、sRGB/默认 Canvas RGBA；输出逐字节保持相同像素和尺寸。后续 1024 显示上限、depth 阈值、裁边/6% 留白与 PNG 编码不变，不降低最终输出分辨率。只调整 M08 CPU 显示读取，GPU/Worker/shader、capture/projector、作者与远端 mask、UV/export、Layer/Generation/Capture/Project Schema、Project Command 幂等性、Revision CAS、ownership 和 verified assets 均无变更。无迁移；回退移除两处 cooperative 参数及对应可选读取实现，不删除工程或结果。

`test:display-image-readback` 执行真实生产读取函数，覆盖单像素/单列/奇数尺寸/末条不足、完整 RGBA（含透明像素下 RGB）与默认路径对照、只绘制一次、每条独立 yield、natural/fallback 尺寸、decode 缺失/拒绝、六处取消和加载/上下文/读取异常。旧 HEAD 实现在让步断言失败，新实现通过。此为确定性 Canvas 读取/调度契约，不替代真实浏览器解码耗时、颜色处理及返图帧稳定性验收。当前补丁在前一批推送之后，暂未推送，不能把前一批 CI 状态当作本卡验证。

本卡本地验证：83 项 Web 回归、Web typecheck、修改文件 lint、完整身份 build:release、Cloud artifact、Cloud/repository boundary 及 diff 检查通过；79 chunks / 3,127,005 bytes，仍低于既有 3,134,000-byte 门禁。浏览器已加载 index-CK3tUtbr，004_flour_bag 的返图显示预览可见，但模型视口持续显示加载提示，随后测试标签显示“页面崩溃”；自动恢复受浏览器控制策略阻止。随后原标签恢复到工程 Saved 界面，模型仍显示加载提示。因此本轮没有有效的新版连续帧对照，不能引用页面留存的旧录制作为收益。恢复阶段已包含在材质结构 key 中，尚无证据支持把卡住归因于驻留材质 fast-path；未据此改动模型显示门控，崩溃原因与多模型恢复仍待进一步复现。

2026-09-03 推送前集成验收：六项性能修复按独立中文提交整理，并重放到远端 master `7febed1`，保留其蒙版持久化、橡皮原子交接、结果选择、模型恢复与历史修复。合并后 82 项 Web 回归、全工作区 typecheck/lint（零错误、16 条 warning）、服务端 project pipeline persistence、完整身份 build:release、Cloud artifact、Cloud/repository boundary 和 diff 检查通过。JS 为 3,126,369 bytes，低于上游既有 3,134,000-byte 门禁，本批不改 CI 或预算。下面“未提交本地补丁”与旧预算描述为各阶段历史测量，不能冒充本次远端 CI 或合并后的浏览器帧验收；返图约 300ms 和首次编译尖峰继续跟进。

`CHG-20260903-CAPTURE-FIRST-YIELD-ISOLATION` 本地复测（index-Bal034pk / EditorPage-BZeSN5VI）：加载新版，恢复 004_flour_bag / 四层可见重绘 / 4K / Front-Right，正常蒙版绘制及“局部生图”提交。新录制最大帧 300.2ms、9 个长任务/最大 313ms，旧录制 834.0ms/8 个长任务/最大 762ms；新窗口最慢归因变为 Response.json.then 313.6ms、IMG.onload 237.1ms，原蒙版捕获期间 R3F render 760.1ms 未再出现。按钮反馈 10.8ms、蒙版阶段 772.5ms、当前图准备 1635.5ms；新蒙版提交时尚需 archive，而旧蒙版已经 accumulated，且录制时长、缓存和网络返回不同，因此不以平均 FPS 或阶段总耗时计算严格收益比例。提交后图片/回调长任务仍在，实时面板另记录约 700.6ms 峰值（不在本次录制窗口内），多层首次编译和完整返图帧稳定性仍未通过。

本地验证：80 项 Web 回归通过；最终 capture 函数/清屏色补充用例再次通过，Web typecheck、修改文件 lint（新文件零错误，Viewport 的 7 条既有 warning）、完整身份 build:release、Cloud artifact、Cloud/project repository boundary、git diff --check 通过。总包体 79 chunks / 3,121,988 bytes，原 3,122,000 门禁余 12 bytes，未调整 CI 或预算。仍为基于 bdc33c18 的未提交本地补丁，未推送或宣称远端 CI 已通过。测试通过原 UI 新增生成/蒙版/复制层，保留测试结果，不删除用户旧资产；对真实生成结果的美术质量与长期恢复需继续验收。

变更卡 `CHG-20260903-CAPTURE-FIRST-YIELD-ISOLATION`：UI-05/UI-06 → M03，新增运行时调度契约 `ALG-CAP-006` v1.0.0；Color/Mask/Depth/Normal 像素算法 `ALG-CAP-002/003/004/005` 版本不变。当前测试工程一次真实局部生图录制覆盖提交及返图，最大帧 834.0ms、8 个长任务/最大 762ms；819.4ms LoAF 位于 button2-mask-capture-gpu-wait，其中 R3F render 760.1ms，另有结果处理 Response.json.then 317.7ms 和 IMG.onload 243.7ms。按钮初始反馈 10.5ms，蒙版全阶段 1575.6ms（含异步 GPU/PNG），效果图准备 1465.3ms；不能把阶段总耗时全部当作主线程阻塞，也不能把阶段标签当 GPU 栈。

源码发现离屏 target 清空后，首次 waitForViewportIdle 在恢复共享 renderer 前执行，R3F 因此可能向捕获 RT 呈现；同一后台捕获还把 scene.background=null 留过了帧边界。本次首次等待前恢复 target/viewport/scissor/clear/autoClear/XR 与背景，每个 tile 的背景仅作用于同步 render，重绑 tile 时重设捕获 clear color/alpha；多 pass 对应路径在首次等待及 clearDepth 后同样归还 renderer。顺序 tile 使用双循环，省掉等价坐标数组，保留行优先次序、边缘尺寸、4ms 预算和 GPU fence。非 tiled、显示变换、异步读回、PNG Worker、失败 finally 均覆盖。

GPU/CPU/Worker/shader 审计：不改采样、分辨率、光照/覆盖公式或 PNG 编码；捕获背景与 clear 值仍取原请求，防止视口清屏色污染后续 tile。投影/UV/重绘/导出继续消费完整同尺寸捕获，Project Command 幂等性、Revision CAS、ownership、verified assets、Schema 不变，无迁移；回退仅恢复调度实现，不删除捕获/生成/用户图层。`test:capture-renderer-isolation` 执行生产函数和状态快照/恢复器，实用 Three RenderTarget 搭配确定性 renderer，验证每个 idle/fence/readback/encode 边界、完整边缘像素、非 tiled/display/multipass 与四类失败释放；对 HEAD/bdc33c18 运行 --baseline 在第一次 idle 明确失败，新实现通过。这证明状态泄漏被修复，不替代浏览器帧尖峰及真 GPU 图像 QA。前一输入路由补丁 79 项 Web 回归已通过；本卡新增测试纳入总回归。

2026-09-03 原生画笔尾部路由实测（本地未提交构建 index-DY9rEUkP / EditorPage-ukebs6tV，基于 bdc33c18）：004_flour_bag / 九模型 / 4K / Front-Right，相同四个屏幕点位；旧版录制四笔最大帧 100.1ms、4 个长任务/最大 117ms，LoAF 四次 104–119.1ms，均含 R3F DIV.onpointerup 48.2–74.9ms 与 DIV.onclick 41.1–52.4ms。新版刷新后保存快照只恢复一层可见重绘，故通过普通菜单重新复制三层，确认四层与 handoff=ready 后录制：最大帧 50.0ms、1 个长任务/最大 70ms，LoAF 78.1ms 的主要脚本为原生 CANVAS.onpointerdown 68ms；该段未再出现 R3F up/click 长任务。录制间隔/热缓存并非严格等时，不比较平均 FPS 作为收益比例，不将短录制宣称为零卡顿。复制/准备阶段仍记录约 750.6ms 最大帧与 compile 807ms，未包含在四笔窗口内；材质首次编译、原生首笔、提交生图和返图卡顿仍未完成验收。副本仍在页面，不据 Saved 文案宣称副本持久化已通过。

同一 M03 输入清理中复用已计算的 sourceKey、isMaskStroke 与外层未就绪条件，删除重复判定以保持原 3,122,000-byte 包体门禁，不改变 layer-ready/深度/历史拒绝规则。原基于源码形状的断言随重构改为执行真实 down guard / context-menu 片段，覆盖命中、无命中、handoff、history busy 和两种 repaint/普通工具；不是删除原断言语义。完整发布构建、Cloud artifact/两项边界及包体通过（79 chunks / 3,121,981 bytes，19 bytes 余量）；回归总结果另列。代码与截图反馈的“割草机器人”并非同一工程，不将本地面粉袋点涂结果作为该工程提交卡顿已修复的证据。

变更卡 `CHG-20260903-NATIVE-PAINT-EVENT-TAIL`：UI-06 → M03，`ALG-VIEW-INPUT-001` v1.1.0，实施 Codex、体验验收维护者。真实四层点涂 LoAF 每笔 DIV.onpointerup 48.7–56.1ms、DIV.onclick 39.2–46.0ms；核对 installed R3F 分发器，画笔原生 down/move 已独占，但抬笔释放捕获后仍进入递归拾取。本次仅在真实表面命中且画笔接管后登记 canvas/pointer ownership；R3F 跳过同指针 up/click/doubleclick/contextmenu 尾部，原生 final sample、commit/history、相机监听与 DOM 观察器继续运行。下一非活动手势的 down 在 touch/disabled/background 判断前清理，活动笔画的其他指针不抢占；Windows Ink 恢复换 ID 时重新登记。effect 替换保留标记，真正卸载清理；原生 pointercancel/lostpointercapture 与已有 R3F capture 分发不改。

此改动不改变涂抹采样、GPU 上传、CPU/Worker 覆盖、shader/深度/颜色、UV 合成、导出或持久化资产，所有对应消费者保持原语义。分辨率、QA、Schema、Project Command 幂等性、Revision CAS、ownership、verified assets 不变，无迁移；回退仅恢复默认手势尾部拾取及移除 ownership 登记，不删除工程。`test:viewport-wheel-events` 运行实际 R3F/Three 分发：60 笔原生接管笔画的 120 次多余拾取变为 0，覆盖原生 up/click 接收、后续选择/空白选择、canvas/指针隔离、捕获/取消、旧 MouseEvent、effect 重建与下一 down 重置，同时保留 1021→0 wheel 与正交/透视增量回归。真实帧时间另记，不以拾取计数代替端到端验收。

前一材质调度补丁本地实测（index-DlqLu8J0 / EditorPage-i-4vzPD9）：四层回贴记录 57.8 FPS、P95 16.8ms、P99 50.0ms、最大帧 700.7ms、14 个长任务/最大 725.0ms。最长 LoAF 脚本仍为 Three.compileAsync isReady 725.2ms，另有 IMG.onload 126.7ms。它只调整了编译发布顺序，未消除多层编译尖峰；不同空闲间隔/缓存下不将平均 FPS 的变化当因果改善。79 项回归、typecheck、修改文件 lint、完整 build:release、artifact/边界及原包体门禁通过（3,121,936 / 3,122,000 bytes）；远端生成提交/返图、长期多层稳定性未验收。

变更卡 `CHG-20260903-PROJECTED-COMPILE-PUBLICATION`：UI-06/UI-10 → M06，`ALG-PROJ-007` v2.1.2，实施 Codex、体验验收维护者。前一四层回贴记录的长任务位于 R3F render 与 Three.compileAsync；源码核对到非 outline 模型的每次结构编辑也会启动 speculative program warmup，直接纹理路径却没有等待正式材质预编译即挂载到可见 mesh。本次只在 outline 恢复阶段保留抢先预热；编辑现有模型时由正式构建独占预编译，direct 与 array 均在链接后发布，编译前仍等待上传和交互空闲，并加入当前 renderer 已启动的 cold warmup Promise，避免同时轮询同一程序。共享 warmup Map 改为保存 finally 所比较的原 Promise，修复包装 Promise 导致条目永不删除的问题；失败仍按原 catch/终态处理，不永久阻断同签名重试。

此为资源调度 Patch，不改变 shader 源码、CPU/GPU/Worker 算法、纹理上传像素、投影/深度/颜色公式、采样器预算、UV/export 或最终分辨率。SceneRoot 的取消、旧材质保留、层显隐/选择与发布前权威状态检查保留；Project/Layer/Generation/Capture Schema、Project Command 幂等性、Revision CAS、ownership 与 verified assets 不变，无迁移。回退仅恢复 warmup 启动条件、Promise 注册与 direct 预编译等待，不删除用户工程。test:projection-performance-safety 执行实际 effect gate、Promise Map 注册、direct 创建分支和 precompile 函数，覆盖 outline/已恢复/隐藏对象、编译完成前禁止发布、失败/无材质、cold warmup 加入与取消；浏览器帧时间另记，不以构建或模拟顺序通过宣称尖峰已消失。

2026-09-03 本地复测（上述三个未提交补丁合并构建 index-CgLCA5pb / EditorPage-BDb2At7B，基于 bdc33c18，不代表生产发布）：经授权刷新原标签，004_flour_bag / 九模型 / 4K；实际准备诊断由此前 10009.4ms/required=true 变为 0.0ms/required=false，六次回贴点涂后 handoff=ready，作者 mask/falloff 均有有效像素。短回贴录制 57.3 FPS、P95 16.8ms、最大帧 200ms；继续通过正常复制菜单把当前可见重绘叠到四层，再点涂四次并退出，录制 48.2 FPS、P95 16.8ms、P99 66.8ms、最大帧 717.2ms、14 个长任务/最大 672ms，未满足帧稳定验收，不得宣称多层卡顿已解决。此为同源结果复制/回贴压力，不是四次独立远端生图；提交/返图完整流程及长期资源稳定性仍未验收。测试副本/笔画留在当前页面，可用正常历史撤销，不删除用户旧层。

本次 LoAF 最慢样本：737.7ms（其中 R3F FrameRequestCallback 664.8ms），另有 Three.WebGLRenderer.compileAsync 的 isReady 轮询 650.1ms，以及预编译等待帧回调 649.2ms。位置分别为 projectPipeline-Dhpfi0zv.js:字符800465 / 619278、bakeHighSnapshot-Bm1_YOW8.js:字符394834；从构建文本核对为渲染循环、编译完成检查及等待回调，尚无更深层 GPU/CPU 调用栈，不能把 renderDuration 或 s6-publish-deferred-export 阶段标签当作具体 GPU/UV 根因。后续独立问题为多层结构发布后的材质编译/首次呈现尖峰。当前 79 项 Web 回归、typecheck、修改文件 lint（零错误、7 条既有警告）、完整身份参数 build:release、Cloud artifact、Cloud/project repository boundary 与原包体门禁通过：79 chunks / 3,121,868 bytes，距 3,122,000 门禁只余 132 bytes；未改预算、CI 配置、输出分辨率或质量门禁。

变更卡 `CHG-20260903-REPAINT-MERGED-BOUNDARY-WAIT`：UI-06/UI-10 → M08，`ALG-LR-008` v2.4.4，独立修复多层重绘来源切换的无效驻留等待。真实九模型/4K 工程中，004_flour_bag 的顶层为 merged UV，下面有三个旧重绘层；通过正常图层菜单复制一层后，DOM 诊断显示 residentWait=10009.4ms、handoff=pending，并报“上一重绘图层的蒙版尚未完成材质绑定”。SceneRoot 按既有规则排除同对象可见且有资源的 merged UV 以下投影层，但预热/来源交接仍要求这些层驻留。新等待策略与该已有显示边界一致：只对已被此边界排除的目标取消无效等待，退出画笔与切换来源同样核对最新层顺序；仍实际显示的层继续检查真实材质/蒙版绑定、取消和 10 秒失败保护，不以超时伪造完成。

本次不是 UV 合成算法改动，不重排、合并、隐藏或删除用户图层，当前笔刷仍需完成 exact overlay、高清资源与显示就绪检查。GPU shader/投影/深度/颜色、CPU/Worker 像素与 UV/export 消费者不改；旧层 authored mask、live revision、持久化/撤销保留，Project Command 幂等性、Revision CAS、ownership、verified assets、Schema 和输出尺寸不变，无迁移。回退只恢复旧等待判定，不删除工程。回归执行真实预热等待片段与来源交接 ready 回调，并与 SceneRoot 的实际 merged UV 边界函数对照，覆盖隐藏/无资源/其他对象/普通 UV/下方 UV/相同 order/global UV；被覆盖层 10000ms 模拟等待变为 0，正常层仍等待实际绑定。浏览器同场景复测结论单独记录，不把测试时钟当实测。

变更卡 `CHG-20260903-LIVE-TEXTURE-READ-UPLOAD`：UI-06/UI-10 → M06，`ALG-PROJ-007` v2.1.1，实施 Codex、真实多层体验验收维护者。独立于前一 M08 计算优化，本次只修改 liveProjectedCanvasTextureRegistry 的驻留纹理读取：旧 configureTexture 在每次 getter 调用时都置 needsUpdate，导致 loadProjectedTexture、覆盖层复用与材质重绑把未变化的 source/mask 再次标为待上传。参数与 backing 不变的读取现保持 Texture.version / Source.version；显式 register（含同一 Canvas 再注册）、换 backing、markUpdated 和 colorSpace/flipY/wrap/filter/mipmap 变化仍发布。upload:false 只递增持久化 revision，不因随后读取恢复多余上传。

此补丁不减少层数、不静音旧层、不缩小纹理。GPU 仅取消无内容变化的上传标记；CPU 像素、Worker packing/falloff、shader coverage/颜色/深度、UV 与 export 对应路径均不改。审计 imageSampler / layerStackCache 仍按 registry revision 读取原像素，texturedExportUtils 仍导出原 Canvas，EditorPage 仍按 revision 编码并上传验证资产；读操作不改变 revision 或 PNG 缓存。Project Command 幂等性、Revision CAS、ownership、Schema、最终输出与资产不变，无数据迁移。回退只恢复 registry 无条件 needsUpdate，不删除图层/蒙版/Generation。新增 test:live-projected-texture-registry 纳入自动发现回归，执行真实 Three.Texture：8 层 × 3 纹理 × 60 轮读取（含两种 Canvas getter）、显式内容发布、同 Canvas 重注册、backing 替换、参数修正、upload:false、PNG 缓存与 baking/persistence source 契约。原实现新增用例失败，修复后通过；此为上传标记证据，不等于实际 GPU 上传次数或真实卡死根因已全部解决。

`CHG-20260903-LOCAL-REPAINT-INTERACTIVE-COST` 本地验证：78 项 Web 回归、Web typecheck、修改文件 lint（零错误，7 条既有 Viewport 警告）、完整发布身份参数 build:release、Cloud artifact、Cloud/repository boundary、原 web bundle budget 均通过。包体 79 chunks / 3,121,369 bytes，小于 3,122,000 门禁；预算未调整。构建标识 index-Csd_rrty / EditorPage-QltrCc7x，只代表基于 bdc33c18 的本地未提交补丁构建，不代表远端 CI 或生产发布。原项目页面显示 Unsaved，未据隔离测试宣称真实生图/回贴已无卡顿。

变更卡 `CHG-20260903-LOCAL-REPAINT-INTERACTIVE-COST`：UI-05/UI-06/UI-10 → M08，实施 Codex、真实工程体验验收维护者。限定问题为返图 GPU 准备与结果回贴的主线程突发工作；不改 Cloud 后台任务架构或 UV 合成。`ALG-LR-007` v2.2.0 的图像语义不变：内侧羽化以零边界扩展的距离缓冲合并覆盖判定/前扫，取消独立 inside 缓冲，以原整数距离的同公式查表合并后扫/RGBA 输出。正交/对角距离 3/4、0.08 覆盖阈值、6–24px 自适应羽化、smoothstep 和 RGBA 取整全部保持；打包输出先构造 RGBA 字节，兼容主机字节序。作者蒙版 Canvas 首次创建声明 willReadFrequently，适配每个笔刷片段的 CPU 读回，具体浏览器端收益须实测，不据此承诺零 GPU 等待。`ALG-LR-008` v2.4.3：返图颜色、作者蒙版、显示蒙版的三次 initTexture 之间显式让出浏览器帧/任务，并再次检查交互和取消；原空闲检查在空闲时立即完成，不能代替分帧。这里不是减少上传数据，也不伪造真实材质呈现完成；20 秒准备预算、10 秒驻留等待、真实呈现屏障与失败终态不变。

上述变更的输入仍为同 Generation/对象的原始图与作者覆盖，输出仍为同分辨率、同像素的派生 mask 和原资源就绪事件。CPU 实现变化，GPU 材质/shader、Worker falloff/生图输入、capture depth/surface-lock、UV 合成及 export 对应消费者审计后保持不变；作者与派生蒙版独立持久化、历史/撤销、Schema、Project Command 幂等性、Revision CAS、ownership、verified assets 和最终分辨率不变，无数据迁移。回退只恢复羽化实现、Canvas 创建提示及上传间等待；不删除工程/图层/蒙版/生成资产。`test:local-repaint-inward-crossfade` 使用冻结的 bdc33c18 实现逐字节对照 96 组尺寸/图形/羽化宽度、120 组阈值/透明度随机图和整图/dirtyRect Canvas 适配，执行真实 composite 创建；`test:local-repaint-background-scheduling` 执行真实三纹理上传片段，验证分段、两处取消、无 source 与隐藏页兜底。隔离 Node CPU 对照中 1024² 全覆盖中位数 19.26→12.81ms，斜向笔画 10.10→7.44ms；不含 Canvas/GPU/浏览器帧时间，不代表提交/返图/回贴端到端已通过。提交生图阶段本次未修改，真实付费生图和同工程连续回贴仍待验收。

上述预览调度的实测（2026-09-03，index-nvUnMjWl / EditorPage-DyV1qQlL）：经维护者明确授权在 Unsaved 状态按最后保存版本刷新，九模型/4K/贴图工作区，生成与图层面板保持展开，按同一对象顺序各 36 次点击、不进行滚轮或画笔操作。原构建 25.5 FPS / P95 133.3ms / 最大 166.7ms；新版第一轮 45.9 FPS / P95 33.4ms / 最大 600.5ms，第二轮 51.4 FPS / P95 33.4ms / 最大 133.3ms。P95 改善但不判定无卡顿通过：第一轮 598.8ms 脚本落在 bakeHighSnapshot-b3C-6i8s.js 字符位置 88054，映射共享 scheduleAfterBrowserPaint 的定时回调，尚不能据此识别具体下游任务；第二轮仍有 urlToImageData IMG.onload 26–30ms 以及无完整脚本归因的 80–107ms render 段。不能按阶段标签断言 GPU，也不能把第二轮热态最大值代替第一轮长尖峰。78 项 Web 回归、typecheck、修改文件 lint（零错误、8 条既有警告）、完整发布参数 build:release、Cloud artifact 及原包体门禁均通过。此次只处理预览调度，Worker 像素/PNG 与剩余长帧继续分阶段定位，不降低 QA 或输出质量。

变更卡 `CHG-20260903-TEXTURE-PREVIEW-QUEUE`：UI-05/UI-09/UI-11 → M08，`ALG-LR-011` v1.1.0（显示预览消费者调度），实施 Codex、体验验收维护者。原九模型贴图页 36 次切换测得 25.5 FPS、P95 133.3ms、最大 166.7ms；LoAF 151.1ms 中多个 IMG.onload 为 46–56.7ms，定位到图像读取及其后续处理，不据阶段标签归因 GPU。折叠对照因模型恢复自动展开图层面板而无效。本次把 display/capture-mask UI 预览合用串行队列，前台沿用 180ms 交互安静窗口、32ms 任务检查；旧消费者卸载用 AbortSignal 释放，最后消费者退出取消排队与后续阶段，其他消费者仍存活的共享任务保留。运行中的浏览器图像解码不会被强制中断，但迟到结果不缓存、不发布，CPU 后续阶段再检查交互与取消。完成缓存按 source/depth 或 source/mask/contentRevision 识别并按 LRU 更新，最多 64 项 / 32 MiB 编码字符串估算（每字符两字节，含 key），不缓存 ImageData，不淘汰仍有消费者的运行任务；失败不污染缓存。模型归属变化不自动展开图层面板，同模型显式换层仍沿用打开行为。多视图无结果卡、折叠/隐藏的生成面板不启动显示预览；独立预览模态打开时仍可处理，不卸载生成任务/表单。1024 显示上限、颜色/深度/mask/裁切/PNG 像素公式与原图、投影、UV、GPU、Worker/shader、持久化和导出均不变；Schema、Project Command 幂等性、Revision CAS、ownership 与资产不变，无迁移。回退只移除 UI 调度队列和面板可见性/归属保护，不删除工程。`test:display-preview-queue` 覆盖 71 次过期切换零处理、共享取消、运行任务晚到与同 key 重获、27 预览缓存、LRU/字节上限、失败重试、后台无需 rAF 和面板归属；实际预览分派、像素、图层可见性/保留、选中框、typecheck/lint/build 另测。此为第一阶段，未宣称已将像素处理/PNG 移至 Worker，真实新构建帧时间仍须同项目、同样展开面板复测。

2026-09-03 CI 包体修复（M08 / `ALG-LR-011`，M15 验证）：流水线 624621 的构建及 Cloud artifact 检查成功，总 JavaScript 为 3,122,032 字节，超过 3,122,000 字节门禁 32 字节。生成预览分派在排除 undefined 后只有 capture-mask / generated-display 两种模式，移除不可达的 subject-filled 旧回退及其导入，让构建裁剪无消费者的旧预览路径；两种可达处理及源图回退保持不变。算法版本、Schema、GPU/CPU/Worker/shader、投影、持久化及导出语义不变，无数据迁移；回退仅恢复该导入和不可达分支。禁止通过提高预算或关闭质量检查解决本次失败；验证须使用 CI 的完整发布身份参数。本地以完整发布参数执行 build:release、check:cloud-artifact、check:web-bundle-budget，通过 79 chunks / 3,119,610 bytes；test:generation-preview-edge-decontamination 执行实际分派表达式和两条像素处理回归通过。此结果不代表远端新流水线已经通过。

本文档是 LI3D Cloud 当前模块边界、算法语义、调用关系、持久化协议和变更流程的唯一维护准则。日期型审计、旧设计稿和历史 ADR 只能提供背景，若与本文档或基线源码冲突，以基线源码和本文档的明确状态为准。

### 1.1 已彻底废弃的架构

Windows 本地组件、localhost/4618 守护进程、安装器、浏览器端点切换、本地组件持有个人凭证，以及依赖本地组件启动 Photoshop/DCC 的主链路均已废弃。它们不是兼容模式、回退路径或备用部署方式。任何变更不得重新引入这些依赖。

Cloud 发布边界由 `scripts/cloud-boundary-policy.json` 执行机器检查，当前 `legacyAllowlist=[]`。唯一运行时定义在 `apps/web/src/platform/runtimeCapabilities.ts`：`runtimeMode='cloud'`、`isCloudBuild=true`、`hostExtensionFeaturesAvailable=false`。

### 1.2 唯一现行拓扑

```text
浏览器零安装客户端
  ├─ React / Zustand：界面、用例状态、撤销重做
  ├─ Three.js / WebGL2 / WebGPU：视口、投影、UV 合成、蒙版
  ├─ Worker / WASM：图像后处理、质量合成、诊断内核
  └─ 同源 Cookie API
          ↓
LI3D Cloud 控制面（无状态 Node.js App）
  ├─ SSO、Session、ownership、项目命令、Revision、历史、签名 URL
  ├─ PostgreSQL：权威项目文档、不可变 Revision、幂等回执、用户与任务元数据
  └─ 对象存储：模型、参考图、捕获、生成图、图层图像、烘焙图
          ↓
独立生产计算集群
  ├─ AIGC / ModelView：纹理生成与局部生图
  ├─ Asset V4：Auto UV 与自动拓扑
  └─ Substance Worker：生产 PBR Bake
```

浏览器交互图形不发送逐帧命令给 App Server。Auto UV、自动拓扑、生产 PBR Bake 必须使用真实生产服务，不得在服务失败时静默切换为浏览器 xatlas/BVH 模拟结果。浏览器保留的 UV/PBR 内核只用于隔离测试、算法对照和明确标记的实验，不是产品正式默认路径。

## 2. 大模块划分

| ID | 大模块 | 唯一职责 | 主要实现 |
| --- | --- | --- | --- |
| `M01` | Cloud 工程与工作区 | 项目 CRUD、Project Command、Revision、冲突与保存状态 | `workspaceApiClient.ts`、projects routes、ProjectRepository |
| `M02` | 输入与资产 | 模型/参考图接收、格式解析、预处理、直传、ownership | loaders、asset transfer contracts/services |
| `M03` | 场景、相机与捕获 | 对象归一化、相机、Color/Mask/Depth/Normal 捕获 | `engine/scene`、`engine/capture`、viewport |
| `M04` | 生成编排 | 单视图、多视图、提示词智能润色、参考图配对、任务身份、轮询/取消/恢复 | `GeneratePanel.tsx`、generation/modelview clients |
| `M05` | 图层领域 | Layer 类型/角色、顺序、显隐、调整、合并事务 | `types/layer.ts`、`layerStore.ts` |
| `M06` | 实时投影 | 捕获空间重投影、深度/法线门控、Top-3/Overlay 预览 | `engine/projection` |
| `M07` | UV 合成与发布 | UV 栅格、权重合成、后处理、PBR 显示固化、PNG 发布 | `engine/bake`、`engine/layers` |
| `M08` | 局部重绘 | 选择蒙版、效果/白灰几何融合输入、ModelView 四输入、返图直出、表面画笔回贴 | `GeneratePanel`、`localRepaint`、`ViewportCanvas`、`localRepaintGenerationInput.worker` |
| `M09` | 内容识别补缝 | UV 缺口识别、表面拓扑传播、修补 underlay | `engine/contentAware` |
| `M10` | 生产 UV/拓扑/Bake | 真实任务提交、QA、产物验证、Pipeline 交接 | AssetProcessing/Bake workspace、server proxies |
| `M11` | 输出与标准文件集成 | 贴图、GLB/GLTF/FBX/OBJ/STL、快照、视频、ZIP | `engine/export`、server export |
| `M12` | 状态、历史与版本 | Zustand、Engine Session、撤销重做、Pipeline Revision | stores、session、`projectPipeline.ts` |
| `M13` | 身份、任务与平台 | SSO、Cookie、账号隔离、任务历史、遥测、调度 | auth、history、performance、task services |
| `M14` | 数据与对象存储 | PostgreSQL Repository、签名上传/下载、校验与回收 | postgres repositories、assetTransferService |
| `M15` | 质量门禁与发布 | Cloud 边界、契约、回归、构建、CI/CD | scripts、package scripts、GitLab pipeline |

依赖方向固定为 `UI → application/use case → domain algorithm → typed port → infrastructure adapter`。React 页面和 Zustand store 不得新增算法常量；投影、UV、颜色空间和局部重绘的语义必须位于可测试模块。

## 3. 界面模块审计

| UI ID | 界面区域 | 功能与调用模块 | 关键输出 |
| --- | --- | --- | --- |
| `UI-01` | 工程头 | 返回项目、重命名、Saved/Saving/Failed；调用 `M01/M12` | Project Command/Revision |
| `UI-02` | 贴图/UV/烘焙 | 工作流导航；调用 `M10/M12`，不在标签按钮内执行算法 | route + Pipeline stage |
| `UI-03` | 工作区/下载/分辨率 | 场景、贴图、法线、导出、1K/2K/4K/8K | settings + export intent |
| `UI-04` | 对象面板 | 选择、显隐、聚焦、变换、复制、删除、导入、排列 | SceneObject + Project document |
| `UI-05` | 生成面板 | 多视图、单视图、局部重绘与提示词智能润色；提交/恢复任务并创建 Layer | Prompt + Capture + Generation + projected Layer |
| `UI-06` | 中央视口 | Three 场景、实时投影、选择、表面画笔、局部预览 | GPU material/session state |
| `UI-07` | 视口面板 | 透视/正交，Flat/PBR/Normal/Wire，曝光/环境/灯光 | display settings，非源图层 |
| `UI-08` | View Cube/HUD | 固定视角、FPS/P95/最大帧 | camera + telemetry |
| `UI-09` | 图层面板 | 图层增删改排、眼睛、调整、内容修补、剪刀合并 | Layer transaction + merged UV |
| `UI-10` | 底部工具条 | 选择/移动/旋转/缩放；当前图层橡皮；局部选择→局部生图→结果回贴 | paint session + layer coverage/repaint overlay |
| `UI-11` | Dock | 面板过滤、折叠、排序、左右布局 | workspace layout state |
| `UI-12` | 模态任务层 | 导入、兼容编辑、长任务进度/取消、编辑锁 | abort/job state |
| `UI-13` | UV/拓扑页 | 真实 Asset V4 任务、QA 状态、已验证产物下载 | Job + artifact + Pipeline Revision |
| `UI-14` | Bake 页 | 素材、对齐、Substance Bake、检查、PBR、发布 | Bake job + channel manifest |
| `UI-15` | 性能实验室云端记录 | `perfLab=1` 下复用人工录制按钮，显示客户端采集/上传状态；维护员按飞书身份查看记录 | PERF-LAB-REPORT v2 + browser chunks |

`UI-05` 生成面板与 `UI-10` 底部工具条必须共用局部生图运行态：从同步提交锁建立开始，到 Generation 行创建、远端执行与结果融合结束，两个入口都显示运行中。禁止仅以 Generation 行是否存在判定面板按钮状态，因为蒙版/视角捕获发生在该行创建之前。

`UI-03` 导出菜单以文字可用性表达能力：支持项使用普通文字且不附加勾选状态；当前模型、对象、贴图或浏览器不满足导出条件时，条目保留但置灰并通过 title 提供原因，不显示叉号或其他状态图标。此规则只改变菜单呈现，不改变 `ALG-OUT-001`、导出格式、UV 合并、文件编码、权限或下载行为。

`UI-13 → UI-14` 的 UV/烘焙交接只把最新 `uv-model/low-model` 写入 Bake Set 的 `low`；UV 输入的 `high-model/model` 仅保留为 Pipeline 来源证据，不得自动写入或恢复为烘焙高模。烘焙页固定从资产阶段开始，高模由用户显式导入并保存为 Bake 专用 `high/highObject`；若 UV 低模已就绪，手动高模复用该 Bake Set objectId 后进入对齐阶段。历史工程中引用 Pipeline 高模资产的旧自动快照在读取时忽略但不删除；用户曾显式导入且不属于 Pipeline 的高模继续恢复。Project Pipeline、Bake Workspace Schema 与 Revision 协议版本不变，无批量迁移；回退可恢复旧自动高模 hydration，已有低模、高模与历史资产均不得删除。

`UI-14` 一键烘焙的高模、低模与四类材质贴图入口必须让实际 `<input type="file">` 以透明覆盖层直接承接用户指针事件，不得依赖 `display:none` 输入、程序化 `click()` 或 label 转发作为唯一选择入口；专业页按钮优先调用同一用户手势内的 `showPicker()`，仅为旧浏览器保留 `click()` 回退。低模必须与高模共用同一模型解码器和伴随资源解析规则：选择的 GLTF/OBJ/FBX 可同时携带 BIN、MTL 和贴图，文件名立即进入浏览器状态并明确显示解析进度，只有本地解码成功后才可标记为可用并提交后台持久化；失败保留选择和错误提示，不得无提示回滚。解码结果必须在 UV/对齐检查中复用，不得对同一文件重复解码。资产上传与 Bake Workspace 保存随后在后台队列完成；保存错误必须明确显示，也不得在导入回调中提前切换工作阶段。拖放与文件选择必须进入同一导入函数。

`2568e40` 基线的新选择契约：贴图工作区优先显示用户显式选择的模型；所选 ID 缺失时回退到活动模型；点击空白视口不清空贴图模型选择。超过 70,000 三角面的 Auto UV 错误使用醒目的警告呈现。对应测试为 `test:multi-model-restore-policy`。

场景多模型选择性能补丁属于 UI-04/UI-06 → M03，继续沿用 `ALG-IN-003` 的对象身份、并排放置与选择结果，不改变算法语义或版本。空白蒙版/无局部重绘会话时，切换模型不得递增 paint-mask reset revision 或清空、上传 GPU 蒙版目标；每个常驻 ImportedModel 只订阅自身是否选中，未变化模型不得因全局 selectedObjectId 字符串而重跑完整材质组件；对象列表、模型点击与场景清空选择须先登记为视口交互，使既有精确纹理分条上传和后台任务门控在安静窗口内主动让出帧预算。存在作者蒙版、活动画笔或局部重绘 source/preview 时仍执行原有 fail-closed 清理，禁止把会话带到另一模型。投影、UV、PBR、输出分辨率、Project/Layer/Generation/Capture Schema、Revision、ownership 与资产不变，无迁移；回退可恢复无条件 reset revision、全局选择订阅与取消选择交互登记，不删除工程或资产。对应回归为 `test:projection-performance-safety`，真实九模型项目还须记录连续选择的 P95/P99/最大帧与错误数。

高频视口输入路由属于 UI-06 → M03，登记为 `ALG-VIEW-INPUT-001` v1.0.0：滚轮仅由 `BlenderOrbitControls` 的原生被动监听接收并按显示帧累计执行，R3F 的 `onWheel` 分发为空操作，避免对只有点击处理的模型逐原始滚轮包执行递归射线拾取。不调用 preventDefault/stopPropagation，不丢弃物理滚轮增量；R3F 其余点击、空白未命中、hover、指针捕获及原生画笔路径保持原样。新增真实 R3F 分发回归 `test:viewport-wheel-events`，对照 1021 个滚轮包原来产生 1021 次拾取，修复后为 0；透视/正交缩放结果、点击选择、空白未命中和监听清理均须一致。此改动不改变相机公式、GPU/CPU/Worker/shader、投影/UV/画笔覆盖、持久化与导出；分辨率、Schema、Revision、ownership 和资产不变，无迁移。回退仅移除 Canvas 自定义事件路由并恢复默认 R3F wheel 分发；不得删除项目或资产。真实帧稳定性需在相同项目和高频滚轮输入下前后复测，隔离拾取次数测试不代表已消除所有卡顿。

审计卡 `CHG-20260903-VIEWPORT-WHEEL-PICKING`：英文名 Viewport input routing，状态 production；本次实现 Codex，体验验收由仓库维护者执行。输入为 UI-06 DOM WheelEvent（deltaX/deltaY/deltaMode 与原事件保持不变），输出为既有相机距离/zoom 更新，不产生 Layer 或 Project 输出；无新增阈值、颜色空间或矩阵变换，原相机单位/空间沿用 `BlenderOrbitControls` 与 `ALG-CAP-001`。实现仅为 CPU 事件路由 `viewportEvents.ts`，GPU/Worker/shader 无对应新增实现，持久化字段无变更；测试另含 `test:view-cube-orientation`、`test:projection-performance-safety`、`test:multi-model-restore-policy`、Web typecheck/build。迁移与回退见上段。

## 4. 工程保存、Ctrl+S 与数据格式

变更卡 `CHG-20260903-MODEL-SELECTION-RESIDENCY`：UI-04/UI-06 → M03，登记 `ALG-VIEW-SELECT-001`（Model selection resource residency）v1.0.0，状态 production，实施 Codex、真实体验验收由维护者执行。输入为当前对象、工作区、工具所有权和既有 180ms 交互安静状态；输出为相同选中框和相机取景，不改变 `ALG-IN-003` 对象选择语义。场景中每个可见模型保留小型选中框 geometry/material，选择只切换 visible，模型/工作区卸载时释放；相机确认需要重新取景后才遍历 bounds。画笔预热在空闲门控之后才分配 Canvas/RenderTarget，GPU 上传、编译、深度捕获之间再次检查交互与当前模型/工具所有权；过期任务不继续占用 GPU。复用既有 idle 超时和安静阈值，不改变颜色空间、矩阵或分辨率；CPU 仅调整生命周期/调度，GPU 深度与画笔渲染内容、Worker/shader、投影/UV、蒙版/历史、持久化和导出输出不变，Project Command、Revision CAS、Schema、ownership 与资产不变。无需数据迁移；回退恢复选中框按选择挂载、预热的原分配时机和相机 bounds 顺序，不删除工程或资产。回归 `test:model-selection-residency` 执行实际组件/效果代码和真实 Three 资源，覆盖 71 次切换的资源身份/释放、忙时零预热分配、最终模型完整预热、工具变更取消和相机 guard；另跑多模型恢复、取景、投影安全、滚轮、typecheck/build。原人工九模型录制为 52.8 FPS、P95 17.0ms、最大 150.1ms、估算错失 369 帧；该录制未提供具体函数调用栈，不能据此把全部尖峰归因于本次修复，发布体验仍须同项目复测。

多模型驻留补丁真实复测未通过：人工 97 次输入/72 个 wheel，36.6 FPS、P95 100.2ms、最大 600.5ms、9 个 long task/最大 598ms。隔离测试通过不能替代此体验失败，该补丁尚未作为完整卡顿修复验收。随后 M03 的现有只读 HUD 增加最近 120 条 LoAF 中最慢 8 条的时间、脚本文件名与字符位置，人工报告窗口过滤；不新增采样器、不改变 Project 或性能上传 Schema，图片 invoker 不显示完整资产 URL，已有 phase 仅为阶段标签、不能用于函数归因。

变更卡 `CHG-20260903-SELECTION-BOUNDS-OWNERSHIP`：UI-04/UI-06 → M03，`ALG-VIEW-SELECT-001` v1.0.1（Model selection resource residency），状态 production，实施 Codex、体验验收维护者。用户反馈切换后旧模型选中框跳动。实际组件回归证实两条失配路径：frame 回调使用旧 React visible prop；`applyTargetOnlyMaterial` 的恢复器在提交后恢复一次，异步 readback/PNG 完成后的 finally 又重放旧 visible/material 快照，可能覆盖新的选择和材质。输入为当前 selectedObjectId、workspace mode、对象可见性/矩阵和原捕获快照；输出为每个呈现帧仅当前可见场景对象的选中框，捕获恢复恰好一次。常驻框在 useFrame 呈现前直接核对权威选择，未选中直接隐藏，不等待 React 重组件提交；静止帧不重建 bounds 或上传 position，保留资源驻留与 geometry bounds 缓存。恢复器新增单次执行保护，包含失败时 finally 的首次恢复；不增加计时阈值、矩阵/颜色公式或持久状态。`ALG-IN-003` 对象选择语义及 `ALG-CAP-002/003/004/005` 捕获像素算法不变；GPU/CPU 图像、Worker/shader、投影/UV/重绘/导出、分辨率、Schema、Project Command/Revision CAS、ownership 和资产均不变，无迁移。回退仅还原呈现前选择检查与恢复器单次保护，不删除工程或资产。扩展 `test:model-selection-residency` 执行真实组件与真实捕获恢复器，先复现旧代码两项失败，再验证 71 次无 React 重渲染切换、取消选择、工作区切换、空闲无 position 更新、旧捕获不复活边框/不覆盖新材质，以及原资源驻留、预热和取景回归。隔离回归不替代原项目人工视觉与帧稳定性验收。

变更卡 `CHG-20260903-HIDDEN-LAYER-THUMBNAILS`：UI-09 → M08，`ALG-LR-011`（Generated display preview / 生图透明显示副本）v1.0.1，状态 production，实施 Codex、体验验收维护者。本次聚焦隐藏缩略图消费者，不修改 UV 合成。真实九模型场景 36 次列表切换复现 19.6 FPS、P95 133.5ms、最大 150.2ms；148.4ms LoAF 中三个 IMG.onload 分别 24.7/41.3/53.0ms，构建字符位置定位 `urlToImageData` 的 canvas drawImage/getImageData 及其 Promise 后续预览工作。WorkspaceDock 保留 CSS hidden 图层面板，而 LayerThumbnail 在切换对象后仍启动整图/深度读取、透明副本与 PNG 编码，12 项预览缓存会反复淘汰。输入仍为 Layer/source/depth，IntersectionObserver 只控制缩略图消费者是否挂载：真实可见且裁剪交集非零才进入原管线；隐藏、折叠、滚出屏幕时不启动新工作，卸载断开观察且拒绝迟到事件，不改变面板表单/任务状态。已启动共享预览不在本次强制取消；缺少 Observer 时保留原可用性。CPU 图像公式、1024 显示上限、精确 alpha bounds/6% 留白、深度门控和颜色空间原样保留；GPU/Worker/shader、正式 Layer/Generation、投影/UV/导出、最终分辨率、Schema、Project Command/Revision CAS、ownership 与资产无变更，无迁移。回退只移除缩略图可见性边界，不删除缓存资产或工程。回归 `test:layer-thumbnail-visibility` 执行真实组件，覆盖 71 次隐藏切换零消费者、可见恢复、零面积、移出屏幕、卸载迟到与旧浏览器回退；另跑预览像素、图层保留、typecheck/build，真实同路径前后测另行验收。

变更卡 `CHG-20260903-LOCAL-REPAINT-BACKGROUND-WAIT`：UI-05/UI-06 → M08，`ALG-LR-008` v2.4.2，状态 production，实施 Codex、体验验收维护者。代码证据：提交蒙版/视角之前等待两次裸 rAF，返图 GPU prepare 启动及内部步骤也等待裸 rAF；隐藏页面暂停 rAF 时任务可能悬挂。仅将这些非呈现证明的等待接入既有 `waitForBrowserPaint/scheduleAfterBrowserPaint`（前台帧后执行，后台 timer 兜底），取消时解除未启动任务，GPU prepare 不再被后台残留导航 busy 阻断，但未结束画笔仍保持互斥。输入/输出与图像公式、蒙版/深度/颜色、GPU/CPU/Worker/shader、投影/UV/export、20 秒准备预算和原真实 resident 帧交接校验不变。未将 timer 当成实际呈现帧，也不尝试绕过浏览器冻结/丢弃策略：完全 frozen/discarded 时页面仍无法保证计算；远端 Job 和回来后的既有 reconciliation 才是任务恢复基础。本次不修改服务端 Job、Schema、Revision CAS、ownership、资产、分辨率或系统浏览器参数，无数据迁移。回退仅还原这些等待点。回归 `test:local-repaint-background-scheduling` 执行真实共享调度器与提交等待代码，覆盖起始隐藏、等待中隐藏、完全不派发 rAF 仍完成、取消与恰好一次；真实付费生图/后台冻结需维护者验收，不把模拟调度测试宣称为全链路通过。

### 4.1 Ctrl+S 一句话答案

Ctrl+S 保存的是结构化 `Project` JSON 文档及其引用的不可变资产，不是单一 JSON 文件下载，也不是本地组件保存。Cloud 主链路通过版本化 `ProjectCommand` 写入权威 Repository；大二进制先通过签名 URL 进入对象存储。

### 4.2 精确调用链

```text
window keydown
 → shortcutMatches(event, 'project.save')
 → EditorPage.manualSaveHandlerRef
 → flushProjectLayerSync → getProjectSnapshot(refreshThumbnail=false)
 → prepareProjectForWorkspaceSave
      ├─ models/references/captures/generations/layers/baked 分三并发槽持久化
      └─ Project 中只保留稳定资产 URL/ID，不保存 Blob URL 或 File
 → LatestProjectSaveExecutor（正在执行 + 最新待保存快照；同一编辑器串行）
 → workspaceApiClient.saveProject（同 projectId mutation lock）
 → ProjectCommand schema v1 / replace-project-document
      id=command-*，expectedRevisionId=current revision
 → POST /api/projects/:projectId/commands，30s timeout；网络错误用同 ID 重试一次
 → server parseProjectCommand
 → executeProjectCommand（userId:projectId 串行）
 → ProjectRepository.save
 → Revision compare-and-swap + 幂等 command SHA-256
 → PostgreSQL 同事务写当前文档、不可变 Revision、回执与审计
 → 返回新 revision-*；前端仅在快照仍为最新时显示 Saved
```

### 4.3 Project 文档内容

| 字段组 | 结构 | 说明 |
| --- | --- | --- |
| identity | id/name/createdAt/updatedAt/folderId | 项目身份和目录 |
| scene | objects/activeObjectId | 模型、变换、显隐与绑定 |
| input | references | 单/多视图配对、来源和对象绑定 |
| capture | captures | 相机矩阵、Color/Mask/Depth/Normal URL |
| generation | generations | client/server task identity、状态、结果和算法元数据 |
| layer | layers/activeLayerId | 完整 Layer contract 与图层顺序 |
| bake | bakedTextures/bakeWorkspace | UV 结果、Bake Set、通道与 Job |
| workflow | pipeline | texture→retopology→uv→bake 的追加式 Revision |
| settings | resolution/display/projection/color management | 编辑器设置 |
| concurrency | revision/deletedObjectIds | 乐观并发和显式删除意图 |

Cloud 权威实现使用 PostgreSQL JSONB 当前快照和不可变 Revision 表；文件型 Repository 只允许隔离开发，不是生产架构。配置 `LICLICK_PROJECT_REPOSITORY=postgres` 却缺少数据库 URL 时必须启动失败，禁止静默回退。

### 4.4 对象存储协议

`ASSET_TRANSFER_PROTOCOL_VERSION=1`，单资产最大 `160 MiB`。类别固定为 models、references、captures、generations、layers、baked。浏览器计算 SHA-256，请求绑定 user/project/category/filename/MIME/size/hash 的上传意图，使用短期签名 PUT 上传；完成接口通过 HEAD 校验长度、MIME 和 checksum 后把资产从 pending 置为 verified。对象 key 为 `users/<sha256(userId)>/projects/<projectId>/<assetId>/<safe-name>`。下载先校验 ownership，再返回短时签名 GET；访问对象存储时 `credentials: omit`。

### 4.5 浏览器保存调度 `SAVE-SCHEDULER` v1.1.0

编辑器保存调度由独立 `ProjectSaveCoordinator` 负责：普通编辑采用 2 秒 trailing debounce；持续编辑从首个待保存变更起最多等待 10 秒；视口交互、性能只读事务或图层同步抑制期间每 1 秒重试。Ctrl+S、生成/导入等既有即时保存事件仍直接进入同一项目串行保存队列，不等待自动保存窗口。

v1.1.0 合入远端保存优化：`LatestProjectSaveExecutor` 允许正在执行的写入完成，其后只保留最新待保存快照，合并过时请求的等待者；保存前先同步延迟图层编辑再冻结 editVersion，操作序号防止旧回包覆盖当前 Saving/Saved 状态。相同资源按项目/类别/文件名与源 URL 缓存稳定资产地址（最多 512 个槽、每槽 8 项）。Ctrl+S 不再同步读取 WebGL 或编码缩略图，缩略图刷新保留在导航/导入入口。

隔离开发的文件型 Repository 增加用户/项目目录缓存和候选定位，只在旧快照缺少投影图像时修复资产引用；主文档写入成功后，历史 autosave 快照由后台 latest-pending 队列保存，仍保留最多 5 份。此优化不替代生产 PostgreSQL 的不可变 Revision，也不将文件型 Repository 变成生产回退。

每个项目维护不写入 Project JSON 的单调 `editVersion`。获取保存快照时同时冻结该版本；资产上传和 Project Command 完成后，只有当前版本仍等于保存版本，前端才清除 dirty、删除意图并显示 Saved。保存途中发生任何持久编辑时，服务器返回的 Revision 仍被接收用于后续 CAS，但页面保持 Unsaved 并自动提交最新快照。该规则替代仅比较 `updatedAt`、对象 ID 和图层 ID 的旧判断，能够识别同一图层内容、蒙版、显隐或参数变化。

此版本不改变 Project Command v1、Revision CAS、Project/Layer Schema、资产类别、ownership 或对象存储校验；旧工程无需迁移，已保存 Project、Revision 与资产不需要改写。最低回归覆盖 2 秒尾随、10 秒最长等待、过期回包不得清除 dirty、最新回包能够标记 Saved，以及 Web typecheck/build。

仅回退 v1.1.0 时应恢复 v1.0.0 的串行 FIFO、资源持久化和同步备份路径，保留 2 秒尾随、10 秒最长等待与 editVersion CAS 保护，不退回旧快照 ID 启发式；已上传资产与 Revision 无需迁移。

## 5. 图层类型、角色与效果

Layer 的 `type`、`role`、`blendMode`、`visibility policy` 是四个独立维度，禁止用名称字符串代替结构化语义。

| 截图/产品名称 | type | role/识别条件 | 当前效果与合成位置 |
| --- | --- | --- | --- |
| 合并 UV 图层 | `uv` | `merged-uv` | 已发布的最终 UV；`uvMergeVersion=4`；PBR 预览光照已固化，显示时 unlit |
| 投射贴图·方向 | `projected` | 普通生成层 | 捕获相机空间投影；普通层参加 Top-3 质量合成 |
| 单视图投射贴图 | `projected` | 普通生成层；`projectionCoverageMode=capture-mask` | 与多视图进入同一 Top-3 质量合成；capture mask/depth 只限定几何 footprint，不提供顺序优先权 |
| 局部重绘·局部替换 | `projected` | `local-repaint-overlay` 或稳定 ID | literal overlay；alpha 直接等于用户表面画笔 coverage |
| 局部重绘草稿 | `projected/patch` | `local-repaint-draft` | 生成结果与蒙版会话，不应直接当成最终 UV |
| 内容识别修补 | `uv` | `content-aware-underlay` | 只填投影缺口，位于投影结果之下，不能覆盖有效投影 |
| 空白/底色 UV | `uv` | `base-color` 或无 role | 可作为剪刀事务目标；空图像时只是容器 |
| 法线层 | `normal` | channel-specific | 法线显示/输出，不进入 BaseColor 颜色权重 |

数组 index 是界面从上到下顺序，store 每次变更重写连续 `order`。眼睛关闭表示不参加当前显示/合并；opacity 乘最终 coverage；strength 改变角度质量 gamma；blendMode 支持 normal/multiply/screen/overlay/soft-light。移动、调整或替换已烘焙参与层必须标记 `needsRebake=true`。

删除最后一个活动对象图层后，store 自动创建空 UV 保底层。剪刀发布时会隐藏所有实际被消费的源层；若指定空 UV 目标则原位填充，否则在源层位置创建 merged-uv。

### 5.1 当前图层橡皮 `ALG-ERASE-001` v1.3.7

v1.3.7 普通投影蒙版 GPU 存储尺寸修复（M06/M12，协作 M03）：1×1 白色 bootstrap 在首次擦除提交时扩大为所选 UV 分辨率，仅设置 needsUpdate 无法扩容 WebGL2 immutable storage，真实测试报 GL_INVALID_VALUE 并保留旧蒙版。live canvas 注册表记录已配置宽高，在发布、换 backing 或读取发现尺寸改变时只释放旧 GPU 存储，保留共享 Texture/Source、URL 和 canvas 像素，下次上传重建正确尺寸。等尺寸笔触不重建。局部重绘擦除逻辑不变；shader/CPU/Worker/UV/export 像素公式、分辨率、PNG 保存、Schema/CAS/ownership/verified assets 不变，无数据迁移。详见 `CHG-20260909-PROJECTED-ERASER-STORAGE`。

橡皮采用 Modddif 式“编辑当前图层覆盖”语义，不对最终合成画面做破坏性擦除。快捷键为贴图工作区 `E`，目标由 `engine/paint/eraserTargetPolicy.ts` 唯一判定，React 和 Zustand 不得复制类型分支。

| 图层目标 | 编辑数据 | 结果 |
| --- | --- | --- |
| 普通/合并 UV | 当前图层 Straight-RGBA alpha coverage | 擦除后露出下方可见图层；空 UV 不可擦 |
| 普通 projected | UV0 keep mask，`maskSpace='uv'` | 原投影图像、相机、深度/法线不变，只缩小该层投影覆盖 |
| projected/UV 局部重绘 | 已保存的作者 coverage/mask | 保留生成源图与几何授权，只编辑该重绘层的可见范围 |
| content-aware underlay | 只读计算结果 | 必须先显式创建普通 UV 可编辑副本；原 underlay 不变 |
| normal/patch | 无 | fail-closed；normal 禁止颜色橡皮，patch 先合并为 UV |

覆盖公式为 `effectiveCoverage = authoredCoverage × editKeepCoverage`。UV 图层在提交时把 keep coverage 合入该层 alpha；projected 图层把它保存为 UV0 灰度 keep mask；局部重绘沿用独立作者 mask。GPU 实时材质、GPU UV bake、CPU UV rasterizer、UV Worker source-over、图层合并和模型导出都消费同一结果。交互笔画预览可使用 512/1024 代理，但持久遮罩、延迟补缝和输出必须使用项目选择的 1K/2K/4K/8K，不得以旧 2K 上限作为最终结果。

v1.2.0 的交互调度只优化普通 projected keep-mask：原始鼠标/压感笔事件在每个显示帧仅保留最后一个表面命中，512 代理画布用连续笔刷段补齐帧间路径；复用 pointer-down 画布边界，停止逐帧上传仅用于延迟细化的 projection texture。抬笔后等待 48ms 无输入窗口，再让出一个任务执行持久画布、历史瓦片和图层发布，不再等待可能延迟数秒的 requestIdleCallback；切层/切模型时优先完成旧笔画提交，再释放旧 live mask，交接期间不接收新笔画。高分辨率投影补缝仍在 3000ms 交互空闲后运行。普通/合并 UV 橡皮继续使用密集 BVH/UV 重采样，局部重绘作者 coverage、最终分辨率和覆盖公式均不变。

图层显隐操作同步读取 LayerStore 权威状态，不以延迟 React 快照推导下一次眼睛状态；隐藏活动层会退出画笔/橡皮并选择仍可见的图层。清理 projected eraser mask 时同时取消待提交细化、清除 live surface preview 和 GPU eraser uniform，避免清理后残留遮挡。live eraser 纹理不再参与完整投影材质结构签名，工具切换与清理只更新驻留 uniform；晚到材质不能复活已经关闭的 UV 图层。

v1.3.0 历史事务修复（UI-06/UI-10 → M12 历史与画笔集成）：每次抬笔立即占据一个 runtime 历史位置，图像解码和 48ms idle 提交只填充该位置的前后瓦片，不再次入栈或清空 redo。`engine/paint/paintHistoryBoundary.ts` 统一工具栏与快捷键：等待当前手势和已登记的提交，再按请求顺序执行撤回/重做；等待期间仅拒绝新绘制手势，不阻塞浏览器线程。提交失败移除本笔占位；项目历史重置与清理蒙版通过版本检查淘汰晚到提交。

v1.3.1 首笔投影蒙版交接修复：普通 projected 橡皮激活时以 1×1 中性白值预热未来正式 keep-mask 的稳定 live URL，SceneRoot 在内存 live preview 中把该 URL 提前纳入投影结构，但不在用户落笔前修改 Layer/Project。首笔提交把同一 CanvasTexture 扩为项目分辨率并更新像素，LayerStore 发布相同 URL，因此不再触发“无 UV mask → 新 UV mask”的异步纹理数组重建；512 实时 multiplier 在整个交接窗口持续生效。既有外部蒙版在解码后按同一流程提升。覆盖公式、历史、3000ms 补缝、保存资产、GPU/CPU/Worker/UV/export 和 1K/2K/4K/8K 输出均不变。

v1.3.2 投影蒙版显隐交接修复：多投影栈的 `DataArrayTexture` 是 live canvas 的像素快照，稳定 URL 不能单独表示内容变更。纹理数组结构键仅在 array 路径纳入 live keep-mask revision，每次持久提交会取消旧的全白/旧蒙版打包并重新上传当前像素。新数组尚未驻留时，旧材质继续保留累计 live multiplier；新材质原子发布后再清除，因此关闭/重开图层预览不再恢复擦除前的效果。direct sampler 路径仍原地更新 CanvasTexture，不增加重建。覆盖公式、历史、补缝、保存资产、GPU/CPU/Worker/UV/export、分辨率与 Schema 均不变，无迁移。

v1.3.3 投影蒙版统一原子交接修复：A100 项目逐个显示投影行时常为 `useTextureArrays=false`，多行同时显示且采样器吃紧时也可能进入 array；两条路径首次擦除都可能需要异步建立持久 keep-mask。旧输入层 `endLiveEraserPreview()` 会在眼睛/工具切换时抢先清除 GPU live multiplier，绕过 SceneRoot 的驻留检查；本地构建快时该时间窗不明显，A100 恢复项目的解码/材质队列较慢时则会显示未擦除的旧材质。现由 SceneRoot 独占清理权：不区分 direct/array，只要已提交材质结构键尚未匹配当前持久蒙版，所有图层均保留累计实时蒙版；替换材质驻留后再原子清除。已有 direct CanvasTexture 驻留时仍原地更新，不增加重建。覆盖、历史、补缝、持久化、分辨率、Schema 与资产均不变，无迁移。

v1.3.4 投影蒙版纹理级原子交接修复：材质结构键相同只表示 sampler 布局相同，不能证明驻留 uniform 已从旧快照切换到本次全分辨率 CanvasTexture。每次普通 projected 橡皮提交及撤回/重做发布后，直接将同一稳定 live URL 对应的正式 keep-mask 纹理提升到当前对象的全部驻留投影材质；只有 `syncProjectedLayerResidentMaskTextureInObject()` 确认所有材质均已绑定后，才清除 512/1024 实时 multiplier。若眼睛、预览或图层切换发生在 pointer-up 提交完成前，则保留对象 root 与实时 multiplier，最后一个提交成功或失败后再完成交接，避免旧材质短暂回弹；刷新、保存资产、覆盖公式、补缝、分辨率、Schema 与 ownership 不变，无迁移。

v1.3.6 材质重建驻留握手修复：pending commit 归零只证明新蒙版像素已经进入 LayerStore，不能证明多投影纹理数组的新材质已绑定该 mask URL。结束实时橡皮时先尝试把正式纹理提升到当前驻留材质；若可见目标层已保存当前 live mask、但驻留绑定尚未成立，则保留累计 multiplier，并登记对象级 handoff。SceneRoot 发布 `liclick:projected-material-resident` 后重试精确 URL 绑定，成功才清理共享实时预览；跨图层选择在复用单一 live sampler 前同时等待像素提交与该驻留 handoff。隐藏/已删除层不等待，因为其 LayerStore 蒙版在重新显示时是权威来源。覆盖公式、GPU shader、CPU/Worker、补缝、保存、UV/export、分辨率、Schema、Revision、ownership 与资产不变，无迁移。

撤回/重做在同一任务中恢复持久瓦片、将当前及同层重建实例的 live eraser multiplier 重置为白色中性值、上传纹理并 invalidate；保持驻留 shader 结构，重新绑定 image/mask URL 和 contentRevision，随后同步 Project layers。此处中性白值是内部 keep-mask，不是编辑结果中的白模。后台细化仍采用项目原始分辨率和 3000ms idle；`engine/paint/refineStrokeHistory.ts` 从最早瓦片检查点按笔画顺序重放，分别更新每笔的 before/after。已撤回笔画仅更新 redo 检查点，不重新显示；新分支清除不再属于历史的笔画。每四个瓦片让出执行权，完成后无 await 地原子发布全部像素与历史；切换、撤回或新笔画使旧任务失效时不发布半成品。

审计：GPU live 纹理与持久 UV0/alpha 同步恢复；shader、CPU rasterizer、UV Worker、GPU bake 的覆盖公式与 UV/export 消费契约不变。历史事务仅驻留内存，回退只还原提交边界、即时预览复位和逐笔细化实现，已有图层资产仍兼容。新增 `test:paint-history-transactions` 执行真实历史 store/撤回回调和细化函数，覆盖快速三笔撤回重做、按住画笔时撤回、失败占位、项目重置、同层 runtime 重建、重叠擦除/画笔覆盖、新 UV 岛、redo 归属与中途取消；与历史粒度、输入延迟、目标策略、投影显隐和局部重绘兼容回归一起验证。真实模型连续操作及保存重开仍需交互验收，不以数值回归替代视觉结果。

`OBJECT-DELETE-HISTORY` v1.0.0 将模型删除定义为 M12 runtime 历史事务，而不是只保存 Object/Layer 元数据快照。事务在内存中保留被删 Three.js 模型实例，撤回时同步恢复对象顺序、选择、变换、显隐、图层、Generation/Capture、参考图、烘焙产物和 Bake Workspace，并清除该对象的本地删除墓碑；重做重新执行完整删除并登记墓碑。若运行时实例已不可用，UI-04 通过原项目 `sourcePath` 进入渐进式模型恢复兜底。撤回保留删除保存后最新的 Revision CAS token、asset manifest 和 lastSavedAt，禁止把服务端并发状态回滚到删除前。事务只驻留当前会话历史，不改变 Project Schema、对象资产格式、GPU/CPU/Worker/shader、投影/UV/export 或 ownership；旧项目无需迁移，回退后已有项目与 Revision 仍可读取。

新增 `test:object-deletion-history` 真实执行 Project/Scene/Layer/Generation store 的删除→撤回→重做→撤回，验证同一 Three.js 实例即时回到视窗、其余模型被自动排列后恢复原变换、对象子资源和活动选择完整恢复、删除墓碑清除/重建，以及异步删除保存产生的新 CAS Revision 不被旧快照覆盖。浏览器交互验收仍需覆盖底部按钮与 Ctrl+Z 两个入口。

`MODEL-IMPORT-CAMERA-FOCUS` v1.0.0：贴图工作区的用户模型导入在 `setImportedModel` 原子发布后，立即复用 F 键的 DCC 聚焦语义，把轨道中心移动到新导入模型包围盒中心，并将相机平移相同位移；保持当前观察方向、相机距离、投影模式、模型排列和所有对象变换不变。场景、法线和导出工作区继续保留原相机构图，项目恢复和后台模型解码不触发自动聚焦。无 Project/Camera Schema、Revision、资产或 ownership 迁移；回退只移除导入发布后的聚焦调用。

Layer 以可选 `eraserAlgorithmVersion=1` 标记首次采用该语义的内容修订；未带字段的旧图层按原 image/mask 读取，首次擦除时惰性升级，不执行批量迁移。项目保存继续使用 Project Command v1、Revision CAS 与现有 verified layer asset 上传，未引入新的命令或资产类别。高分辨率提交失败时保留上一持久版本并显示错误，禁止静默写入低分辨率结果。

回退时可移除 UI-10 入口、`texture.eraser` 快捷键和目标策略调用；额外字段会被旧代码忽略，已有 image/mask 仍是合法 Layer 资产。内容填补转换创建的是独立 UV 行，因此回退不会修改或删除原 underlay。

## 6. 投影算法登记（关键）

| ALG ID / 名称 | 版本 | 调用者 | 核心定义 | 失败/回退 |
| --- | --- | --- | --- | --- |
| `ALG-PROJ-001` 捕获锁定矩阵重投影 | `2.0.0` | 实时材质、UV bake、画笔 | `clip=Pcap·Vcap·(Mcap·inverse(Mcurrent))·worldCurrent` | 缺矩阵/相机时层不可靠，禁止偷偷用当前相机 |
| `ALG-PROJ-002` 连续 Coverage 门控 | `3.0.0` | projection shaders | 普通层=`opacity×sourceAlpha×mask×angle×visibility×facing×edgeFade`；surface-locked depth 命中层以捕获 mask/depth 覆盖为权威 | coverage≤0.02 丢弃，不用二值膨胀掩盖 |
| `ALG-PROJ-003` 深度-法线表面可见性 | `3.0.0` | preview/GPU UV | linear-view depth + 3×3 支持；surface-locked 深度邻域支持在 0→0.05 内转为完整可见性，可靠 depth 命中不再被插值 mesh normal 二次衰减 | 缺 depth 才走角度退化，不伪造可见性 |
| `ALG-PROJ-004` Top-3 颜色一致性合成 | `3.0.0` | 普通单视图与多视图 | 每个普通投影视角均作为候选；每 texel 保留 score 最高 3 个，按 coverage、depth、angle、edge 与线性 RGB 一致度组合，不依赖图层顺序硬覆盖 | WebGPU parity 不通过使用 CPU exact 输出 |
| `ALG-PROJ-005` 单视图投影适配 | `3.0.0` | single-view layer | 只负责将供应方 RGB 清理为捕获原尺寸的全不透明投影源，并用独立 capture mask/depth 定义 footprint；合成完全委托 `ALG-PROJ-004`，旧 `single-view-priority-v1`/距离场 Alpha 在读取时惰性移除 | 缺 capture mask 时停止安全升级；不恢复 priority source-over |
| `ALG-PROJ-006` Literal Overlay | `2.1.0` | 局部重绘 | authored coverage 直接 source-over；单层直接 mask sampler 支持 resident 交接；实时与常驻有材质片元共用真实相机几何深度，不以前推偏移覆盖外壳 | mask/source 未就绪不发布半层；空诊断面保留原后移规则 |
| `ALG-PROJ-007` GPU 驻留与分块 | `2.1.3` | ProjectedLayerMaterial / SceneRoot / PreviewCompositor | 普通预览与 bulk 在解码/上传期间固定缓存；live 纹理同参数读取不置脏，显式发布/参数变化仍更新；每个 array stripe 上传前解除 PBO 绑定并在 finally 恢复；只对可见工作区当前对象预热，隐藏对象取消未完成 array 构建；array 失败时允许预算内精确 direct stack，否则渐进合成自动退避重试，总尝试最多 4 次 | 保留上一有效材质或合法 UV bootstrap；晚到发布不得复活隐藏 UV；不降低生产 UV 输出尺寸 |

### 6.1 当前生产常量

| 参数 | 当前值 | 语义 |
| --- | ---: | --- |
| 无深度背面硬拒绝 | `N·V < -0.35` | 捕获背面拒绝 |
| 无深度角度覆盖 | `-0.62 → -0.18` | smoothstep feather |
| 有深度角度覆盖 | `0.02 → 0.38` | 使用绝对面向 |
| 深度容差 | `max(0.00625, viewDepth×0.00075)` | 掠射角最多放大 5 倍 |
| 法线一致度 | `0.72 → 0.92` | 捕获法线门控 |
| 图像边缘 | `0.015` | coverage fade |
| 质量边缘 | `0.035` | quality fade |
| quality 角度 | `smoothstep(0.02,0.25,n)×n^(4/clamp(strength,.25,3))` | 强度控制角度锐度 |
| 入选分数 | `max(quality, coverage×0.08)` | coverage 保底 |
| 强质量权重 | `quality^2.4` | 主权重 |
| coverage 残差 | `20%` | 防止低质量完全消失 |
| 胜者比例 | `1.45 → 2.6` | 第一/第二质量比 |
| 胜者差值 | `0.05 → 0.2` | 绝对质量差 |
| 颜色一致 sigma | `0.22` | 线性 RGB 距离抑制 |
| surface-lock 深度支持羽化 | `0.00 → 0.05` | 任一可信 3×3 depth 邻域命中即快速恢复完整覆盖 |
| 投影 RGB 外扩 | `max(8,min(48,maxDim×0.015))` | 只保护过滤采样颜色；几何 footprint 仍由独立 capture mask 决定 |

投影参数的 GPU 实时材质、GPU UV 栅格、Worker/CPU exact 和导出路径必须共同审查。当前缺少持久化 `projectionAlgorithmVersion` 是治理债务；改变上述阈值至少升级 Minor，改变矩阵、深度编码或权重模型升级 Major。

`ALG-PROJ-007` v2.1.0 仅改变 GPU 资源生命周期、失败恢复与权威显示状态，不改变投影矩阵、coverage、深度/法线门控、颜色空间或 UV 合成公式。Worker packing 与 512px stripe 继续保持最终输出尺寸，CPU/GPU UV raster、shader coverage 和导出仍消费相同 image/mask/depth。失败自动重试间隔为 250/500/1000ms；取消、签名变化或成功发布时清理定时器及计数。

## 7. UV 合成与剪刀事务（关键）

### 7.1 完整调用链

```text
UI-09 剪刀
 → 冻结当前对象、选中 Layer IDs、分辨率和 PBR 显示设置
 → 普通 projected：GPU UV0 栅格，生成 RGBA/coverage/quality
 → 仅显式 feathered/literal overlays：按图层顺序单独栅格
 → Top-3 exact quality blend（Worker；WebGPU 必须 parity）
 → content-aware UV underlay 从下方补透明缺口
 → gutter / topology gap / enclosed hole / physical seam reconciliation
 → bakePbrPreviewLightingIntoUv（仅普通 albedo；rendered-color mask 保持原值）
 → Straight-RGBA PNG
 → 对象存储 layers 资产
 → mergeLayersIntoUvLayer 原子发布，uvMergeVersion=4，隐藏被消费源层
 → Project Command 保存文档与 Revision
```

### 7.2 算法登记

| ALG ID / 名称 | 版本 | 精确定义 |
| --- | --- | --- |
| `ALG-UV-001` UV0 三角形投影栅格 | `2.0.0` | GPU 默认把 mesh UV 三角形画入 RT，重建世界位置/法线并复用投影门控；CPU 每 texel 4 子样本是诊断回退 |
| `ALG-UV-002` Runtime 可见性补获 | `2.0.0` | stale/missing depth 按原 capture camera 重新捕获，完整捕获上限 2048，不改变最终 UV 分辨率 |
| `ALG-UV-003` Top-3 质量合成 | `2.0.1` | 与第 6 节常量一致；输出 authored color、coverage confidence、rendered-color mask |
| `ALG-UV-004` 有序 Overlay | `4.0.0` | 仅用户显式 overlay 使用 feathered=`coverage×(0.75+0.25×qualityFade)`；局部重绘 literal=`coverage`。普通单/多视图均先进入 Top-3，不再拥有 priority overlay；实时与 GPU UV bake 同义 |
| `ALG-UV-005` 拓扑约束后处理 | `2.0.3` | gutter/gap=`clamp(ceil(res/512),2,8)`；hole=`clamp(ceil(res/2048),1,3)`；seam=`clamp(ceil(res/1024),2,4)`，不得跨无关 island |
| `ALG-UV-006` Under 合成 | `2.0.0` | 投影在前、content-aware 在下；straight alpha：`Aout=Af+Au(1-Af)` |
| `ALG-UV-007` PBR 预览光照固化 | `4.0.0` | 依据 UV 法线、环境预设、曝光、环境强度、主光强度/方位计算 deterministic preview light；rendered-color 像素权重 1 时保持原色 |
| `ALG-UV-008` Straight-RGBA 发布 | `2.0.0` | RGB 不预乘；透明 texel 的 padding RGB 可保留；PNG 与 Layer 在资产就绪后原子发布 |

`UV_MERGE_COMPOSITION_VERSION=4` 的产品语义是“把当前确定性 PBR 预览光写入最终 UV，并把合并层按 unlit 显示”。它不是生产 Substance 多通道 Bake；只生成当前作者颜色结果。修改此语义必须升级 merge version 并给旧工程迁移/重烘焙策略。

## 8. 局部重绘算法（关键）

### 8.1 主路径状态机

```text
局部选择（多相机表面笔画）
 → 点击局部生图时冻结 square camera + object matrix
 → 同相机捕获 2K flat BaseColor 干净效果图、2K clay-target 白灰几何图和原始 RGB selection mask
 → Worker 从原始 mask 派生双阈值连通、闭运算补断、微小孤岛过滤与小孔填充的合成核，用全不透明核+窄边羽化将 clay 融入效果图
 → ModelView 专用 mask 再从合成核自适应外扩 24–64px@2K 并羽化 4–10px；未修改原始作者 mask
 → 若材质参考是单图，先生成 durable 多视图配对
 → Qwen 只看干净效果图 / 完整多视图 / 未外扩原始 mask；留空先输出一句中文修复要求，再用 Klein 2–3 段模板转换；有用户文字直接转换
 → ModelView 四输入（效果+蒙版内白灰几何融合图 / 材质参考 / 外扩羽化 RGB mask / Qwen 最终 prompt）与 1K linear-view depth guard 并行
 → 远端单张 PNG 直接作为新结果，不再执行浏览器校色或接缝融合
 → 保存 direct result、mask、capture 与工作流版本元数据
 → 用户用表面画笔决定实际回贴 coverage
 → 1024 live GPU overlay；停笔后两帧内先发布完整 projected repaint 图层行
 → “局部重绘”页签始终显示当前 Generation 的完整远端返回图；实际 coverage 只在 3D 视口实时 overlay 与图层预览呈现
 → 3000ms 空闲窗口只用于 latest-wins 后台持久化/自动保存合并，不阻塞图层面板
```

### 8.2 算法登记

| ALG ID / 名称 | 版本 | 输入与规则 |
| --- | --- | --- |
| `ALG-LR-001` 冻结视角选择重投影 | `2.0.0` | 累积多相机表面选择在生成瞬间重投影为 2048 方形 mask；相机/对象矩阵冻结 |
| `ALG-LR-002` ModelView 四业务输入直出 | `3.1.0`；workflow `2026.08.28-cd48a78-truev3-gguf-mask-4input-rseed-r1` | 远端字段固定为必填 2K 效果/白灰几何融合 `image`、必填 `material_image`、必填同尺寸外扩羽化 RGB `mask`与必填 Qwen 解析后 `prompt`；mask 红通道白色可编辑、黑色保留，禁止 alpha-only；不提交 `viewport_reference`、`seed`、`noise_seed`或 workflow 节点参数；返回 PNG 以 `resultComposition=direct-v1` 直接持久化和投影 |
| `ALG-LR-003` 并行深度保护 | `2.0.0` | 1K linear-view depth 与远端请求并行；失败保留生成结果但明确 warning，几何保护降级 |
| `ALG-LR-004` 历史增强边界谐调 | `14.0.0-compatible` | 仅读取/重建旧 v6-v14 Generation 和图层；新 `direct-v1` 任务不调用 |
| `ALG-LR-005` 历史兼容边界谐调 | `5.0.0-compatible` | 仅保留旧 v3-v5 全幅合成与 legacy 切换的读取兼容；新 `direct-v1` 任务不调用 |
| `ALG-LR-006` 表面画笔重投影 | `2.0.0` | raycast 命中表面，投射到 frozen source UV；最小绝对 face-on 0.08；世界半径 0.004-0.12 包围盒比例；texture radius 1-72 |
| `ALG-LR-007` 低延迟实时覆盖 | `2.2.2`（显示所有权以本次源码校正为准） | 当前源码在应用画笔激活时使用 depth-aware exact overlay，同 ID resident twin 临时静音；退出后仍由正式材质按图层顺序显示。新建顶层 preview 在首笔发布前不加入背景栈；位于 priority 层下方的 preview 才提前加入 ordered stack。pointer-down 只消费已准备的资源，pointer-up 保留已有 `contentRevision` 并发布累计蒙版。新生成重绘行直接切换橡皮擦时，仅在 source 与实时 composite 双重证明拥有当前行时沿用热源；冷恢复和历史行切换仍按 `projectionLayerId` 隔离。不改变 source 像素、capture projector、depth/surface-lock、颜色、blend、1024 live 上限或显示所有权 |
| `ALG-LR-008` 延迟投影持久化 | `2.4.5` | interactive UV bake 固定关闭；生图前 Project Command snapshot 后台执行。蒙版工具/生图开始即并行编译并持有 exact overlay 程序，预读作者蒙版；返图颜色缩放与 falloff 并行。内存 Session 按 Generation/目标复用活动任务。高清读取和 GPU 准备有 20 秒预算；仅背景栈已有行进入 resident 等待，单层直接蒙版登记完整、辅助网格排除，交接失败明确结束会话。Session 驱动按钮，DOM 仅诊断；pointer-up 两帧内发布权威图层行，idle 3000ms 仅合并持久化并设置 needsRebake=true；保存前必须把 live canvas 编码上传成 verified asset，runtime URL 不得进入 Project Revision；提交/GPU 准备调度含隐藏页兜底，不替代真实呈现交接；返图三纹理上传之间显式让帧并检查取消 |
| `ALG-LR-009` Inward Crossfade 栈合成 | `1.0.0` | 连续重绘层向内部交叉淡化，避免普通 alpha stacking 在边缘重复显露接缝 |
| `ALG-LR-010` Provider 兼容编辑 | `1.0.0-compat` | `LocalRepaintDialog` 的 image/edit/protect/hole masks 独立路径，不得与四输入主路径混改 |
| `ALG-LR-011` 生图透明显示副本 | `1.2.1` | UI-05 重绘效果图和 UI-10 普通投射图层缩略图优先使用 capture linear-view depth 清除明确无几何覆盖的背景，按逐行首末非零像素计算相同精确 alpha bounds，仅裁切一次并保留 6% 留白；几何覆盖区的 RGB/alpha 原样保留。深度不可用时只清除与画布边缘连通的近黑外背景，不做第二次 matte、侵蚀或分位裁边。局部重绘图层不走整图副本，继续使用用户涂绘 mask，只显示笔刷授权区域；实际可见消费者串行、交互空闲调度，像素阶段跨呈现边界检查取消，支持共享取消与 source/depth/mask/revision 有界 LRU；切模型不强制展开图层面板 |
| `ALG-LR-012` 远端重绘输入融合 | `1.1.0` | 专用 Worker 从原始连续 mask 派生 ModelView 合成核：候选/强核阈值为 24/96，8 邻域保留含强核的连通域，应用 `clamp(0.012×mask短边, 2, 6)px@2K` 闭运算、小于 `max(24px², bbox×0.02%)@2K` 的孤岛过滤和小于 `max(64px², bbox×0.05%)@2K` 的封闭孔填充；`composite=current×(1-a)+clay×a` 使用全不透明核和约 1.5px@2K 窄边羽化。远端 mask 从清理后核再按 `clamp(0.25×核短边, 24, 64)px@2K` 外扩、`clamp(0.2×外扩, 4, 10)px@2K` 羽化。Qwen、Capture、Generation 画笔授权与历史恢复仍使用未外扩、未清理的原始作者 mask |

局部生图远端接收生成阶段的 RGB selection mask，但仍不接收 UV 图集、表面深度或用户最终回贴 coverage。远端 latent mask 不承诺蒙版外像素逐点不变；浏览器继续用同一 `allowedMaskUrl`、capture camera 和 depth guard 限制 3D 写回，用户通过表面画笔决定最终图层 coverage。这些几何授权契约与旧版保持一致。

`ALG-LR-002` v3.1 在 Node 控制面转发前用 Sharp 校验 `image/mask` 尺寸一致且 mask 红通道非空；缺少蒙版、alpha-only/全黑蒙版或尺寸不同均以 422 fail-closed，不进入 GPU 队列。原始作者 mask 与远端外扩 mask 分别持久到 Generation metadata：前者写入 `maskUrl/authoredMaskUrl` 并与 Capture、Qwen、交互画笔及历史恢复绑定，后者只写入 `submittedMaskUrl` 并作为 ModelView 真实提交蒙版。读取双蒙版历史任务时优先使用 `authoredMaskUrl`，没有该字段的旧工程才回退 `maskUrl`。新任务的幂等后缀仍为 `inpaint:4input-rseed-r1`；同一 client generation ID 的网络重放复用键，修改任一输入必须创建新 ID。远端单视图类型已与局部重绘拆分，仍只提交白模与材质参考两张图，不接收 mask。

迁移：Project Command、Revision、Capture/Generation/Layer Schema、对象存储类别与 ownership 均不升级；旧 v5-v14 结果继续使用已持久化 harmonized/raw 元数据，不批量重算。新任务以 `resultComposition=direct-v1`、`rawResultUrl=resultUrl` 识别并直接投影。回退可恢复旧三输入 workflow 与浏览器 harmonization；已保存的 direct PNG 仍是合法 Generation 资产，禁止删除历史图层或改写 Revision。

`ALG-LR-012` v1.1.0 只改变 ModelView 生成输入的派生蒙版：原始作者 mask 仍是编辑意图、Qwen 定位、Capture、Generation 画笔授权、历史和回贴 coverage 的唯一权威来源，不被清理或覆写。清理后核只用于白灰几何融合图与 `submittedMaskUrl`，不使用凸包或包围盒填充，不跨越大于闭运算直径的结构空隙。GPU、shader、UV raster、投影、返图直出、输出分辨率和 export compositor 无变化；Project/Layer/Generation/Capture Schema、Revision、ownership 与已有资产无迁移。回退时只恢复 Worker 使用原始连续蒙版融合并从原始二值核外扩，不删除任何工程数据。

`ALG-LR-007/008` v2.0.2/v2.2.0 与 `ALG-PROJ-007` v2.0.1 不改变投影矩阵、深度编码、face-on 阈值、1024 实时上限、最终 UV 分辨率或颜色合成公式。GPU 继续消费同一 source/mask/depth；CPU、Worker、UV raster、shader 门限与 export compositor 没有算法分叉。生图前 snapshot 与 Generation 最终写回仍进入同一 critical save queue，沿用 Project Command v1、Revision CAS、ownership 与 verified object asset；只把提交前的网络等待移出用户可见关键路径，失败由即时保存恢复。多层恢复的 Worker bitmap 在整组 striped upload 期间固定，缓存上限从 18 调整到 24，并只为当前选中对象预热隐藏 UV 行；其他模型的可见 exact/proxy 仍驻留，不降低图片尺寸或跳过 QA。旧工程无需批量迁移，重开时按现有 Layer/Generation/Capture 字段重建资源。回退可恢复提交前 save barrier、mask URL 严格相等判断、旧 overlay 可见分支和 18 项缓存；已有 projected layer、mask、capture、Generation、对象资产与 Revision 无需删除或改写。

本次连续重绘修复属于 UI-06/UI-10 → M08 显示生命周期：旧 preview 无 revision 不能继续排除已发布行；已发布行在 pointer idle 期间预热，真实拖动、落笔和压力测试仍暂停重任务。source 切换/清空逐帧等待实际模型全部非 overlay 网格的材质绑定包含旧 layerId；最长等待 10 秒，取消或超时保留旧显示，不阻塞主线程、不清空旧图层。异步材质发布读取最新显示所有者，避免晚到任务重新静音旧层。GPU 仅调整驻留和交接顺序，CPU/Worker/shader/UV/export 的像素、蒙版与颜色公式、分辨率均不变；Project Command/Revision、资产和 ownership 无变化，无迁移。回退仅恢复 M08 驻留判定与 source 交接流程，不删除工程或资产。回归覆盖首次发布、跨源切换、部分网格就绪、已释放材质、取消及超时；真实用户工程连续笔画帧率仍需登录现场验证。

`ALG-LR-007` v2.0.5 的视角选择属于 UI-06/UI-10 → M08 的纯展示状态：点击底部选择工具退出绘制并恢复 OrbitControls 输入，同时隐藏红色选择蒙版；`paintMaskDataUrl`、`paintMaskHasContent`、revision、capture 和历史均保持不变。再次进入加/减蒙版画笔会恢复蒙版展示。该 flag 不进入 Zustand preferences、Project、Layer、Generation、Capture、对象存储或 Revision；GPU 只切换已有 mask overlay 的可见性，CPU/Worker/shader/UV/export、投影矩阵、颜色和分辨率没有分叉。旧工程无需迁移；回退只移除按钮与 presentation flag，不删除蒙版或资产。

`ALG-LR-007` v2.0.6 / `ALG-LR-008` v2.2.2 仅修正 UI-05/UI-10 → M08 的连续生图 source 生命周期：生图成功时记录一次性 pending Generation，并用成功 revision 显式触发后台预热。当旧 source 仍占有 renderer 时，只允许与 pending Generation 完全相同的新结果执行一次交接；source 发布或已经驻留后立即消耗 pending 身份，之后的后台扫描继续保护用户主动选中的历史结果。本次不改动 GPU/CPU/Worker/shader、投影矩阵、深度编码、颜色合成、1024 实时上限、最终 UV/export 或 Project/Layer/Generation/Capture Schema，不新增持久字段。旧工程无需迁移或缓存失效；回退时移除 pending Generation 标记和背景 source 决策函数，即恢复旧的不同目标层一律保护分支，无需删除已有图层、蒙版或生成资产。

`ALG-LR-007` v2.0.7 / `ALG-LR-008` v2.2.3 修正 UI-10 → M08 的画笔启用请求生命周期：局部生图成功后，远端完成回调、编辑器任务锁释放和 Generation store 发布结果可能发生在相邻的不同 React 提交中。应用画笔的首次点击若落在这个窗口，不再被底部工具条捕获阶段丢弃，而是登记一个仅驻留内存的一次性请求；按钮立即显示旋转图标和不确定进度条，待任务解锁且结果 ready 后自动重放并进入 `inpaint-apply`。只有局部生成成功过渡可排队，内容识别修补、项目生成和快照准备等其他互斥操作仍 fail-closed；生成失败、切换工程/模型或开始下一次生成会清除请求。本次不改变 GPU/CPU/Worker/shader、投影矩阵、深度编码、颜色合成、1024 实时上限、最终 UV/export、Project/Layer/Generation/Capture Schema、Revision、ownership 或资产，无数据迁移。回退时移除 activation request policy、EditorPage 一次性请求状态、BottomToolDock 排队放行与进度条，即恢复统一交互锁；已有图层、蒙版和 Generation 无需删除或改写。

`ALG-LR-008` v2.2.4 修正 UI-10 → M08 的排队转圈竞态。等待状态从无身份的 boolean 升级为内存中的 Generation/目标层请求；生成完成回调会把过渡期请求升级为确切 Generation，互动 ready/failed 事件仅能更新同一请求，防止上一轮 GPU 晚到事件错误解锁。预载、后台 source 发布和点击激活共用显式 preferred Generation；无 preferred 时按 `completedAt/startedAt` 确定选最新结果，不再依赖数组顺序。后台预热取消、跳过和失败均结束诊断 stage；生图任务已结束且解锁后，8 秒 watchdog 若发现对应 GPU-ready 驻留标记则自愈并自动重放，否则释放转圈并提示重试，不会无限占用画笔按钮。本次不修改图层数组、已有局部重绘显示权、蒙版、GPU shader、CPU/Worker、投影/UV/export、分辨率或 Project/Layer/Generation/Capture Schema、Revision、ownership 与资产，无数据迁移。回退时恢复 boolean 请求、移除 Generation 选择函数与 watchdog 即可；已有图层、蒙版和 Generation 无需删除或改写。

`ALG-LR-008` v2.2.5 取代 v2.2.4 的超时补救，修复 UI-10 → M08 的真实加载链路。浏览器诊断确认：刷新或连续生成后，最新 Generation 已成为候选，但 renderer 仍可能保留上一 Generation 的 GPU-ready 标记；被动恢复 source 因缺少一次性 pending 标记而错误保护旧结果，或最新 source 已写入 Zustand 但其 renderer effect 在发布 ready 前被取消，导致按钮永久等待。新逻辑允许 `autoActivate=false` 的被动恢复 source 被最新 Generation 接管，并增加仅驻留内存的 GPU prepare revision；后台发现“source 身份正确但 GPU-ready 不匹配”或用户点击该 source 时，会立即重启同一 source 的图片解码、蒙版准备、纹理上传和目标层绑定，由精确 Generation/目标层的 ready/failed 事件完成或失败，不再使用计时器释放或伪造成功。实测刷新后后台 Generation 与 GPU-ready 一致，驻留点击路径响应约 7.1ms。已有局部重绘图层、历史蒙版和显示权在 renderer handoff 期间持续保留；不修改 shader、CPU/Worker 算法、投影/UV/export、分辨率、Project/Layer/Generation/Capture Schema、Revision、ownership 或资产，无数据迁移。回退时移除 `localRepaintGpuPrepareRevision`、被动 source 接管分支和显式 prepare 请求，并恢复 v2.2.4 watchdog；已有工程数据无需改写。

`ALG-LR-007` v2.0.8 修正 UI-06 → M08 的双表示显示权：当活动局部重绘上方存在可见的 `single-view-priority-v1` 图层时，专用 GPU overlay 按顺序规则保持隐藏，实时 source/mask 由 ordered projected stack 合成；此时同 ID 的 resident binding 不得再因 renderer preview marker 被静音。只有专用 overlay 实际负责显示时才静音 persisted twin，从而避免笔画已经写入 LayerStore、右侧缩略图已更新，但 overlay 与 resident row 同时透明导致视口无反馈。GPU/CPU/Worker/shader、投影矩阵、coverage、深度编码、颜色合成、1024 实时上限、最终 UV/export、Project/Layer/Generation/Capture Schema、Revision、ownership 与资产均不改变，旧工程无需迁移。回退时仅恢复 resident binding 对 preview ID 的无条件静音；不得删除已有图层、蒙版或生成资产。

`ALG-LR-007` v2.0.9 修正 UI-06 → M08 的实时 mask 所有权：ordered projected stack 使用打包快照，无法在每个指针采样后读取正在变化的 live canvas；因此应用画笔激活期间，无论活动重绘上方是否存在 `single-view-priority-v1`，均由专用 GPU overlay 临时接管反馈，并在同一状态提交中静音同 ID resident binding。离开应用画笔或刷新恢复后仍由 ordered stack 按原图层顺序显示持久结果。此变更不改 source/mask 内容、投影矩阵、coverage、深度编码、颜色公式、1024 上限、CPU/Worker/shader、UV/export、Project/Layer/Generation/Capture Schema、Revision、ownership 或资产，无数据迁移。回退时移除 live feedback 对专用 overlay 的强制接管即可；已有图层、蒙版和生成资产无需删除。

`ALG-LR-007` v2.1.0 修正 UI-06 → M08 的当前层二次编辑和异步质量交接：复杂 depth-aware GPU overlay 在部分真实工程中可完成绑定但被 capture visibility 全部裁为透明；旧流程仍立即静音同 ID persisted twin，因而当前层旧笔画与新笔画同时消失，只有等待 ordered stack 重打包后手动开关预览才恢复。新流程在预热阶段创建 renderer-only 简化 mesh preview，每个有效采样只上传最大 1024 的 inward-crossfade live mask，并以同一 capture projector matrix 采样生成 source；它不读取 depth/normal，不参与持久 Layer、缩略图、UV 或 export，只保证编辑时的即时近似反馈。SceneRoot 将可见 projected 层的 `contentRevision` 纳入展示失效签名，pointer-up 发布后自动触发正式材质重建；离开应用画笔时逐帧确认当前 layerId 已进入真实背景材质，再关闭简化 preview 并解除同 ID resident 静音。静音门禁限定为“快速 preview 实际可见或 ordered stack 明确接管”，未就绪、eye-off、取消或 10 秒超时继续显示当前正式层；其他局部重绘 layerId 不变。最终 source、作者 mask、capture depth、`surface-locked-v1`、coverage/颜色公式、1024 live 上限、最终分辨率、CPU/Worker/UV/export、Project/Layer/Generation/Capture Schema、Revision、ownership 和资产均不改变，无数据迁移。回退时移除 `liveLocalRepaintFastPreview`、恢复 v2.0.9 的专用 overlay 所有权，并移除 projected contentRevision 展示失效通知；不得删除已有图层、蒙版、Generation 或资产。回归覆盖当前层二次进入、未就绪不静音、只静音同 ID twin、快速/复杂 twin 不并绘、正式层驻留后自动交接和 contentRevision 重建；真实浏览器已验证再次进入时快速 preview ready/visible 且复杂 overlay hidden。

`ALG-LR-007` v2.1.1 修正 UI-06 → M08/M06 的实时 coverage 所有权。v2.1.0 的无深度快速 mesh 与正式 surface-locked 图层同时存在，重进画笔时会先静音正式行；快速 mesh 又缺少 capture depth/normal 门控，因此可能出现当前层旧笔画消失、live 笔画无反馈或深红色投影块。新流程删除该 duplicate mesh：已有正式行保持可见，并在其共享 projected shader 内将预留 live sampler 精确绑定到当前 layerId，使用 capture/projector UV 直接替换该行打包 mask；其他图层、resident source、depth/normal/surface-lock、inward crossfade、图层顺序和颜色运算均不变。mask texture 与 layer binding 未变化时不重复 invalidate；离开工具只在正式行仍驻留后清除 override。首次尚无持久行时保留原 depth-aware exact overlay，发布后按 layerId 交接。SceneRoot 只有在当前工具真实拥有预览显示权时才允许静音 resident row，晚到 marker 不能隐藏正式层。本次只改变 GPU shader uniform 绑定与视口生命周期；CPU/Worker/UV/export、1024 live 上限、最终分辨率、Project/Layer/Generation/Capture Schema、Project Command/Revision、ownership 和资产均不改变，无数据迁移。回退可关闭 projection-space override 并恢复 v2.0.9 的 exact overlay 接管，不应恢复 v2.1.0 的无深度快速 mesh；已有图层、蒙版、Generation 和资产无需删除或改写。回归覆盖正式行绑定、仅当前 layerId mask 替换、新行 exact overlay、退出交接、无 duplicate mesh 与晚到静音门禁；真实浏览器验证进入局部重绘和切换画笔时当前层持续可见、override 已绑定、无深红块。

`ALG-LR-007` v2.1.2 修正 UI-06 → M08/M06 的首笔发布热路径。旧实现 pointer-up 立即把 renderer exact overlay 判为非所有者，并把持久 mask URL、`contentRevision` 等结构字段写回 LayerStore；正式 projected material 尚未包含该行时会先出现空白帧，URL/sampler 或 revision 变化又会触发完整投影栈重建。新实现以“材质已驻留且 live override 已绑定”取代“LayerStore 已存在该行”的交接条件：SceneRoot 在最终材质挂载后发出驻留通知，视口先解除 preview marker 对 resident row 的静音，保留 exact overlay 覆盖一个完整呈现帧，再在下一帧撤下 overlay。已保存行在画笔预热进度阶段把持久 mask 复制到稳定 live raw/blend canvas URL，落笔后地址不再变化；交互提交保留原 `contentRevision`，项目保存仍按 live registry revision 将 raw/blend mask 转为验证资产。GPU 只改变 URL 切换时机、uniform 绑定和两帧显示屏障；CPU/Worker/shader coverage、投影矩阵、depth/surface-lock、UV raster、最终分辨率与 export compositor 不变。Project/Layer/Generation/Capture Schema、Project Command/Revision、ownership 和资产类别不升级，旧工程在首次进入画笔时惰性提升，无批量迁移。回退可恢复 pointer-up URL 切换、revision 递增和 `hasPersistedLayer` 交接判定；不得删除已保存蒙版、Generation、Layer 或资产。回归与浏览器验收必须证明预热后首笔前后 `projectedMaterialBuildRevision` 不变、结构差异为空、override 持续绑定且测试笔画可撤销。

`ALG-LR-007` v2.1.3 修正 UI-06 → M08 的实时显示权冲突。策略层原本已规定 `inpaint-apply` 时专用 overlay 接管，但视口生命周期仍会在 resident live-mask override 已绑定时隐藏 overlay，并清除已持久层的 preview owner，导致 live canvas 正常更新而视口继续显示旧打包 mask。新逻辑让应用画笔激活态无条件优先于 resident override：depth-aware exact overlay 保持可见，SceneRoot 仅静音同 ID resident twin；其他历史局部重绘层、普通投影层和 UV 层继续按原顺序显示。退出画笔、切层或切换 Generation 后才允许 resident row 接管，并沿用一帧呈现加两帧屏障撤下 overlay。该修复不修改作者 mask、source、capture depth、surface-lock、投影/颜色公式、1024 live 上限、CPU/Worker/shader/UV/export、最终分辨率、Project/Layer/Generation/Capture Schema、Revision、ownership 或资产，无数据迁移。回退时恢复 resident override 对 overlay 的优先隐藏及已持久层 preview owner 清理分支；已有图层、蒙版和 Generation 无需删除或改写。

`ALG-LR-007` v2.1.4 / `ALG-LR-008` v2.2.6 合并 UI-10 → M08 的远端性能优化与 UI-06 的实时显示权修复。Generation 成功后在当前 effect 的 microtask 立即启动 generation-scoped 后台解码、目标绑定与 GPU 预热；Viewport 通过只驻留内存的 `preparing/ready/failed` 事件发布交互状态，画笔请求必须同时等待 Generation ready 与 GPU interactive ready，成功后自动重放，失败则终止排队并显示明确错误。旧的逐帧 `requestAnimationFrame` 轮询与额外 timer task 被移除；应用画笔激活期间 exact overlay 继续独占当前编辑层的实时显示，同 ID resident twin 临时静音，其他历史图层持续可见，退出后按原子屏障交接。该合并不改变作者/远端 mask、GPU/CPU/Worker/shader coverage、投影矩阵、depth/surface-lock、颜色、UV/export、最终分辨率、Schema、Revision、ownership 或资产；无迁移。回退应分别恢复事件握手前的调度和 overlay 显示权分支，不得删除 Generation、图层或蒙版。`test:local-repaint-performance-merge` 必须锁定事件握手、microtask 启动、GPU ready 后重放及无 rAF 轮询。

`ALG-LR-007` v2.2.0 / `ALG-LR-008` v2.3.0 将 UI-06/UI-10 → M08 的加载、显示与输入收敛为单一会话和单一显示所有权。`LocalRepaintSession` 是唯一业务状态源，sessionId 防止旧 Generation 的异步完成回写当前任务；DOM dataset 降为诊断。共享 projected material 始终拥有局部重绘显示权，live preview 按同 layerId 合并进 resident stack，正式材质绑定和至少一帧验证成功后才进入 ready；pointer-down 不再补资源或触发 GPU prepare。所有等待均有明确终态，总准备上限 20 秒、正式材质绑定上限 10 秒，失败释放旋转并允许重试。此次不改变作者/远端 mask、投影矩阵、depth/surface-lock、coverage/颜色公式、1024 live 上限、CPU/Worker/UV/export、最终分辨率、Project/Layer/Generation/Capture Schema、Revision、ownership 或资产，无数据迁移。回退可恢复 v2.1.4/v2.2.6 的 dedicated overlay 与事件/DOM 握手；不得删除已有 Generation、图层或蒙版。

UI-05/UI-13 的贴图驻留边界要求所有挂到页面根节点的生成面板 Portal 同样受 `EditorPage.isActive` 门禁。进入 UV 时贴图编辑器可继续保留引擎与面板状态，但“局部生图”固定按钮、生成取消确认和结果大图预览均不得越过隐藏工作区显示；回到贴图页后按原状态恢复。此修复仅改变 React 展示生命周期，不改变局部生成算法版本、任务状态、GPU/CPU/Worker/shader、输入蒙版、Project/Layer/Generation/Capture Schema、对象资产或 Revision，无数据迁移；回退只移除 Portal 活跃态门禁。

`ALG-LR-011` 只生成最大 1024 的内存 UI 显示副本，不回写 `Layer.imageUrl`、Generation、对象存储或 Project Revision。GPU/CPU/Worker/shader、投影矩阵、UV raster、持久化与 export compositor 均继续消费原始 source/mask/depth，因此无需数据迁移。回滚只需移除 UI-05/UI-10 显示副本调用；已有图层与资产不变。测试必须证明透明显示不替换投影源、黑色材质与几何边缘不被扣除、普通投射层不再出现黑底、局部重绘层仍仅显示用户涂绘区域。

`ALG-LR-008` v2.3.1（UI-10/UI-06 → M08，CHG-20260903-LOCAL-REPAINT-PREWARM-LATENCY）修复按钮 3 的无效 resident 等待与重复预热。源码审计发现历史 v2.2.0/v2.3.0 的“仅共享材质、全流程 20 秒”描述与当前实现不一致：`shouldUseDedicatedLocalRepaintOverlay` 仍在 apply 时返回 true，`getOrderedLocalRepaintPreviewLayer` 仍只接纳 priority 下方的 preview；本次没有重新引入或切换显示架构。新建顶层结果没有可绑定的 resident row，旧循环必定耗尽 10 秒后才创建 exact overlay。新策略与实际背景栈准入条件一致，已发布图层/ordered preview 保留原等待，新建顶层跳过无效等待，但所有路径仍执行原高清资源、作者蒙版、depth 与 exact overlay 编译检查。点击同一 Generation/目标时复用真实活动任务；effect 清理、成功和失败均释放登记，残留 preparing 快照不阻止重试。

GPU 仅改变准备条件与调度；CPU、Worker、shader、投影/UV/export 仍消费相同 source/mask/depth，颜色、几何授权与最终分辨率不变。无持久字段或 Schema 升级，Project Command、Revision CAS、ownership、verified assets 与历史图层不变，无迁移。回退只恢复无条件 resident 等待和点击重启准备，并移除任务登记；不得删除资产。模拟时钟运行实际 viewport 等待代码，验证新建顶层等待为 0、已发布行/ordered preview 等待真实绑定、10 秒边界仍保留；会话测试覆盖复用、重叠阶段、取消、失败及旧清理不影响新任务。真实浏览器端到端耗时/首笔效果待有项目页面时验收，不以模拟结果声明实际 GPU 提速。

## 9. 内容识别补缝

| ALG ID / 名称 | 版本 | 定义 |
| --- | --- | --- |
| `ALG-CA-001` 覆盖缺口检测 | `1.0.0` | 从投影 coverage/confidence 构造待修复 mask，排除已有可靠投影 |
| `ALG-CA-002` UV 表面拓扑 | `1.0.0` | UV 三角形 region、可选物理 seam link、normal dot 门限；预热并缓存 |
| `ALG-CA-003` 表面约束传播 | `1.0.0` | Worker 在同一表面/region 内传播颜色，不跨无关 UV island |
| `ALG-CA-004` Underlay 原子发布 | `1.0.0` | 生成 `uv + content-aware-underlay`，GPU 预热后一次发布，合并时永远在投影之下 |

本地兼容填充的搜索半径为 `clamp(ceil(max(ROI.w,ROI.h)×0.2),16,48)`，迭代 2 次；它不能冒充远端生成或覆盖有效投影颜色。

## 10. 生产 Auto UV、拓扑与 PBR Bake

| 流程 | 正式算法/服务 | 输入 | 产物与门禁 |
| --- | --- | --- | --- |
| Auto UV | Asset V4 `uv.production-service` | 模型资产 + 参数 | 可轮询 Job、UV 模型/报告；严格 UV QA 失败不得发布 |
| 自动拓扑 | Asset V4 `RETOPOLOGY_PROCESS_V2` | 高模 + mixed_game_ready metadata | final FBX/GLB、诊断产物；坐标/质量门禁失败不得标成功 |
| PBR Bake | Substance Worker `bake.production-substance` | high/low/cage/color + BakeDraftSettings | BaseColor、Normal、AO、Curvature、WorldNormal、Thickness、Position，可选 Roughness/Metallic |

任务必须支持 Job ID、queued/running/cancelling/succeeded/failed/cancelled、真实进度、Worker ID、账号历史、取消、恢复和已验证 artifact。服务不可用时 UI 阻断并显示真实错误。浏览器 local UV/PBR 测试内核不得成为正式 fallback。

Bake 设置包含 resolution、frontal/rear distance、distance/cage、cage inflation、always/by-name、sampling、padding、DirectX/OpenGL、GPU/CPU、UDIM、hit strategy、ignore backfaces、dehighlight 和 enabledChannels。输出进入对象存储并追加 Pipeline bake Revision。

## 11. 输入、捕获、生成与输出算法

| ALG ID | 名称 | 当前规则 |
| --- | --- | --- |
| `ALG-IN-001` 格式路由导入 | GLB/GLTF 正式，FBX/OBJ 兼容；按扩展名/loader 解析为统一 LoadedModel |
| `ALG-IN-002` 模型归一化 | 通过父 Group 居中、落地、适配相机，不改 mesh 原始顶点 |
| `ALG-IN-003` 多模型放置 | 按已有场景包围盒并排放置，保留独立 objectId 与 transform |
| `ALG-VIEW-INPUT-001` 视口输入路由 v1.1.0 | 滚轮交给原生相机控制器按帧累计；画笔接管的手势尾部不重复拾取，普通选择/hover/捕获保持原分发 |
| `ALG-VIEW-SELECT-001` 多模型选择资源驻留 v1.0.4 | 选择框复用且每帧核对当前对象，不依赖旧 React 选择；捕获恢复恰好一次；仅真实取景计算 bounds；预热复制跳过应用元数据，保留 Three 子类/几何/材质状态；按 renderer 串行选择预热，跳过过期排队任务，保留模型/工具所有权与交互门控及全部 GPU 阶段 |
| `ALG-CAP-001` 相机序列化 | position/quaternion/target/near/far/fov/zoom/P/V/world/aspect 完整保存 |
| `ALG-CAP-002` Color 捕获 | 线性 RT + 输出变换；viewport/clay/target-only/flat 明确区分 |
| `ALG-CAP-003` Mask 捕获 | 目标白色 BasicMaterial、黑背景；灰度×alpha 作为连续 mask |
| `ALG-CAP-004` Depth 捕获 | `(-viewZ-near)/(far-near)` linear-view，RGB packing，alpha=1 |
| `ALG-CAP-005` Normal 捕获 | 默认 view normal，编码 `n×0.5+0.5` |
| `ALG-CAP-006` 捕获状态隔离 v1.0.0 | 首次及逐 tile/pass 的 await 前归还共享 renderer/背景；每个同步 draw 重绑捕获 target/clear，保留像素与分辨率 |
| `CAPTURE-MATERIAL-ISOLATION` v1.0.0 | flat 材质/uniforms 仅在每个同步 tile draw 内借用，逐 tile 恢复；材质身份变化拒绝混合截图，已有纹理在 clay 展示前冻结 |
| `ALG-GEN-001` 单视图生成 | `1.2.0`；当前相机 Capture + 材质参考 → Generation；GPT2 初始白模与已有贴图补全共用图一几何锁定/图二材质参考模板；结果先生成原捕获尺寸的边缘去污染投影源，再与独立 capture mask/depth 一起创建普通质量合成 projected layer |
| `ALG-GEN-002` 多视图批次 | `1.2.0`；N 个捕获共享 batch；GPT2 与单视图共用同一材质补全模板；完成层串行 commit，整批结束一次发布新投影栈 |
| `ALG-GEN-003` 任务身份归一 | clientGenerationId/serverJobId/taskId 合并，避免恢复时重复 running 行 |
| `ALG-GEN-004` ModelView 远端单视图 | `1.1.0`；当前视角白模 + 多视图材质参考 + 可选提示词 → `modelview-single-view` → Generation；结果使用 `ALG-PROJ-005` v3 捕获适配并进入统一质量合成 |
| `ALG-GEN-005` 提示词智能润色 | `1.10.0`；UI-05 经同源 `/api/liclick/prompt-polish` 分流。普通单/多视图保持莉刻 `data-analysis` A2A；局部重绘空输入由 `qwen3-vl-plus` 在一次请求中输出诊断和英文正文，诊断与正文分别校验；显式输入跳过诊断，保持统一 Qwen → Klein 转换模板。服务端用未外扩原始 mask 定位，并从干净 Image 1 自动裁出带上下文的第四图供 Qwen 看清选中部件；完整参考图仍只提供有证据的结构/材质，第四图不改变编辑范围或 ModelView 输入。模板先用 Image 2、第四图和 mask 外邻域共同确定真实结构与材质；仅当三者证明选区为未完成的白灰占位时，要求 Klein 用明确目标材质完整替换 clay/primer/flat placeholder/untextured surface，真实浅色材质不受此规则影响。模板以 100–180 词、2–3 段英文为生成目标；段数、词数、语言和 Markdown 偏差只记脱敏告警，不阻断也不触发格式修正。若首段缺少明确 mask 范围，服务端确定性追加固定保护句。仅最终正文写入 Generation，诊断不持久化、不回填文本框；显式输入与空输入均一次 Qwen，保持 65 秒 deadline。模板策略进入所有局部重绘指纹，升级后首次重新解析、后续继续复用 |
| `ALG-GEN-006` 混合远端多视图串行生成 | `1.1.0`；预览数组即执行顺序，普通视角 ModelView、极向顶/底视角 GPT2；静态 Capture 预捕获，当前材质逐视角即时捕获；完全覆盖跳过、部分覆盖用现有外扩补全蒙版；每张返图投影驻留后才继续，末尾一次内容填补 |
| `ALG-OUT-001` 纹理/模型导出 | BaseColor 与 GLB/GLTF/FBX/OBJ/STL/ZIP；验证 UV 方向和颜色空间 |
| `ALG-OUT-002` 快照/转台 | 当前视口设置生成静态图或视频，不改变 Layer 作者数据 |

### 11.1 单/多视图双提供方契约

- UI：`UI-05` 的单视图与多视图都显示 `GPT2 / 远端` 切换；默认保持 `GPT2`，局部重绘不受此选择影响。
- 模块：`M04` 生成编排；远端适配由同源 `/api/modelview/single-view` 进入 Node 控制面，浏览器不得直接持有 API Key 或跳过局域网 TLS 校验。
- GPT2 输入与行为：单视图初始白模、已有贴图补全及多视图统一使用 `textureMapPrompts.ts` 的材质补全模板；图一锁定全部几何、视图与排版，图二只提供白模内部的特有材质外观。继续使用 LiClick/Atlas 任务提交、轮询、取消和投影流程。
- 远端输入：必填当前视角 clay 白模 `image`、已选多视图材质参考 `material_image`；`prompt` 可空且最长 4096 字符；禁止发送 mask、seed、noise_seed、模型名、采样步数或工作流节点参数。
- 远端身份：每次新生成使用新的 client generation ID，并派生独立 `Idempotency-Key`；网络层重放同一请求必须复用该键。
- 远端输出：同步 PNG 先写入当前项目 generations 资产，再创建 `workflow=texture-map`、`provider=modelview-single-view` 的 Generation；GPT2 与远端都必须用同一 capture camera/mask/depth 和 `ALG-PROJ-005` v3 创建普通质量合成图层，供应方差异不得改变投影几何。
- 工作流：`modelview-single-view`，生产版本 `2026.08.26-c0e6218-single-view-4step-r1`，与局部重绘 `modelview-inpaint` 分开排队和审计。
- 失败与回退：远端失败只标记本次 Generation 失败并显示真实错误，不自动改走 GPT2；用户可显式切回 GPT2 重新生成。远端为非默认、非持久化界面选择，旧工程无需迁移。
- 回滚：移除单视图远端 UI 分支和同源路由即可；已有远端 Generation/Layer 继续按普通单视图质量层读取，不需要删除资产或改写 Project Revision。
- 远端多视图：不使用 batch 并发，按 `ALG-GEN-006` 逐视角提交；普通视角使用 ModelView 单视图/补全端点，极向顶/底视角使用 GPT2 单视图端点，上一结果投影驻留是下一请求的前置条件。
- 测试：`test:single-view-priority` 必须覆盖双提供方分流与投影语义；`smoke:modelview-inpaint` 同时验证两条 ModelView URL、multipart 字段、幂等键、X-Job-ID 和 PNG 持久化。

### 11.1.1 同源开发工作区资产兼容

远端 `e866612` 的资产修复仅适用于页面与 workspace API 同源且主机是 loopback 的隔离开发环境（4517）：已持久的 `/workspace` 资产直接复用，Blob 通过带认证的同源上传服务保存，不先尝试不存在的对象存储 upload-intent。普通生产 Cloud 继续走签名上传、ownership、checksum 与 verified assets；不得新增 localhost/4618 守护组件、安装器、凭证托管或端点切换。此修复让既有多视图结果保存/自动投影正常推进，不改变 Qwen 或 ModelView 输入契约。

### 11.2 单视图投影源、迁移与回退

- 面板返回图与投影源分离：面板可使用裁切显示副本；投影源保持捕获原尺寸，避免改变 projector UV。capture mask/depth 是几何 footprint 权威，供应方 PNG Alpha 不参与单视图覆盖判断。
- 生成结果轮廓依据 capture mask 从主体内部回拉 RGB，再把清理后的 RGB 向 mask 外扩散；源图保持全不透明，外扩像素不会扩大独立 capture mask 限定的几何覆盖。
- 所有新建普通单视图和多视图均进入 `ALG-PROJ-004` v3 Top-3 质量合成；普通投影图层顺序只用于面板组织，不作为硬覆盖优先级。局部重绘、显式 Overlay 与 UV 层仍保留作者层级语义。
- 迁移：读取旧 `single-view-priority-v1` 或历史“投射贴图 · 当前视角”行时，惰性清除 priority 标记、surface-lock 和距离场 source-alpha，改为 `projectionCoverageMode=capture-mask`、`ignoreSourceAlpha=true`、standard visibility；不批量改写历史 Revision 或图片资产。
- 回退：代码可恢复旧合成分支，但不得删除或改写现有 Generation、Capture、Layer、mask/depth 资产；新版保存的普通质量层可被旧版作为普通 projected layer 读取。

### 11.3 提示词智能润色 `ALG-GEN-005` v1.10.0

2026-09-03 更新：空提示词的诊断与英文转换合并为一次四图 Qwen 请求，返回 diagnosis/prompt 两个字段。仍先校验一句中文诊断，再校验并提取英文正文；只保存正文，输入框保持为空。保留蒙版范围、材料证据、文字证据、异常结束和超时检查。显式输入仍一次纯文本请求。空输入策略指纹升级 `single-request-diagnosis-to-klein-v3`，旧缓存首次失效，无持久字段迁移。此前两次调用的历史说明由本段取代。回退服务请求和策略常量即可，无需修改 Generation/Revision/资产。详见 CHG-20260903-LOCAL-REPAINT-ANALYSIS-LATENCY。

- UI 与触发：普通生成仍保留手动智能润色图标。局部生成有用户输入时直接进入 Klein 模板转换；留空（包括纯空白）在同一次四图请求中完成诊断与转换。诊断限定蒙版内人工接缝、突兀色差、纹理断裂、重影、投影重复/拉伸/错位及已有文字的重复、扭曲、缺笔或错位。真实面板接缝、焊缝、开口、零件边界与正常明暗必须保留，不新增部件、改整体配色或重设几何；文字拼写只采用原图/对应参考中清楚可辨的证据，不猜测品牌。最终英文结果才写入 Generation.prompt 和既有 metadata，诊断句只作服务端中间值，用户文本框保持原文。
- 一句话诊断：一次四图请求同时返回 JSON 对象中的 diagnosis/prompt 字符串。diagnosis 为 4–120 字符、以“修复”开头的一句中文要求，允许逗号合并确定问题；无明确缺陷时固定返回“未发现明确异常，保留现有外观。”。自动请求使用 max_tokens=4096、temperature=0.2；空值、多句、换行、超长、截断或 content_filter 回复直接阻断，不裁剪后继续。prompt 只扩写 diagnosis 中的目标，不重新寻找问题；无缺陷句仅转换为保留原貌的要求。英文正文仍执行现有范围补全、长度与格式校验，诊断不落库。
- Qwen 视觉契约：同一次请求使用 Image 1 干净当前效果图、Image 2 完整选中多视图、第三张未外扩原始作者 mask，以及服务端从干净 Image 1 自动生成的第四张选区上下文裁切；只编码一次并复用。第四图按第三图包围盒定位，四周上下文为 `max(16, round(max(width,height)/32))px`，在 2048 输入上约 64px；它只放大 Image 1 的未修改真实画面，不是新参考视角，不能扩大编辑范围。Qwen 不接收 clay 白灰几何融合图，也不接收远端专用外扩/羽化 mask；原始 mask 与 Image 1 像素对齐，参考图不要求像素对齐。mask 白色只表达原始编辑区域。
- 编码与安全：Image 1 以 512px tile 组成真实 2K，保留材质、灯光、背景和网格，仅隐藏作者叠加层；Image 1 与第四张裁切进入 Qwen 前为 JPEG quality 95 / 4:4:4，原始 mask 为 quality 100 / 4:4:4，参考图为 quality 85 / 4:2:0，最长边均不超过 2048。浏览器只调用同源 Cookie API，仍只提交 `currentEffectImage/maskImage/referenceImage`；服务端不得在缺图时降级为文件名推断，并负责从已规范化的 Image 1 和 mask 派生第四图。API Key 只在 Node 控制面。
- 模板与输出：system content 使用经真实 Klein 工作流验证的通用 Qwen → Klein 模板。Qwen 必须先把原始 mask 的像素位置对应到 Image 1，确认真实被选部件，再从 Image 2 的完整/多视图中只取同一部件有证据的结构、配色、材质和功能边界，并转换到 Image 1 的相机、透视、轮廓、遮挡、光照与磨损。目标外观必须由 Image 2 对应部件、第四张干净局部和 Image 1 的 mask 外邻域共同锚定；若这些证据表明选区内纯白、浅灰或均匀光滑区域是未完成材质/几何占位，最终英文需先正面描述真实结构、底色、材质、粗糙度与旧化，再用一句明确约束完整替换 clay/primer/flat placeholder/untextured surface。真实浅色材质和金属高光不得因颜色被误删。修缝必须区分非物理纹理边缝与真实装配间隙、焊缝、开口、硬边和接触阴影；除非用户要求或图像证据明确支持，不得发明 brushed steel、clean metal、new weld bead、chamfer 或无缝铸造结构，也不得向最终 Klein 提示词输出像素坐标或包围盒。
- 输出与软校验：模板仍要求 100–180 个英文单词、2–3 段完整英文正文；首句先明确实际部件及目标动作/材质，随后限定只修改独立 mask 选区。段数、100–200 词观测范围、英文、Markdown、完整段落及首段 mask 表达只用于脱敏质量告警，不再拒绝非空正文，也不为表现格式发起第二次 Qwen 调用。服务端仍识别 `only ... mask`、`confine/restrict/limit ... within/to the mask` 或 mask 外保持 unchanged/protected/preserved 等等价表达；缺少明确范围时只在首段末尾确定性追加 `Confine all edits to the independent mask region and keep every area outside it unchanged.`，已有等价要求时不重复。只无损归一 2/3 个单行段落、CRLF 和连续编号，不截句、不删除意图。显式输入与空输入均固定一次 Qwen 调用；空输入在同一次响应中返回诊断和转换正文，保留默认 65 秒 deadline。只有空正文、超过 12000 字符、上游 `finish_reason=length/content_filter`、图片格式、HTTP、认证、网络或超时错误阻断；日志只记录问题代码，不记录诊断、提示词正文、图片或凭据。
- 复用、并发与回退：前端用项目/对象/参考 ID、原始提示词、mask revision、冻结相机/对象矩阵和图层 content revision 构造指纹；先查内存六项 LRU，再查已持久化 Generation，命中时不再调用 Qwen。等待 Qwen 期间 mask revision 变化则阻断提交。回退可关闭生成时自动解析并恢复手动入口；既有 Project/Layer/Capture 与历史结果无需迁移或删除。
- 测试：`test:prompt-polish` 以模拟上游响应覆盖独立诊断模板、一句话验证、空串/纯空白两阶段、无缺陷保留、四图顺序、选区包围盒/裁切、超时复用、诊断异常阻断、显式输入跳过诊断、183/201 词、单段、混合语言和 Markdown 的单次软放行、mask 范围确定性补全/去重、空结果/截断/content_filter/超长硬阻断及日志脱敏；不代替真实模型效果验收。`test:local-repaint-generation-input`、`test:local-repaint-performance-merge`、`test:local-repaint-result-composite` 锁定 Qwen/ModelView 角色分离、Worker 外扩羽化和内部 prompt 复用。
- v1.4.1 影响与回退：仅调整 M04 控制面润色适配器和测试；GPU/CPU/Worker/shader、投影、导出、分辨率、作者/远端 mask、Project/Layer/Generation/Capture Schema 和 Revision 不变，无数据迁移。回退只恢复润色适配器，不删除历史提示词、图层或资产。
- v1.4.2 影响、复用与回退：UI-05 → M04 / `ALG-GEN-005` 仅在空输入时注入受限诊断规则；用户显式编辑和普通润色保持不变。空输入指纹增加 `autoDiagnosisPolicy=seam-local-artifacts-v1`，使旧内存/历史诊断提示词不再命中；显式输入指纹不变，不删除历史记录。三图、四段/130–220词校验、模型参数、GPU/CPU/Worker/shader、UV、导出、分辨率与原始/远端蒙版规则均不变。无 Schema、资产或 Project Revision 迁移；回退恢复旧空输入规则并移除指纹中的策略版本即可。回归覆盖空串/纯空白、真实接缝保护、保守保留、手动要求及缓存隔离。

- v1.5.0 影响、迁移与回退：仅 M04 / UI-05 控制面新增一句话诊断阶段，转换模型/参数/四段规则及普通润色不变。空输入指纹更新为 `autoDiagnosisPolicy=one-sentence-diagnosis-to-klein-v2`，旧缓存不命中但历史记录保留；显式输入指纹不变。诊断不新增 API 返回字段或持久化字段。GPU/CPU/Worker/shader、投影/UV/export、分辨率、作者/远端 mask、Schema、Project Command/Revision/ownership 和历史资产均不变，无数据迁移。回退恢复单次空输入模板和上一策略版本即可，不删除任何工程数据。

- v1.6.0 影响、迁移与回退：仅 M04 / UI-05 的 Qwen → Klein system content、最终格式校验/修正提示及局部提示词缓存指纹变化；普通单/多视图润色、空输入诊断规则、三图顺序与编码、ModelView 输入、作者/远端 mask、GPU/CPU/Worker/shader、投影/UV/export、分辨率、Schema、Project Command/Revision/ownership 和历史资产均不变。所有局部重绘指纹新增 `promptTemplatePolicy=qwen-to-klein-grounded-2to3-v3`，因此旧模板缓存仅在升级后首次失效，生成的新结果仍按相同指纹复用；无批量数据迁移或历史删除。回退时恢复 v1.5.0 模板、四段校验/修正提示并移除该策略字段即可，已有 Generation 和图层继续可读。

- v1.7.0 影响、迁移与回退：仅 M04 服务端新增由原始 mask 推导第四张干净选区裁切，UI-05 将所有局部指纹策略升级为 `qwen-to-klein-selection-crop-v4`。浏览器 API 请求结构、用户输入逻辑、ModelView 的“效果图与白灰几何预览融合图 + 外扩/羽化 mask”、作者 mask、GPU/CPU/Worker/shader、投影/UV/export、分辨率、Schema、Project Command/Revision/ownership 和历史资产均不变。旧模板缓存仅在升级后首次失效，无批量迁移或历史删除。回退时停止生成/发送第四图并恢复 v3 指纹即可，已有 Generation 和图层继续可读。

- v1.7.1 影响、迁移与回退：仅 M04 的最终提示词格式验收范围和 mask 范围语义正则变化；system 目标、诊断、四图、缓存指纹、ModelView、作者/远端 mask、GPU/CPU/Worker/shader、投影/UV/export、分辨率、Schema、Project Command/Revision/ownership 和历史资产均不变，无缓存失效或数据迁移。回退时恢复 180 词硬上限与旧 scope 正则即可。

- v1.7.2 影响、迁移与回退：仅 M04 在 Qwen 输出归一化后、格式校验前增加 mask 范围固定句补全；不改变 system 目标、诊断、四图、调用次数、缓存指纹、ModelView、作者/远端 mask、GPU/CPU/Worker/shader、投影/UV/export、分辨率、Schema、Project Command/Revision/ownership 或历史资产，无缓存失效和数据迁移。回退时移除 `ensureLocalRepaintMaskScope` 调用即可。

- v1.8.0 影响、迁移与回退：仅 M04 将最终提示词格式判断从阻断校验改为脱敏观测，并移除格式修正 Qwen 调用；独立 mask 范围确定性补全、system 生成目标、诊断、四图、缓存指纹、ModelView、作者/远端 mask、GPU/CPU/Worker/shader、投影/UV/export、分辨率、Schema、Project Command/Revision/ownership 和历史资产均不变，无缓存失效或数据迁移。回退时恢复格式失败分支和第二次 Qwen 请求即可。

- v1.9.0 影响、迁移与回退：仅 M04 的 Qwen → Klein system content 与 UI-05 的局部提示词缓存策略变化。策略指纹升级为 `qwen-to-klein-material-grounding-v5`，旧模板结果只在升级后首次失效，新的 Generation 仍按既有上下文指纹复用。诊断次数、四图、ModelView 效果/白灰几何融合图、作者/远端 mask、GPU/CPU/Worker/shader、投影/UV/export、分辨率、Schema、Project Command/Revision/ownership 和历史资产不变，无批量迁移。回退时恢复 v1.8.0 system content 和 v4 指纹即可，不删除任何提示词、Generation、图层或资产。

## 12. 状态、Revision 与并发

Project Revision 协议版本 1，ID 为 `revision-*`，number 从 1 连续增加，记录 parentRevisionId/savedAt。Project Command 协议版本 1，当前 kind 为 replace-project-document、rename-project、move-project。命令 ID 重放且 SHA 相同返回同一结果；同 ID 不同内容返回 `409 PROJECT_COMMAND_ID_REUSE_CONFLICT`；expected revision 不匹配返回 `409 PROJECT_REVISION_CONFLICT`。

Pipeline Revision 与 Project Revision 不同：前者记录 texture/retopology/uv/bake 业务产物来源和 stale overlay，追加后不可原位改写；后者是整个 Project 文档的存储并发版本。任何维护说明不得混称为“版本”。

## 13. 身份、安全、容量与性能

### 13.1 客户端性能录制 `ALG-PERF-SESSION-001` v1.1.0

A100 发布同时显式配置 `LICLICK_PERFORMANCE_LAB_ENABLED=true` 与构建变量 `VITE_LICLICK_PERFORMANCE_LAB_ENABLED=true` 后，`perfLab=1` 才按需加载云端记录桥；本地默认关闭且不生成/上传统计。既有“开始人工录制/结束并分析”状态从 `data-perf-manual-local-repaint-recording` 驱动一次完整会话。每次开始必须创建新的 `perf_<UUID>`，允许同一用户连续录制多次；结束后由 Worker 计算 SHA-256、写入 IndexedDB 待传队列并按 start → chunk → complete 顺序重试。采集不得写 Project/Scene/Layer Store，也不得触发 Project Command 或 Revision。

| 契约 | 当前版本/规则 |
| --- | --- |
| 算法 | `ALG-PERF-SESSION-001` v1.1.0，状态 production-diagnostic |
| 报告 Schema | `PERF-LAB-REPORT` v2；collector `2.1.0`；5 秒原始数据分块 |
| 浏览器输入 | rAF 帧时间/P50/P95/P99/最大帧、>16.67ms 掉帧、Long Task、Long Animation Frame、Event Timing、布局偏移、输入节拍、资源瀑布、实际 JS chunk 数/传输字节/解压字节/P95 与最大加载耗时、JS heap、可见性、运行时错误、业务阶段 timeline、React commit 总量/P95/最大值、WebGL2/ANGLE renderer 与能力/扩展/GPU timer 支持、采集器自身开销 |
| 隐私边界 | 资源 URL 删除 query/hash，并泛化 UUID/业务 ID；timeline detail 拒绝 prompt/text/url/path/email/token/cookie、业务 ID 与嵌套对象，只允许有限数值、布尔和白名单状态；不采集提示词、Cookie、键盘文本、模型/纹理像素；身份只取服务端可信 Session |
| 不可观测项 | 零组件浏览器无法直接读取 Windows ETW/DXGI/D3DKMT 调度计数、系统级 CPU/GPU 利用率、VRAM、温度、功耗及其他进程竞争；报告必须写 `unsupportedWithoutNativeComponent`，禁止伪造 |
| Cloud 职责 | A100/Cloud 只接收、校验、持久化和查询浏览器日志，不采样服务器 GPU，不参与用户视口帧循环 |
| 身份隔离 | 服务端以 Session user_id 写入，并保存录制时飞书 displayName/avatar/email 快照；普通用户只能通过本人查询读取本人记录；跨用户管理员查询必须使用独立 `/api/performance-lab/admin/sessions` 接口，并同时校验维护者角色与邮箱 allowlist，未命中白名单的普通用户或其他管理员固定返回 403 |
| 持久化 | SQL migration `003_performance_lab_sessions.sql`；`performance_lab_sessions` + 幂等主键 `(session_id, source, sequence)` 的 `performance_lab_chunks`；分片与最终报告分别校验 SHA-256 |
| 管理员配置 | `/li3d/performance-lab-admin` 为同源、飞书登录后的专用只读 HTML；`LICLICK_PERFORMANCE_LAB_MAINTAINER_EMAILS` 为可信登录邮箱逗号分隔 allowlist；前端页面不可替代服务端 403 门禁；匹配账号登录时只升级为 maintainer，不因配置临时移除而自动降权 |

体验验收是发布硬门禁，平均值不能掩盖瞬时卡顿。所有门禁必须在固定浏览器、固定参考硬件、固定真实项目和可重复操作脚本下记录前后对比：

| 体验维度 | 发布硬门禁 |
| --- | --- |
| 正确性 | 算法错误、未处理异常、错误结果、重复运行不一致、旧工程结果回归均为 0；性能优化必须通过既有数值/图像/状态机回归，不得通过降分辨率、删步骤或改变结果语义换取速度 |
| 稳定性 | 崩溃、卡死、WebGL context lost、录制中断均为 0；重复操作与不少于 30 分钟稳定性场景不得出现持续 heap 增长、资源未释放或越用越慢 |
| 帧稳定 | 60Hz 参考场景同时审查 P95/P99/最大帧和连续慢帧；P95 ≤ 16.67ms、P99 ≤ 25ms、最大帧 < 50ms，禁止连续 3 帧超过 16.67ms，任一项不满足即失败；不得只报告平均 FPS |
| 交互延迟 | 画笔/橡皮输入到首个可见反馈 P95 ≤ 50ms、P99 ≤ 100ms，任何单次 ≥ 200ms 判失败；按钮激活、切层、撤销重做必须记录 Event Timing 与对应业务阶段，不得用 loading 动画隐藏无响应 |
| 算法速度与效果 | 每个生成、投影、UV、烘焙、重绘、导出阶段分别记录 P50/P95/最大耗时及失败率；优化后 P95 不得回退超过 5%，输出质量与确定性必须保持，任何算法错误或效果退化直接阻断发布 |
| JS 与主线程 | 记录当前场景实际加载的脚本数量、传输/解压字节、加载 P95/最大值、Long Task、Long Animation Frame 与 React commit；总 bundle budget 继续执行，但拆包只有在首用延迟、主线程阻塞或缓存复用得到实测改善时才接受 |

迁移只新增性能会话/分片表，不回填旧 `sessionStorage` 报告，不改变 Project Command、Revision CAS、对象 ownership 或任何图层资产。回滚可停止挂载 Cloud bridge、关闭性能 API 并保留新增表供审计；IndexedDB 未发送记录可由恢复后的同版本页面继续重试，禁止为回滚删除用户项目或恢复 Windows 本地采集组件。

### 13.2 当前用户莉刻账号绑定 `LICLICK-ACCOUNT-BINDING` v1.3.5

最终状态：release 9ed1ff4b / CI #627144 已成功部署，线上 health 返回对应版本且 ready=true；维护者反馈功能正常后授权同步 master。以下“本地、未发布、真实预检受阻”等文字保留为修复准备阶段记录，不代表最终发布状态；维护者反馈不等于三用户隔离等全部专项已验收。master 同步保留其已合入的投影橡皮跨界面交接修复。

2026-09-08 回调适配修正（本地，未发布）：v1.3.4 的 release `2bc8042c` / CI #627117 已部署且健康检查通过，但真实授权返回生产 Gateway 根路径并 404，未完成个人绑定。官方 Atlas SDK 显式传 `redirect_uri`；Cloud 构造器却删除该参数，`target_url` 无法替代回调选择。v1.3.5 显式发送由公开部署路径生成的固定 `/api/liclick/account-binding/callback`（无查询参数、fragment 或尾斜杠），保留 `target_url` 的一次性任务关联，不恢复 localhost 浏览器回调或 OAuth state。模拟 IDaaS 增加显式回调登记匹配门禁，旧实现回归失败；新增根路径、账号查询/轮询、未登录及外域回调拒绝、重启后个人绑定恢复检查。模拟不证明真实 IDaaS 登记或生产工具/生图成功；真实预检被工具浏览器 ERR_BLOCKED_BY_CLIENT 拦截，真实完整链路未验收前不得宣称可用或再次发布。M13/M15，无图像算法、Schema、ownership、资产迁移；回退此补丁会恢复 Gateway 首页误跳转，保留生产配置及用户数据。详见 CHG-20260908-IDAAS-OFFICIAL-PRODUCTION-APP。

2026-09-08（CHG-20260908-IDAAS-OFFICIAL-PRODUCTION-APP）：维护者确认改用官方既有生产应用，部署配置从 QA `testplugin_jwt92/test` 切到 `https://idaas.lilith.com/enduser/sp/sso/lilithplugin_jwt62`、`enterpriseId=lilith`、`ATLAS_AI_GATEWAY_ENV=prod` 和显式生产 Gateway URL。当前根路径回调固定为 `https://li3d.lilithgames.com/api/liclick/account-binding/callback`；当日无会话探测该路径返回后端 401 JSON，而 `/li3d/api/...` 返回 SPA HTML，后者不能登记为当前站点回调。继续使用同源 `target_url` 绑定任务，不恢复 OAuth `state` 或浏览器 localhost 回调。每人通过自己的 IDaaS 身份取得令牌，服务器独立 Atlas home、邮箱一致性、工具权限与任务 ownership 保持。以下 QA 段落是历史，后续生产部署以本段为准。上线前旧版 `release-2c49d521` 真实点击仍报 `401 invalid_token`；运维口头完成配置不代替正式应用回调、工具和生图验收。本次为配置契约 Patch，无业务算法、GPU/CPU/Worker/shader、投影/UV/export、分辨率、Schema、Project Command、Revision CAS 或 verified assets 变化，无数据迁移。QA 缓存不复制到生产；受影响用户本人重新授权，保留其他绑定和历史。回退兼容镜像时保留官方生产配对配置；不得把切回未被信任的 QA 应用当作恢复成功，失败时暂停新绑定并保留数据。详见对应变更卡。

莉刻生图、编辑、轮询与通用提示词润色必须使用当前飞书 Session 用户独占的服务器端账号绑定。浏览器只通过同源、带 Cookie 的 Cloud API 发起绑定和查询状态；OAuth 临时状态、token 与 `atlas_home_dir` 只由 A100 控制面保管，禁止写入浏览器、Windows 本地组件或项目文档。

| 契约 | 当前版本/规则 |
| --- | --- |
| 身份来源 | 当前飞书 Session 的 `user_id` 与 email；绑定成功时 Atlas email 必须与飞书 email 完全一致，否则拒绝并清理临时凭据 |
| 凭据隔离 | 每个用户写入独立、服务器托管的 Atlas home，并只把该目录绑定到同一 `cloud_users.id`；不得使用共享 `ATLAS_TOKEN_FILE`、默认 home 或其他用户目录作为回退 |
| 强制门禁 | 生图、编辑、任务轮询和通用润色在未绑定时统一失败为 `409 LICLICK_PERSONAL_ACCOUNT_REQUIRED`；底层 Atlas 调用同时 fail-closed，防止绕过路由后落入共享凭据 |
| 任务所有权 | 只允许轮询当前 Session 用户已登记且携带同一用户个人 Atlas home 的任务；未知远端 task ID 固定返回 404，不得用当前或默认凭据探测 |
| 解绑 | 只清除当前用户数据库绑定及其受管目录，不退出飞书、不删除其他用户凭据、不触碰 Project/Layer/Capture/Generation 数据 |
| 浏览器拓扑 | 继续使用 browser zero-install + LI3D Cloud；禁止恢复 localhost/4618、安装器、端点切换或本地凭据托管 |

v1.1.0 将“登录 LI3D”与“关联当前用户莉刻账号”串为同一安全流程。飞书/IDaaS 完成身份校验后，服务端为当前用户启动 Atlas SkillHub 2.9.1 的 loopback-only `authenticate` bridge；浏览器只接收同源关联回调页面，回调中的身份令牌立即转交本机回环监听器，页面随后清除 URL fragment。Atlas 运行时负责加密 token cache 写入，LI3D 禁止自行落明文 token；写入完成后还必须通过 secure cache 读取、有效期检查、`gateway list-tools --service liclick` 可用性检查以及 Atlas email 与飞书 Session email 一致性检查，全部通过才绑定独立 `atlas_home_dir`。运行时缺少 `readCache` 或 `authenticate` 时固定返回 `ATLAS_RUNTIME_INCOMPATIBLE`，不得回退共享账号、默认 home 或手写明文缓存。失败、超时、身份不一致或回调任务不匹配时终止子进程并删除未绑定临时目录；既有合法个人绑定继续复用。该升级不改变 Project/Layer/Capture/Generation Schema、Revision、ownership、图层资产或莉刻任务格式，无数据迁移；回退只能关闭自动关联入口并要求用户重新授权，不得恢复共享凭据。

v1.1.1 修复部署在非根路径时的莉刻 IDaaS Service 回调：账号绑定回调必须以 `LICLICK_PUBLIC_PATH` 为权威路径，并仅在该配置为空时回退 `LICLICK_PUBLIC_WORKSPACE_URL` 自带 pathname。A100 的回调因此固定为 `/li3d/api/liclick/account-binding/callback`，不得退化为根路径 `/api/...`。此补丁只修正 M13 的授权 URL 构造，不改变令牌校验、飞书与莉刻邮箱一致性、独立 Atlas home、Project/Layer/Capture/Generation Schema、Revision、ownership 或资产；无数据迁移。回退只恢复旧 URL 构造，但会重新暴露子路径部署绑定失败，不得改为共享账号回退。

v1.2.0 增加显式、默认关闭的 A100 测试共享账号模式，仅用于 IDaaS 云端个人回调尚未开通期间的受控联调。只有同时配置 `LICLICK_SHARED_TEST_ACCOUNT_ENABLED=true`、固定 owner email 和位于 `LICLICK_WORKSPACE_DIR/atlas-homes` 下的受管 Atlas home 才会生效；所有已通过飞书登录的用户仍保持各自 Li3D Project/Job ownership，但莉刻远端调用、额度、个人工作区和任务资产统一归属该测试 owner。模式开启时禁止从用户菜单解绑或删除共享 Atlas home，跳过“Atlas email 必须等于当前飞书 email”的个人绑定断言，并在账号状态中显式标记 `sharedTestAccount`。关闭开关即可恢复 v1.1.1 的个人绑定 fail-closed 行为；不得把 Token、密钥或具体人员邮箱提交到 Git。

v1.3.0 按 IDaaS JWT SP 发起协议改为固定注册回调。IDaaS 应用只登记由公开部署路径生成的 `/api/liclick/account-binding/callback`；当前生产站点根路径下的精确地址为 `https://li3d.lilithgames.com/api/liclick/account-binding/callback`，历史文档中的 `/li3d/...` 只适用于曾配置 `LICLICK_PUBLIC_PATH=/li3d` 的部署，不得用于当前生产 ingress。发起 URL 不再发送动态 `redirect_uri` 或 OAuth `state`，而以同源 `target_url` 携带十分钟有效的一次性随机绑定 UUID。回调仅接受与公开站点 origin、固定 `/api/liclick/account-binding/complete` 路径、唯一 `loginId` 参数完全匹配的目标，外域、额外参数、fragment 或非 UUID 均拒绝；目标只用于服务端关联，不执行浏览器跳转。GET 回调取得 IDaaS 令牌后立即清除地址栏 query/fragment，再以同源 Cookie 和 JSON POST 完成授权。

v1.3.1 修复 v1.3.0 将 Cloud QA 固定回调协议错误套用到本地 4517 的回归。只有显式设置 `IDAAS_JWT_SSO_ENABLED=true` 的服务器环境使用 `LI3D-QA` 固定 callback 与 `target_url`；本地真实联调恢复 Atlas SkillHub 原生登录，由运行时使用其协议固定端口生成 `redirect_uri=http://localhost:20265/callback`、直接接收 IDaaS 令牌并写入当前用户的临时 Atlas home，LI3D 轮询子进程完成后再执行权限和邮箱校验并绑定该目录。Cloud 回调仍将令牌只交给随机内部端口上的 loopback-only Atlas bridge；本地不再构造带 `loginId` 查询参数的 LI3D Service URL，也不把浏览器带到 Atlas Gateway 根路径。两种模式继续执行 Session ownership、一次性绑定任务、secure cache、有效期、工具权限及双方 email 一致性检查。无数据库、项目、资产或既有个人 Atlas home 迁移；回滚到 v1.3.0 会重新破坏清空缓存后的本地重新授权，因此不得作为本地验收回退方案。

v1.3.2 修复 Atlas SkillHub 2.9.1 在 K8s 中把个人 IDaaS Token 错误切换为 ArkClaw/TIP-only 的回归。Atlas CLI 会因 `KUBERNETES_SERVICE_HOST`、workload 或 ArkClaw 信号忽略用户独立安全缓存并要求 `VE_TIP_TOKEN`；LI3D 现在只为带明确个人 Atlas home 的 Atlas 子进程移除这些自动探测信号，使回调刚写入的个人 IDaaS Token 用于 `status`、`list-tools` 与后续业务调用。未指定个人 home 的机器级 Atlas 进程继续继承完整 Pod 环境并保持 TIP 行为。用户 Token 不进入环境变量，Pod 主进程环境不变，也不允许个人请求回退到公共 TIP Token。无 Schema、ownership、资产或既有个人 Atlas home 迁移；回滚只能暂停新的个人绑定，不能注入共享 TIP Token 代替个人身份。

v1.3.3 修复 QA IDaaS JWT 被错误提交到生产 Atlas Gateway 导致 `HTTP 401 invalid_token`。Atlas SkillHub 的环境必须成对使用：QA IDaaS 对应 `atlas-ai-gateway-test.lilithgames.com`，生产 IDaaS 对应 `atlas-ai-gateway.lilithgames.com`。Cloud 配置新增显式 `ATLAS_AI_GATEWAY_ENV`，当前 `LI3D-QA` 设置为 `test`；启动时拒绝已知 QA/生产混配，个人 Token 缓存的 `gateway_url` 也必须匹配当前环境。切正式 IDaaS 时须同时改为 `prod`。无 Schema、ownership、资产或既有有效生产个人 home 迁移；此前 QA 失败产生的临时 home 按原失败清理策略移除。

该协议不改变“一个飞书用户一个莉刻账号”：完成绑定仍须同时通过当前飞书 Session 归属、Atlas secure cache、有效期、莉刻服务权限以及 Atlas email 与飞书 email 一致性检查，随后只保存到该 `cloud_users.id` 的独立 Atlas home。既有个人绑定和 Project/Job/Asset ownership 原样保留；没有个人绑定的用户重新授权即可，无数据库、Project/Layer/Capture/Generation Schema 或资产迁移。发布前先在 `qa-idaas.lilithgames.com` 创建 JWT 测试应用并登记固定回调，配置 `IDAAS_JWT_SSO_URL` 为其 SP 发起地址，双用户验证隔离后再以同配置结构切换生产应用。回滚只恢复前一镜像并暂停新绑定；不得恢复动态回调、共享默认账号或迁移/删除现有个人凭据。

迁移策略为：既有用户若没有独立 `atlas_home_dir`，一律视为未绑定并由本人重新完成莉刻授权；不自动认领 A100 共享凭据，也不迁移历史共享账号任务。该变更不修改 Project Command、Revision CAS、Project/Layer/Capture/Generation Schema、对象 ownership 或已验证资产。发布后应从 A100 运行配置移除共享 `ATLAS_TOKEN_FILE` 并撤销旧共享 token；回滚不得恢复共享回退，只能临时关闭莉刻入口并保留用户绑定数据，待兼容版本恢复。

- 同源 Session Cookie；浏览器不保存长期对象存储密钥。
- 所有项目、Job、Asset 查询同时带 user_id 和资源 ID。
- OAuth state 使用数据库原子消费，拒绝重放。
- App 默认最多 256 在途请求；过载返回 503 + Retry-After。
- PostgreSQL 默认每副本 20 连接，副本数服从数据库预算。
- 大文件直传对象存储；GPU 任务进入独立集群队列，不占用 App Server GPU。
- Engine Session 管理项目级 CPU/GPU lane、任务取消和资源释放。
- 交互期间 Worker/GPU 重任务受 frame budget/heavy task scheduler 约束，但不得静默降低最终分辨率或关闭可见性检查。
- 性能实验室入口契约 `PERF-LAB-ENTRY/2.0.0`：项目贴图路由追加 `?perfLab=1` 时，只为当前真实项目打开性能 HUD、人工录制、帧时间与算法基准按钮。入口不得创建合成 Project、不得调用 `replaceCurrentProject`、不得写 Scene/Layer Store、不得改变活动对象或活动图层、不得触发项目保存；`perfScenario` 不再是编辑器路由契约。合成压力数据只能进入独立测试 Harness，且不得挂载真实项目持久化服务。投影预览失败保留上一份有效材质并写入 console；渐进预览按 `ALG-PROJ-007` v2.1.0 对相同签名执行有界退避恢复，禁止弹出用户 Toast 或无限自动重算。
- P0 数据安全门禁：任何调试、性能、演示或测试模块不得向真实 Project/Layer/Capture/Generation 持久化路径写入数据。回归测试必须静态断言编辑器不挂载场景替换加载器，并验证 `perfLab=1` 仅返回布尔诊断开关。若发生污染，先停自动保存、备份原文件，再依据 Generation.metadata.projectedLayerId、textureBatchId、Capture.camera 与本地资产重建，禁止直接删除整个项目。

## 14. 变更分级与修改上限

| 等级 | 示例 | 必须动作 |
| --- | --- | --- |
| Patch | UI 文案、错误呈现、无语义回归测试 | 模块测试 + typecheck |
| Minor | 新 Layer role、兼容参数、非默认算法能力 | ALG/Schema Minor、迁移与回退说明、对应矩阵测试 |
| Major | 投影矩阵、权重模型、深度编码、颜色空间、UV 合并语义、持久化契约 | ADR、显式批准、版本升级、旧工程迁移、CPU/GPU/Worker/export 全链验证 |

默认一次修复只跨一个大模块，不超过 5 个源码文件或 300 行净变化。跨两个以上大模块、修改投影/UV/局部重绘阈值、Project/Layer/Capture/Generation 契约、默认分辨率、目录移动或兼容删除，必须先提交证据化方案并获得批准。

## 15. 模块验收矩阵

| 模块 | 最低自动验证 |
| --- | --- |
| M01/M12/M14 | contracts、project pipeline persistence、revision conflict、Postgres Repository、asset transfer |
| M02/M03 | model import、FBX repair、placement/camera、capture 对照 |
| M04 | generation polling/conflict/auth continuation、单/多视图 |
| M05/M06 | projection layers、multi-model restore、眼睛、相机旋转、对象 transform 后对齐 |
| M07 | projection、UV merge、backpressure、CPU/GPU parity、export orientation |
| M08 | local repaint material reference、seam、ordered/inward composition、bake batching、layer retention |
| M09 | content-aware topology/repair、island 不串色、取消 |
| M10 | 真实 UV/retopology/Substance smoke、QA failure、artifact ownership、Bake alignment |
| M11 | GLB/FBX/OBJ/BaseColor 方向、重开与下载 |
| M13/M15 | cloud boundary、repository boundary、auth、scheduler、bundle budget、release readiness |

本基线合入验证：`pnpm --filter @liclick/web test:multi-model-restore-policy` 通过；contracts build 与 Web typecheck 通过。红色历史流水线状态不能以本地测试替代，推送后仍需核对 GitLab CI。

GitLab CI 依赖安装必须把 pnpm store 与 Prisma engine cache 放入 `$CI_PROJECT_DIR` 下的项目级缓存目录。Prisma engine 下载发生瞬时网络错误时，允许完整的 `pnpm install --frozen-lockfile` 最多重试 3 次并采用有界退避；禁止通过 `--ignore-scripts`、跳过 Prisma engine、放宽测试或使用未冻结 lockfile 伪造通过。此策略只提高 M15 发布验证的网络容错，不改变生产 Prisma schema、数据库协议、Project Command/Revision 或浏览器运行时。

M15 lint 发布修复（2026-08-31）：根工作区显式声明与锁文件一致的 `@eslint/js@9.39.4`，避免依赖提升差异导致 ESLint 配置加载失败。M04 / `ALG-GEN-005` 的提示词终端转义清理由 Node `stripVTControlCharacters` 实现，替代触发 `no-control-regex/no-useless-escape` 的手写正则；保留全部 lint 门禁。回归覆盖 ANSI 颜色、C1 CSI、OSC 标题/超链接清理，以及中文、标点、URL 与段落保留。诊断/转换模板和调用链、算法版本 v1.5.0、GPU/CPU/Worker/shader/UV/export、Schema 与资产均不变，无迁移。回退仅还原依赖声明、锁文件和清理实现，不修改密钥或工程数据。

M15 体积修复：锁定 `terser@5.51.2` 两轮安全压缩，保留日志和属性名；JS 总量实测 3,067,290 字节，原门禁不变。新增真实构建等价性回归；业务、算法、数据均不变，无迁移。回退仅恢复压缩配置和依赖，发布仍须全 CI 验证。

M15 / CLOUD-DEPLOYMENT v1.0.0（2026-09-03）：正常合并 release 部署历史与 master 应用基线；修正完整 workspace 镜像构建、Cloud 构建身份、运行目录和 PostgreSQL SQL 001–003 初始化。所有分支保留完整 verify/build 门禁，master/MR 额外验证 server/web 镜像但不推送；仅 release 且最终提交含 [deploy] 才允许生产部署。Docker/Kaniko 上下文排除真实凭据和用户数据；Qwen 密钥注入由效率组管理。原 PVC 保留，生产权威数据必须使用 PostgreSQL＋HTTPS 对象存储，存量数据独立迁移验收后才设置 LI3D_CLOUD_DATA_READY；缺配置不得静默回退。Project Command v1、Revision CAS、ownership、verified assets 与全部业务算法版本不变，无自动数据迁移。回滚只切换兼容 Cloud 协议的已验证镜像，不删除库、对象或 PVC。详见 CHG-20260903-CLOUD-DEPLOYMENT-CI 与 deploy/README.md。

## 16. 固定审计卡格式

以后新增或修改算法必须记录：ALG ID、中英文名称、SemVer、状态（production/experimental/deprecated/disabled）、所有调用 UI/use case、输入、输出、单位、颜色空间、矩阵空间、常量、CPU/GPU/Worker/shader 对应实现、持久化字段、回退、迁移、测试、负责人和变更单。

回答维护问题的固定顺序：`UI ID → 大/小模块 → ALG ID/版本 → 输入 → 公式/阈值 → Layer 输出 → 资产/Project 输出 → 回退 → 测试`。例如“Ctrl+S 怎么保存”必须回答 Project Command、Revision、对象存储和 PostgreSQL，而不是只说“保存 JSON”。

## 17. 当前架构债务

| 优先级 | 债务 | 处理原则 |
| --- | --- | --- |
| P0 | 远端 main 含错误顺序的旧文档提交 | 由 Maintainer 受控重置为干净链；禁止把旧正文再合入 |
| P0 | `EditorPage.tsx`、`GeneratePanel.tsx` 仍承担大量编排 | 按用例迁入 application 层，不在拆分时改变算法 |
| P1 | 投影核心常量没有独立持久化版本 | 增加 projectionAlgorithmVersion 和旧工程策略 |
| P1 | 代码仍有 local-server/workspace 迁移期字段和错误文案 | 只做受控 schema/UI 清理，不得恢复本地组件拓扑 |
| P1 | 生产 UV/拓扑/Bake 尚需更多真实资产矩阵 | 失败门禁保持 fail-closed，模拟结果不得升级状态 |
| P2 | delete/duplicate 尚未统一为 Project Command | 先扩展契约和事务测试，再迁移调用者 |

## 18. 修订历史

| 版本 | 日期 | 基线 | 变更 |
| --- | --- | --- | --- |
| `2.20.8` | 2026-09-10 | `5e5f7c3 + 发布确认` | 用户确认移除贴图工作台 8K 选项及保留无自动补洞合并；旧项目不降采样，授权 master/A100 发布 |
| `2.20.7` | 2026-09-10 | `20b0912a + 本地待提交` | 局部重绘 UV 可见面绘制、稀疏 RGBA 历史与保存/导出/合并一致性；单视图不改。见 CHG-20260910-UV-REPAINT |
| `2.0.0` | 2026-08-26 | `2568e405` | 从 Modernization 基线重新审计；彻底移除旧本地组件架构；重建 Cloud 保存、图层、投影、UV v4、局部重绘 v14/v5、生产 UV/拓扑/Bake 与维护规则 |
| `2.1.0` | 2026-08-26 | `待提交` | `ALG-LR-002` 对齐 ModelView GGUF 三业务输入：新增可选提示词，只提交白模与材质多视图两张图片，移除远端 viewport/seed 字段；本地 mask、flat reference、depth、接缝融合和回贴规则保持不变 |
| `2.1.1` | 2026-08-26 | `本次发布提交` | 固化 `PERF-LAB-ENTRY/1.1.0`：`perfLab=1` 同时启用性能 HUD 与默认单模型 100 图层基准，显式 `perfScenario` 仍可覆盖；补齐 URL 导航保留和云端测试说明 |
| `2.1.2` | 2026-08-26 | `本次发布提交` | `PERF-LAB-ENTRY/1.1.1`：投影预览失败改为静默保留上一份有效材质并熔断相同签名；错误仅写 console，禁止反复弹出用户 Toast |
| `2.1.3` | 2026-08-26 | `本次发布提交` | P0 修复：废止会替换真实项目的合成性能场景，`perfLab=1` 升级为只读测试台；增加真实项目零写入门禁和恢复规则 |
| `2.2.0` | 2026-08-26 | `本次发布提交 + 本地待提交` | 新增 `ALG-ERASE-001` v1.0.0：恢复 UI-10 当前图层橡皮与 `E` 快捷键；普通/合并 UV、投影蒙版和局部重绘按各自 coverage 编辑，内容填补底图需显式转可编辑 UV 副本；最终遮罩对齐 1K/2K/4K/8K，并登记迁移、失败与回退契约。同步修复 UI-05/UI-10 局部生图提交准备态显示不一致。新增 `ALG-GEN-004`：单视图增加非默认 ModelView 远端提供方；GPT2 原路径保持不变，远端复用当前白模捕获和 `single-view-priority-v1` 投影，通过同源服务端代理执行独立 4 步工作流 |
| `2.3.0` | 2026-08-26 | `本次发布提交` | 新增 `ALG-PERF-SESSION-001` v1.0.0 / `PERF-LAB-REPORT` schema v2：`perfLab=1` 人工录制采集用户浏览器真实帧、主线程、网络、内存及 ANGLE/D3D 能力，Worker 分块可靠上传，Cloud 按可信飞书身份隔离保存/查询；明确排除 A100 GPU 与浏览器不可见的原生系统计数 |
| `2.3.1` | 2026-08-26 | `本次发布提交` | 新增同源 `/li3d/performance-lab-admin` 只读分析页与独立管理员 list/detail API；跨用户读取必须同时命中维护者角色和两人邮箱白名单，普通用户及白名单外管理员均返回 403；A100 显式启用、本地默认不采集；发布总 JS 门禁依据新增隔离模块实测从 3.050 MB 调整为 3.080 MB，原有本人查询、本地项目及贴图/UV/重绘链路保持不变 |
| `2.3.2` | 2026-08-26 | `本次发布提交` | `ALG-PERF-SESSION-001` v1.0.1：A100 正式恢复 `/li3d` 构建前缀；录制按钮增加显式 Cloud start/end 通道；HTTP 内网环境对 `crypto.randomUUID` 与 `crypto.subtle` 缺失分别使用 RFC 4122 v4 UUID 和既有纯 JS SHA-256 回退。真实飞书账号已完成 1 次服务器录制，读回 1 分块、85 样本、19,854 字节及最终 SHA；本地仍为根路径且默认不采集，Project/Revision/贴图、UV、重绘数据未迁移。 |
| `2.3.3` | 2026-08-27 | `7d1e7bb + b9ca6dbc + f993f29 + 95a7473 + 本次文档提交` | `ALG-LR-007` v2.0.1 / `ALG-LR-008` v2.1.0：修复第二次及后续按钮 3 需要重复点击、预热卡顿、停笔后图层延迟显示、重复工作区资产上传和有序图层栈下 GPU overlay 重复投影到底面；停笔后两帧内立即发布完整图层行，3000ms idle 仅保留后台 latest-wins 保存合并；历史图层选择保护与远端契约对齐，稳定 vendor 分包后云端 bundle budget 保持通过；不改变 Project Command/Revision、投影/UV/颜色公式、输出分辨率或旧工程资产格式。 |
| `2.3.4` | 2026-08-27 | `21a1c20 + 本次 CI 修复提交` | M15 GitLab 安装验证加固：修正未命中项目缓存导致的全量冷下载，缓存 pnpm store 与 Prisma engine；`pnpm install --frozen-lockfile` 对瞬时 `ECONNRESET` 最多重试 3 次并采用 5/10 秒退避。保持 lifecycle、Prisma engine、全部 verify/build 门禁与生产契约不变。 |
| `2.3.5` | 2026-08-27 | `本次显示修复提交` | 新增 `ALG-LR-011` v1.0.0：重绘效果图与普通投射图层统一为 depth-authoritative 透明、单次精确裁切显示副本，完整保留几何覆盖区、黑色材质和边缘；深度失败仅使用边缘连通近黑背景的保守降级。局部重绘图层明确排除整图显示副本，继续按用户涂绘 mask 只显示笔刷授权区域。投影、UV、GPU/CPU/Worker/shader、持久化、对象资产、Project Command/Revision 与导出均不变，无迁移。 |
| `2.3.6` | 2026-08-27 | `0172822 + 本次延迟与多层修复提交` | `ALG-LR-007` v2.0.2 / `ALG-LR-008` v2.2.0 / `ALG-PROJ-007` v2.0.1：局部生图不再等待提交前项目同步；按钮 3 允许等价 live mask URL 命中已驻留 GPU source；多重绘层的 renderer/persisted twin 在创建、重绑、工具切换时保持单一可见所有权；多模型 UV 预热按选中对象限定隐藏层并在整组 striped upload 期间固定 Worker bitmap，消除 `no longer resident` 与后续 WebGL 1282 降级。保持投影、深度、颜色、分辨率、CPU/Worker/shader/export 与 Project Command/Revision/ownership 契约不变，无数据迁移。 |
| `2.4.0` | 2026-08-27 | `cf7ecec + 本次单视图投影提交` | 今日贴图工具优化汇总：局部重绘有序栈保持单一显示所有权；投影橡皮 mask 在预览/切层/工具切换后持续生效，眼睛连续点击不被晚到 effect 复活，并新增安全“清理蒙版”；`ALG-PROJ-002/003` v3、`ALG-PROJ-005` v2、`ALG-UV-004` v3 统一 GPT2/远端单视图的 capture mask/depth 表面锁定、预览/投影边缘去污染和有底层时的 3.5% 距离场宽带过渡。实时、渐进预览与 GPU UV bake 同义；Project/Layer Schema、Revision、ownership 与资产类别不变，旧工程无需批量迁移。 |
| `2.4.1` | 2026-08-27 | `本次保存调度提交` | 新增 `SAVE-SCHEDULER` v1.0.0：自动保存改为 2 秒尾随、10 秒最长等待和视口繁忙 1 秒有界重试；项目内存 `editVersion` 取代时间戳/ID 启发式，确保保存途中继续修改同一图层、蒙版或参数时不会误报 Saved。继续沿用单项目串行队列、Project Command v1、Revision CAS、verified assets 与 ownership；Project/Layer Schema 和旧工程资产均不迁移。 |
| `2.4.2` | 2026-08-27 | `本次投影橡皮性能提交` | `ALG-ERASE-001` v1.1.0：普通 projected 橡皮对齐蒙版画笔的 latest-sample-per-frame 输入调度，将一帧最多 96 次 BVH/三画布重复处理收敛为一次表面命中和连续段栅格；低分辨率持久提交等待 120ms 无输入 idle，高分辨率补缝继续 3000ms 后运行。UV 橡皮、局部重绘 coverage、覆盖公式、1K/2K/4K/8K 输出、Project/Layer Schema、Revision 与资产协议不变，无迁移；回退仅恢复投影橡皮密集采样和即时提交。 |
| `2.5.0` | 2026-08-28 | `本次 ModelView 四输入提交` | `ALG-LR-002` v3.0.0：局部重绘对齐 `2026.08.28-cd48a78-truev3-gguf-mask-4input-rseed-r1`，输入改为 2K flat BaseColor 当前效果图、多视图材质参考、同尺寸 RGB mask 和可空提示词；Node 控制面 fail-closed 校验尺寸与红通道，远端 PNG 以 `direct-v1` 直出，不再执行新任务的浏览器校色融合。旧 v5-v14 读取兼容、单视图两图契约、capture/depth/allowed-mask 投影保护、图层/橡皮/保存与 Project Command/Revision/ownership 均不变，无数据迁移。 |
| `2.5.1` | 2026-08-28 | `本次重绘预览同步提交` | `ALG-LR-007` v2.0.3：生成面板“重绘效果图”在用户尚未应用画笔时继续显示远端候选整图；同 Generation 的局部重绘图层首次发布后，改为订阅该图层 image、实时/持久化 mask 和 contentRevision，并按与图层面板相同的 destination-in 语义显示实际覆盖区域。投影、UV、深度、保存、Layer/Generation Schema 与历史资产不变，无迁移。 |
| `2.5.2` | 2026-08-28 | `本次重绘显示职责修正提交` | 撤回 `2.5.1` 对生成面板的错误职责变更：“重绘效果图”恢复为始终显示当前 Generation 的完整远端返回图，不再订阅画笔图层或裁切为局部块；表面画笔 coverage 仍仅由 3D 视口实时 GPU overlay 与局部重绘图层预览呈现。未改动视口 overlay、投影、UV、深度、保存、Layer/Generation Schema 与历史资产，无迁移。 |
| `2.6.0` | 2026-08-28 | `fe39f74 + 本次智能润色提交` | 新增 `ALG-GEN-005` v1.0.0：UI-05 提示词窗口右上角增加单一智能润色图标；普通生成走保留原意/语言的通用 `data-analysis` A2A，局部重绘走 FLUX.2 Klein 四段英文专用模板并执行词数/格式 fail-closed 校验。同用户任务串行，前端对项目、页签和原文变化执行 stale-result 防覆盖，并支持恢复原文。润色只更新现有提示词文本和保存链路，不改变 Project/Layer/Generation/Capture Schema、Revision、资产、投影、UV、橡皮或历史工程，无数据迁移。 |
| `2.6.1` | 2026-08-29 | `本次多模态润色提交` | `ALG-GEN-005` v1.1.0：局部重绘智能润色冻结当前相机，提交 2K flat 当前效果图、同相机 RGB 白色蒙版和用户当前选中的完整参考图三个 A2A FilePart；服务端 fail-closed 校验三图、使用请求独占临时目录并全路径清理，禁止缺图时降级为文件名推断。晚到结果新增蒙版 revision 与精确参考图 ID 保护；普通润色、局部生图四输入、Project/Layer/Generation/Capture Schema、Revision、资产、投影、UV、橡皮与历史工程均不改变，无数据迁移。 |
| `2.6.2` | 2026-08-29 | `本次通用多模态润色修正提交` | `ALG-GEN-005` v1.2.0：修正 A2A 附件按位置解析导致 mask 被误识别为 Image 2 的根因，固定为 Image 1 当前干净视口效果图、Image 2 完整选中参考图、Image 3 白色蒙版；当前效果图改为保留材质/灯光/背景的视口捕获，参考图使用独立高质量预算。局部模板改为按用户要求和视觉证据通用判断编辑类型，仅在可辨时转写文字，不绑定具体物体、品牌或任务；三图必填、四段英文校验、临时目录清理、stale-result 保护及局部生图四输入均保持。无 Schema 或项目数据迁移。 |
| `2.6.3` | 2026-08-29 | `本次 Qwen3-VL 局部润色提交` | `ALG-GEN-005` v1.3.0：仅局部重绘智能润色改为 Node 后端直连公司 `qwen3-vl-plus` OpenAI-compatible 代理，以 system content 固化 FLUX.2 Klein 四段模板，并按当前效果图、完整参考图、无损白色蒙版顺序提交三张 `image_url`；返回仍为纯文本并继续执行 130–220 词 fail-closed 校验。普通单/多视图仍走莉刻 `data-analysis`，局部生图、Project/Layer/Generation/Capture Schema、Revision、资产、投影、UV 与历史工程不变；回退只需恢复局部润色适配器。 |
| `2.6.4` | 2026-08-29 | `本次 Qwen3-VL 视觉输入兼容修复` | `ALG-GEN-005` v1.3.1：对齐 Qwen 插件的视觉编码契约，局部重绘三图进入代理前统一转换为最长边 2048、JPEG quality 85，透明区域落黑；修复真实 4K WebP/无损 PNG 素材触发上游 400/413/415 后被压成通用不可用提示的问题，并为这些状态提供明确错误映射。三图语义顺序、system content、四段英文校验、单/多视图莉刻链路、局部生图、Project/Layer/Generation/Capture Schema、Revision、资产、投影、UV 与历史工程均不变，无数据迁移。 |
| `2.6.5` | 2026-08-29 | `本次当前视角效果图质量修复` | `ALG-GEN-005` v1.3.2：修复 Image 1 当前视角效果图原先按 512px 渲染后放大到 2048px造成的模糊，改为真实 2K、512px 分块采集；仅该图在 Qwen 边界提升到 JPEG quality 95 / 4:4:4，参考图和蒙版维持 quality 85 / 4:2:0。单/多视图、三图顺序、模板、局部生图输出、Project/Layer/Generation/Capture Schema、Revision、资产、投影、UV 与历史工程均不变，无数据迁移。 |
| `2.7.0` | 2026-08-29 | `本次局部重绘自动解析与远端输入融合提交` | `ALG-GEN-005` v1.4.0 / `ALG-LR-002` v3.1.0 / `ALG-LR-012` v1.0.0：局部生成时自动调用 Qwen，有用户文字则优化，留空则先分析原始 mask 区域问题；结果只进入 Generation 不回填文本框，上下文未变时复用。Qwen 仅看干净效果图、完整多视图和未外扩 mask；ModelView 改收效果/蒙版内 clay 白灰几何融合图与 8–24px@2K 自适应外扩、4–10px 羽化 mask。原始作者 mask 和远端 mask 分离持久；返图直出、capture/depth 回贴保护、Project Command/Revision 与历史资产兼容不变，无数据迁移。 |
| `2.7.1` | 2026-08-29 | `本次远端蒙版外扩加倍提交` | `ALG-LR-012` v1.0.1：仅将 ModelView 使用的远端 mask 自适应外扩从 8–24px@2K 加倍为 16–48px@2K，羽化继续为 4–10px，原始核心继续强制 255；Qwen 仍使用未外扩作者 mask，融合图、提示词解析、返图直出、capture/depth 回贴保护及历史资产兼容均不变，无数据迁移。 |
| `2.7.2` | 2026-08-29 | `本次局部重绘画笔授权修复提交` | `ALG-LR-012` v1.0.2：修复远端生成后只出现“局部替换”图层但模型笔画无效的问题；远端 16–48px 外扩 mask 仅用于 ModelView，Capture、Generation `maskUrl`、画笔与恢复改绑未外扩作者 mask，外扩版本独立存入 `submittedMaskUrl`。已生成双蒙版任务优先读取 `authoredMaskUrl`，无需重新生图；Qwen、融合图、返图直出、深度保护和历史资产格式不变，无批量迁移。 |
| `2.8.0` | 2026-08-31 | `66bab93 + origin/master 8ac0379` | 合入远端 7 个优化提交，保留 AGENTS.md：`ALG-ERASE-001` v1.2.0 的 48ms 提交/切层交接、显隐权威状态与清理蒙版；`ALG-PROJ-007` v2.1.0 的 PBO 修复、活动对象预热和有界预览重试；`SAVE-SCHEDULER` v1.1.0 的最新快照队列、资产缓存及后台开发备份；同源 loopback 开发资产上传修复。Qwen、16-48px 外扩、作者/远端蒙版分离与画笔恢复保持本地契约，Project/Layer/Revision/ownership/输出分辨率无变化或迁移。 |
| `2.8.1` | 2026-08-31 | `本次局部润色格式修复提交` | `ALG-GEN-005` v1.4.1：修复“智能润色返回的格式不符合要求”阻断局部生成；无损兼容四段单换行/编号，停止删句压缩。异常回复在原超时内带三图修正一次，保持四段/130–220词强校验。真实 Qwen 复现中英混写及超长，并验证修正成功；回归覆盖成功、失败和超时边界。仅控制面改动，无 Schema 或资产迁移；回退润色适配器即可。 |
| `2.8.2` | 2026-08-31 | `本次连续重绘驻留交接修复` | `ALG-LR-007` v2.0.4 / `ALG-LR-008` v2.2.1：已发布重绘行按 LayerStore 判定驻留，移除蒙版工具选中态造成的后台饥饿；新 source 或清空 source 前保留旧 overlay，等待背景实际绑定后交接，逐帧取消及 10 秒超时保留显示。异步发布读取最新所有者。新增回归，不改变生成输入、投影/UV/shader/颜色/分辨率或持久化，无迁移；真实工程帧率待用户登录后验证。 |
| `2.8.3` | 2026-08-31 | `本次局部重绘页签文案调整` | M04 / UI-05：将“重绘效果图”页签统一命名为“局部重绘”，同步结果提示及空态文案；内部 repaint 标识、生成与预览逻辑不变。无算法或 Schema 版本变化、无迁移；回退仅恢复界面文案。 |
| `2.8.4` | 2026-08-31 | `本次局部重绘空输入诊断范围收窄` | `ALG-GEN-005` v1.4.2：仅空输入自动诊断收窄至人工接缝和投影引起的局部异常；保留真实结构、有效内容及不确定区域，不主动补字、增件或重设计。空输入缓存增加策略版本以避开旧诊断结果，显式要求与普通润色不变；三图、生成、蒙版、GPU/CPU/Worker/shader/UV/export、Schema、Revision 和历史资产均不变，无迁移。 |
| `2.9.0` | 2026-08-31 | `2009a6c + 本次一句话诊断与转换分离` | `ALG-GEN-005` v1.5.0：空输入先由 Qwen 输出一句中文修复要求，再以该句调用 Klein 四段英文转换模板；覆盖有证据的接缝、色差、投影和已有文字异常，转换不新增目标。显式输入跳过诊断，全流程共享 65 秒，最终格式最多修正一次；空输入缓存策略升级，诊断不持久化。三图/生成/蒙版/GPU/CPU/Worker/shader/UV/export、Schema 和历史资产不变，无迁移；模拟回归验证，不启动服务或调用真实生图。 |
| `2.9.1` | 2026-08-31 | `13d4321 + 本次 lint 修复` | M15 发布修复：显式补齐 `@eslint/js` 依赖；M04 提示词 ANSI 清理改用 Node 内置实现并补充回归，修复 CI 正则规则错误。全部质量门禁保留，`ALG-GEN-005` v1.5.0 与业务/Schema/资产契约不变，无迁移。 |
| `2.9.2` | 2026-08-31 | `707f009a + 本次构建体积修复` | M15：锁定 Terser 生产安全压缩，保留诊断和属性名，新增真实构建等价性回归。编辑器与 JS 总量回到原有体积上限内；不提高门禁，不删除功能，不改变业务算法、Schema 或资产，无迁移。 |
| `2.10.0` | 2026-08-31 | `add3b82 + 本次橡皮历史事务修复` | UI-06/UI-10、M12、`ALG-ERASE-001` v1.3.0：抬笔预登记历史，撤回等待手势与提交；即时同步持久瓦片和 GPU live mask；细化逐笔重放并原子发布，redo 检查点不串笔。增加真实回调/数值时序回归。原输出分辨率、覆盖公式和资产/Project Schema 不变，无迁移。 |
| `2.10.1` | 2026-09-01 | `本次视角选择工具提交` | UI-06/UI-10、M08、`ALG-LR-007` v2.0.5：贴图底部工具条新增选择/旋转视角按钮；点击退出画笔并隐藏蒙版展示，拖拽恢复 OrbitControls；返回蒙版画笔自动恢复展示。作者蒙版、历史、生成输入、GPU/CPU/Worker/shader/UV/export、Project/Layer/Generation/Capture Schema、Revision 与资产不变，无迁移。 |
| `2.10.2` | 2026-09-01 | `本次驻留工作区 Portal 门禁提交` | UI-05/UI-13、M04：UV 路由保留贴图编辑器状态时，将 `isActive` 传入生成面板并门禁其全部根节点 Portal，移除 UV 页泄漏的“局部生图”固定按钮及相关弹层；返回贴图页后原状态恢复。生成算法、蒙版、任务、GPU/CPU/Worker/shader、Schema、资产与 Revision 不变，无迁移。 |
| `2.10.3` | 2026-09-01 | `本次导出能力状态样式提交` | UI-03、M11：导出菜单移除支持项勾选和不支持项叉号；不可用格式继续保留并以灰色禁用文字及原因提示表达，支持格式维持普通可点击文字。`ALG-OUT-001`、导出格式、UV 合并、文件内容、Schema、资产与 Revision 不变，无迁移。 |
| `2.10.4` | 2026-09-01 | `本次 UV 到烘焙资产角色修复` | UI-13/UI-14、M10：UV 发布与历史交接只自动填充低模，烘焙页不再把 UV 输入或 Pipeline 来源高模自动导入；高模保持空白并由用户选择，选择后复用低模 Bake Set ID 自动配对。旧 Pipeline 自动高模快照只在读取时忽略，不删除资产；显式 Bake 高模继续恢复。Pipeline/Bake Workspace Schema、Revision 与烘焙算法不变，无批量迁移。 |
| `2.10.5` | 2026-09-01 | `本次 Qwen → Klein 模板替换` | M04/UI-05、`ALG-GEN-005` v1.6.0：局部重绘转换模板改为先按 mask 定位真实部件、再用 Image 2 对应视角交叉核对并适配 Image 1；输出改为 100–180 词、2–3 段英文，取消固定开头和四段堆叠。同步更新 fail-closed 校验、一次格式修正及所有局部缓存指纹。空输入诊断、三图输入、ModelView、蒙版、投影/UV、Schema、Revision 和资产不变，无迁移。 |
| `2.10.6` | 2026-09-01 | `本次远端蒙版融合范围调整` | M08/UI-05、`ALG-LR-012` v1.0.3：仅将 ModelView 专用远端 mask 自适应外扩从 16–48px/短边20%提高为 24–64px/短边25%@2K，羽化仍为4–10px且原始核心保持255；Qwen、Capture、Generation、局部重绘画笔及历史恢复继续绑定未外扩作者 mask。返图直出、投影/UV、Schema、Revision和已有资产不变，无迁移；回退仅恢复 Worker 参数。 |
| `2.10.7` | 2026-09-01 | `6382583 + 本次 Qwen 选区原图上下文裁切` | M04/UI-05、`ALG-GEN-005` v1.7.0：服务端按未外扩原始 mask 包围盒从干净 Image 1 派生第四张上下文裁切，2K 默认约保留 64px，用于诊断、转换和一次格式修正时辨认真实选中部件。浏览器仍提交原三图，第四图不改变编辑范围、ModelView 输入或远端 mask；缓存策略升级为 `qwen-to-klein-selection-crop-v4`。Schema、Revision、资产及历史工程不变，无迁移；回退移除第四图并恢复 v3 指纹即可。 |
| `2.10.8` | 2026-09-01 | `6dd8667 + 本次局部重绘提示词格式容错修复` | M04、`ALG-GEN-005` v1.7.1：模板仍要求 100–180 词，服务端最终验收上限调整为 200 词，修复格式修正结果为 183 词时的误拒绝；新增 confine/restrict/limit 及 mask 外保持不变等明确范围表达识别，201 词及以上继续 fail-closed。诊断、四图、缓存、ModelView、mask、Schema、Revision 和资产不变，无迁移；回退恢复旧上限与正则即可。 |
| `2.10.9` | 2026-09-01 | `bb9e50a + 本次局部重绘蒙版范围确定性补全` | M04、`ALG-GEN-005` v1.7.2：Qwen 输出归一化后若首段缺少明确 mask 范围，服务端确定性追加固定保护句再执行完整格式校验，修复第二轮只剩 `masked_scope` 时的误失败；已有等价范围不重复。诊断、四图、缓存、ModelView、作者/远端 mask、Schema、Revision 和资产不变，无迁移；回退移除补全函数即可。 |
| `2.11.0` | 2026-09-01 | `bb9e50a + 本次局部重绘提示词软校验` | M04、`ALG-GEN-005` v1.8.0：模板格式约束改为脱敏质量告警，不再因段数、词数、语言、Markdown 或范围措辞拒绝非空正文，也不再二次调用 Qwen 修格式；mask 范围固定句仍确定性补齐。仅空结果、12000 字符上限、上游截断/content_filter、视觉输入和传输类错误阻断。四图、诊断、缓存、ModelView、mask、Schema、Revision 和资产不变，无迁移。 |
| `2.12.0` | 2026-09-01 | `4cbce31 + 本次局部重绘核心蒙版清理` | M08/UI-05、`ALG-LR-012` v1.1.0：ModelView 白灰几何融合不再直接混合细碎的原始抗锯齿 mask；Worker 新增 24/96 双阈值连通、2–6px@2K 闭运算、微小孤岛过滤、小孔填充及窄边羽化，并从清理后核生成既有 24–64px/4–10px 外扩羽化远端 mask。原始作者 mask 仍独立用于 Qwen、Capture、Generation、画笔、历史和回贴；GPU/shader/UV/export、Schema、Revision 与资产不变，无迁移。 |
| `2.13.0` | 2026-09-01 | `本次 Qwen → Klein 材质证据锚定提交` | M04/UI-05、`ALG-GEN-005` v1.9.0：通用模板改为先以 Image 2 对应部件、第四张干净选区裁切和 mask 外邻域共同确定真实结构与材质；仅在视觉证据证明白灰均匀表面为未完成占位时，要求 Klein 用明确目标材质完整替换 clay/primer/flat placeholder/untextured surface，同时保护真实浅色材质。禁止仅凭“修缝”发明拉丝钢、干净焊缝、倒角或无缝铸造，并禁止输出像素坐标；缓存策略升级为 v5。四图、诊断、ModelView 输入、mask、GPU/CPU/Worker/shader/UV/export、Schema、Revision 和资产不变，无迁移。 |
| `2.13.1` | 2026-09-01 | `1063a6c + 312e236 集成提交及后续省略式删除修复` | M13/M04、`LICLICK-ACCOUNT-BINDING` v1.0.0、`ALG-GEN-005` v1.9.2：合入当前飞书用户独立莉刻账号绑定，生图、编辑、轮询与通用润色使用用户独占 Atlas home 并 fail-closed；未知远端任务禁止探测。同时将“没有文字/不要文字”等确定识别为蒙版内无文字约束，并将“去除，保留某材质”等省略删除对象的表达解释为“蒙版内容即删除目标”；清除 Qwen 的保留/重建文字冲突句，禁止把选区误认成控制面板、标签或零件，也禁止从材质参考复制文字、数字、Logo、标签及伪文字，缓存策略升级为 v7。Project/Layer/Capture/Generation Schema、Revision、ownership 与资产不迁移。 |
| `2.13.2` | 2026-09-01 | `本次连续重绘单击接管修复` | UI-05/UI-10、M08、`ALG-LR-007` v2.0.6 / `ALG-LR-008` v2.2.2：生图成功记录一次性 pending Generation 并以 success revision 触发后台解码、目标层绑定和 GPU 预热；只有该新结果可以从上一代驻留 source 一次性接管，使第二次及后续生图的应用画笔首次点击即可直接绘制，同时保留历史结果编辑保护。GPU/CPU/Worker/shader、投影/UV/颜色公式、分辨率、Schema、Revision 与资产不变，无迁移。 |
| `2.13.3` | 2026-09-01 | `本次局部重绘即时点击排队与进度反馈修复` | UI-10、M08、`ALG-LR-007` v2.0.7 / `ALG-LR-008` v2.2.3：修复生图完成瞬间首次点击被工具条残余任务锁吞掉的问题；首次点击在成功回调、任务解锁与 Generation store ready 的短窗口内登记一次性内存请求，按钮立即显示旋转图标和流动进度条，结果就绪后自动进入画笔，无需第二次点击。其他互斥操作仍 fail-closed；失败、切工程/模型或新生成会清除请求。GPU/CPU/Worker/shader、投影/UV/颜色公式、分辨率、Schema、Revision、ownership 与资产不变，无迁移。 |
| `2.13.4` | 2026-09-01 | `本次局部重绘画笔视口反馈修复` | UI-06、M08、`ALG-LR-007` v2.0.8：修复有序投影栈接管活动局部重绘时，专用 overlay 与同 ID resident binding 被同时静音，造成画笔已更新右侧图层但视口无反馈的问题；显示权改为互斥兜底，ordered stack 接管时保留 resident binding，可见 overlay 接管时才静音 persisted twin。投影/coverage/颜色与分辨率、CPU/Worker/shader/UV/export、Schema、Revision、ownership 和资产不变，无迁移。 |
| `2.13.5` | 2026-09-01 | `本次局部重绘实时画笔反馈修复` | UI-06、M08、`ALG-LR-007` v2.0.9：修复持久层虽然可见，但 ordered projected stack 仍只读取上一次打包 mask，导致画笔实时 canvas 更新必须刷新后才显示的问题；应用画笔激活期间由专用 GPU overlay 临时接管，并同步静音 resident twin，离开工具或恢复后仍按原图层顺序显示。投影/coverage/颜色与分辨率、CPU/Worker/shader/UV/export、Schema、Revision、ownership 和资产不变，无迁移。 |
| `2.13.6` | 2026-09-01 | `本次局部重绘双阶段预览与当前层交接修复` | UI-06、M08、`ALG-LR-007` v2.1.0：修复当前局部重绘层二次进入画笔时先被静音、复杂实时 overlay 无输出导致旧笔画和新笔画同时消失，以及等待后仍需手动开关预览的问题。新增 renderer-only 简化 source+live-mask mesh preview 立即反馈；只有其实际可见时才静音当前同 ID persisted twin，其他重绘层不受影响；projected `contentRevision` 自动触发正式材质重建，离开画笔且确认正式层驻留后自动交接。最终 depth/surface-lock、coverage、颜色、1024 live 上限、UV/export、Schema、Revision、ownership 和资产不变，无迁移。 |
| `2.13.7` | 2026-09-01 | `本次局部重绘正式材质实时蒙版修复` | UI-06、M08/M06、`ALG-LR-007` v2.1.1：删除会与正式图层争夺显示权且缺少 depth/normal 的快速 duplicate mesh；已有局部重绘层始终保留在原 ordered projected material，以 projection-space live sampler 只替换当前 layerId 的 authored mask，使旧笔画与新笔画立即同屏反馈，同时继续使用正式 source、capture depth、surface-lock、图层顺序与颜色。无持久行的新结果仍用 depth-aware exact overlay，发布后自动交接；SceneRoot 晚到 marker 不再误静音正式层。CPU/Worker/UV/export、1024 live 上限、最终分辨率、Schema、Revision、ownership 与资产不变，无迁移。 |
| `2.13.8` | 2026-09-01 | `本次局部重绘首笔原子交接修复` | UI-06、M08/M06、`ALG-LR-007` v2.1.2：持久蒙版 URL/sampler 切换提前到画笔预热进度阶段，pointer-up 不再递增 projected 结构 `contentRevision`；新行 exact overlay 保留到 SceneRoot 最终材质驻留、live override 绑定并完整呈现一帧后，再通过两帧屏障原子撤下。修复首笔结束后短暂消失并伴随整栈重建卡顿的问题。项目保存继续把 live raw/blend mask 按 revision 持久化；CPU/Worker/shader coverage、depth/surface-lock、UV/export、最终分辨率、Schema、Project Revision、ownership 与资产类别不变，旧工程惰性提升，无批量迁移。 |
| `2.13.9` | 2026-09-01 | `本次飞书登录安全关联莉刻账号修复` | M13、`LICLICK-ACCOUNT-BINDING` v1.1.0：飞书/IDaaS 登录成功后自动进入同源莉刻账号关联，服务端通过 Atlas SkillHub 2.9.1 loopback-only `authenticate` bridge 转交回调令牌并由运行时写入加密缓存；绑定前强制校验 secure cache、有效期、莉刻网关工具、Atlas/飞书 email 一致性与 OAuth 任务归属。禁止 LI3D 写明文 token，运行时不兼容、失败或超时时 fail-closed 并清理临时目录，不回退共享账号。Project/Layer/Capture/Generation Schema、Revision、ownership 与资产不变，无迁移。 |
| `2.13.10` | 2026-09-02 | `本次局部重绘画笔激活转圈自愈修复` | UI-10、M08、`ALG-LR-008` v2.2.4：将画笔排队从 boolean 改为 Generation/目标层级内存请求，过渡期在生成回调时绑定确切结果，旧 GPU 事件不再误解锁；预载、后台预热和点击共用 preferred/时间排序的确定性 Generation 选择。预热取消/跳过会结束 stage；生图结束解锁后 8 秒 watchdog 会按 GPU-ready 标记自愈重放，否则释放转圈并提示重试。已有局部重绘图层和显示权持续保留；GPU/CPU/Worker/shader、投影/UV/export、分辨率、Schema、Revision、ownership 与资产不变，无迁移。 |
| `2.13.11` | 2026-09-02 | `本次局部重绘 GPU 加载链路修复` | UI-10、M08、`ALG-LR-008` v2.2.5：移除 8 秒 watchdog，修复刷新/连续生成后最新 source 与旧 GPU-ready 分离的根因。被动恢复的 `autoActivate=false` source 允许最新 Generation 接管；source 已匹配但 renderer 未 ready 时，通过内存 prepare revision 显式重跑解码、蒙版、GPU 纹理和目标层绑定，并由精确 ready/failed 事件结束等待。真实工程刷新后最新 Generation 与 GPU-ready 一致，驻留点击约 7.1ms；历史局部重绘图层和显示权持续保留。shader、CPU/Worker 算法、投影/UV/export、分辨率、Schema、Revision、ownership 与资产不变，无迁移。 |
| `2.13.12` | 2026-09-02 | `本次局部重绘实时显示权修复` | UI-06、M08、`ALG-LR-007` v2.1.3：应用画笔激活时由 depth-aware exact GPU overlay 独占当前编辑层显示，已持久 resident twin 保持驻留但临时静音；退出后经原子呈现屏障交回 resident row。修复 live canvas 和图层缩略图已更新但视口仍显示旧 mask 的冲突，其他历史局部重绘层保持显示。投影/颜色公式、作者 mask、CPU/Worker/shader/UV/export、分辨率、Schema、Revision、ownership 与资产不变，无迁移。 |
| `2.14.0` | 2026-09-02 | `52c4e71 + 本次全链路性能观测提交` | M08/M13/M15、`ALG-LR-007` v2.1.3 / `ALG-LR-008` v2.2.4 / `ALG-PERF-SESSION-001` v1.1.0：同步 generation-scoped 局部重绘 GPU 预热事件握手和 microtask 提前启动，画笔只在 Generation 与 GPU 同时 ready 后自动重放，移除 rAF 轮询；`perfLab=1` 按需启用根 React Profiler，汇总业务 timeline、React commit 与实际 JS chunk 传输/解压/加载耗时，并设置错误、卡死、结果不一致、帧稳定、交互延迟、算法速度/效果和长时内存硬门禁。采集只读且隐私过滤，不写 Project/Scene/Layer/Generation，不改变算法公式、分辨率、Schema、Revision、ownership 或资产，无迁移。 |
| `2.14.1` | 2026-09-02 | `29e6750 + 58dd8b1 本地合并基线` | 合入远端运行时性能采集、投影降级、橡皮擦历史开销、局部重绘 worker/PNG 编码与云端包体门禁优化；同时保留 `ALG-LR-007` v2.1.4 的实时 overlay 显示权、历史图层持续显示和原子交接，以及 `ALG-LR-008` v2.2.6 的精确 GPU 准备自愈与事件握手。Project/Layer/Generation/Capture Schema、Revision、ownership 与资产不变，无迁移。 |
| `2.15.0` | 2026-09-02 | `本次局部重绘统一会话与单显示所有权修复` | UI-06/UI-10、M08、`ALG-LR-007` v2.2.0 / `ALG-LR-008` v2.3.0：以 generation/target/sessionId 的唯一内存 Session 串行推进资源、蒙版、正式材质和渲染帧准备，拒绝旧任务晚到事件；共享 projected material 成为唯一显示 owner，移除活动画笔对 dedicated overlay 与 resident twin 的切换；pointer-down 只消费 ready 资源。总准备 20 秒、正式绑定 10 秒后明确失败，不再无限转圈。Schema、Revision、ownership、投影/颜色/分辨率与已有资产不变，无迁移。 |
| `2.15.1` | 2026-09-02 | `本次普通投影橡皮首笔原子交接修复` | UI-06/UI-10、M05/M06/M08、`ALG-ERASE-001` v1.3.1：橡皮激活时通过 renderer-only live preview 预热与首笔提交相同的稳定 UV keep-mask URL，首笔抬起只更新 CanvasTexture 与 Layer 内容，不再从无 mask 切换到新 mask 后重建整套投影纹理数组，消除擦除先显示、回弹、3000ms 补缝后再恢复的问题。不落笔不修改项目；覆盖、历史、补缝、持久化、分辨率、Schema、Revision、ownership 与资产类别不变，无迁移。 |
| `2.15.2` | 2026-09-02 | `本次投影橡皮显隐持久修复` | UI-06/UI-10、M05/M06/M08、`ALG-ERASE-001` v1.3.2：纹理数组键纳入 live keep-mask revision，取消旧蒙版快照并重打包当前像素；新 array 驻留前保留累计 live multiplier，原子发布后再清除，修复擦除后关闭/重开图层预览恢复旧效果。direct 路径、覆盖、历史、补缝、持久化、分辨率、Schema、Revision、ownership 与资产类别不变，无迁移。 |
| `2.15.3` | 2026-09-02 | `本次投影蒙版统一原子交接修复` | UI-06/UI-10、M05/M06/M08、`ALG-ERASE-001` v1.3.3：按本地真实源码链路消除输入层与材质层的双重清理权；`endLiveEraserPreview()` 只结束输入/注册表状态，SceneRoot 根据已提交结构键独占 GPU live multiplier 到持久 keep-mask 的原子交接。覆盖 A100 逐层显示常见的 direct 路径和多层 array 路径，修复本地快路径正常而 A100 慢恢复路径关开预览丢失擦除的差异。覆盖、历史、补缝、持久化、分辨率、Schema、Revision、ownership 与资产类别不变，无迁移。 |
| `2.15.4` | 2026-09-02 | `本次烘焙资产文件选择修复` | UI-14/M10：A100 实际页面复现低模卡片未产生 filechooser；将一键烘焙高低模卡片和 Base Color/Roughness/Metallic/Normal 槽位改为原生 label-input 关联，文件输入从 `display:none` 改为视觉隐藏但保持渲染，专业页统一优先 `showPicker()` 并保留 click 回退。修复受管 Edge/HTTP 部署中低模与材质贴图无法选择的问题；拖放、格式/UV 校验、配对、上传、Schema、Revision、ownership 与资产类别不变，无迁移。 |
| `2.15.5` | 2026-09-03 | `本次烘焙原生文件控件直达修复` | UI-14/M10：A100 实测 label-input 转发仍未稳定触发文件选择；一键烘焙高低模卡片与 Base Color/Roughness/Metallic/Normal 槽位改由透明的真实文件输入覆盖点击区域，用户手势直接命中文件控件，不再经过程序化唤起或 label 转发。专业页 `showPicker()` 回退、拖放、格式/UV 校验、配对、上传、Schema、Revision、ownership 与资产类别不变，无迁移。 |
| `2.15.6` | 2026-09-03 | `本次烘焙导入事务对齐修复` | UI-14/M10：低模与 Base Color/Roughness/Metallic/Normal 导入对齐高模的完整异步生命周期；文件选择或拖放后等待对象存储上传与 Bake Workspace 保存，成功后低模才进入对齐，失败则回滚临时文件状态并保留明确错误。导入期间禁用对应原生文件控件并显示进行中状态，避免重复提交和“界面已导入但项目未保存”。Schema、Revision、ownership、资产类别与 Bake 算法不变，无迁移。 |
| `2.15.7` | 2026-09-03 | `本次烘焙低模与纹理即时显示恢复` | UI-14/M10：以已验证版本 `9615caf1` 为基线恢复低模及 Base Color/Roughness/Metallic/Normal 的即时浏览器状态更新；选择文件后立刻显示，上传和项目持久化继续由后台保存队列执行，保存失败只报告错误，不再回滚已读取文件或提前切换阶段。保留 A100 所需的透明真实文件控件，修复“正在导入结束后模型消失”。Schema、Revision、ownership、资产类别与 Bake 算法不变，无迁移。 |
| `2.15.8` | 2026-09-03 | `本次烘焙低模解码链路对齐修复` | UI-14/M02/M10：低模导入对齐高模的本地解码生命周期，透明原生文件控件支持同时选择 BIN/MTL/贴图伴随资源，其中外部 GLTF buffer/贴图由 LoadingManager 映射到同次选择的本地文件；文件名立即显示，共享 `loadModelFromFile` 解码成功后才标记可用并提交后台持久化，失败保留选择并显示明确错误。导入时的检查结果直接复用于 UV/对齐检查，并保留容器单位缩放元数据，避免二次解码和刷新后对齐偏差。低模上传和项目保存仍在成功读取后由后台队列执行，不提前切换阶段。Schema、Revision、ownership、资产类别与 Bake 算法不变，无迁移。 |
| `2.16.0` | 2026-09-03 | `本次局部重绘等待与图层选择修复` | M08 ALG-LR-008 v2.4.1、M06 ALG-PROJ-006 v2.0.1、M04 ALG-GEN-005 v1.10.0：生图期间提前编译并持有 exact overlay，修复无效 resident 等待与绑定死等；自动分析合并为一次四图请求；应用重绘使用独立结果图层并保持用户原选择，UV/投影/无选择均不阻断。真实项目 resident 等待 0ms、覆盖层编译 0.5ms、按钮响应帧 11.3ms；回归与构建通过，无分辨率、Schema 或资产迁移。 |
| `2.16.1` | 2026-09-03 | `本次莉刻账号绑定公开路径修复` | M13、`LICLICK-ACCOUNT-BINDING` v1.1.1：账号绑定的 IDaaS Service URL 合并 `LICLICK_PUBLIC_PATH`，A100 从错误的 `/api/liclick/account-binding/callback` 修正为 `/li3d/api/liclick/account-binding/callback`；任意具备莉刻权限且邮箱与当前飞书 Session 一致的用户均可绑定自己的独立账号。无显式 public path 时继续回退公开 URL pathname；令牌、独立 Atlas home、Schema、Revision、ownership 与资产不变，无迁移。 |
| `2.16.2` | 2026-09-03 | `本次 A100 测试共享莉刻账号开关` | M13、`LICLICK-ACCOUNT-BINDING` v1.2.0：增加默认关闭且仅由服务器 `app.env` 激活的测试共享账号模式；飞书 Session 与 Li3D 项目/Job ownership 继续隔离，但所有莉刻调用、额度、远端个人工作区和生成资产归属配置 owner。共享 Atlas home 必须位于受管目录，账号状态显式标记共享模式，用户菜单不能解绑或删除 owner 凭据；关闭开关立即恢复个人绑定。Token、密钥和具体人员邮箱不进入 Git，无 Schema、Revision 或资产迁移。 |
| `2.16.3` | 2026-09-03 | `本次烘焙资产对象标识迁移修复` | UI-14/M10：修复首次在烘焙页导入高模时空字符串通过空值合并并把整个 Bake Set 写入 `bakeSets[""]` 的问题。高模、低模和材质导入统一选择首个非空对象 ID；读取旧工程时把空键、高模快照及所含低模/颜色/粗糙度/金属度/法线引用原位迁移到稳定项目级 Bake ID，下一次正常保存写回规范结构。低模选择立即显示，解析、UV/对齐检查与资产保存继续异步执行；失败保留文件名并显示明确原因。资产文件、ownership、Revision 与烘焙算法不变，无批量数据库迁移。 |
| `2.16.4` | 2026-09-03 | `master 5f880fd + release cd30512` | M15 / CLOUD-DEPLOYMENT v1.0.0：适配 Cloud 镜像、PostgreSQL 初始化、部署门禁与凭据隔离，master 验证两个镜像，不执行生产发布；业务协议不变，保留存量数据，迁移与回滚见变更单。 |
| `2.16.5` | 2026-09-03 | `本次高频滚轮重复拾取修复` | UI-06/M03、`ALG-VIEW-INPUT-001` v1.0.0：跳过 R3F 原始 wheel 的无用模型拾取，完整滚轮增量继续交给原生相机控制器按帧执行。真实分发回归覆盖 1021→0 拾取、透视/正交缩放、点击/空白选择和监听清理。无画质、算法输出、Schema、Revision 或资产迁移；回退恢复默认 Canvas 事件分发。 |
| `2.16.6` | 2026-09-03 | `本次多模型快速选择驻留修复` | UI-04/UI-06/M03、`ALG-VIEW-SELECT-001` v1.0.0：复用选中框，跳过不改变取景的全场景 bounds；空闲后才分配预热资源，分阶段检查模型/工具及交互。无图像算法、画质、Schema 或数据迁移，九模型实际帧稳定性复测未通过，不能认定已消除卡顿。 |
| `2.16.7` | 2026-09-03 | `本次隐藏缩略图消费者门控` | UI-09/M08、`ALG-LR-011` v1.0.1：以真实 LoAF 定位多模型切换时隐藏图层缩略图的同步像素处理；不可见/零面积时不挂载预览消费者，可见后使用原完整管线。无图像公式、输出质量、Schema 或资产迁移；页面体验待新构建复测。 |
| `2.16.8` | 2026-09-03 | `本次局部重绘后台任务等待修复` | UI-05/UI-06/M08、`ALG-LR-008` v2.4.2：提交及返图 GPU 准备不再依赖裸 rAF，使用既有后台兜底；保留真实呈现、画笔互斥与任务身份校验。不保证冻结/丢弃页执行，无 Schema、图像质量或资产迁移。 |
| `2.16.9` | 2026-09-03 | `本次选中边框所有权修复` | UI-04/UI-06/M03、`ALG-VIEW-SELECT-001` v1.0.1：呈现前核对权威选择，捕获恢复只执行一次，避免旧显隐/材质快照回写。保留资源复用、静止帧零 bounds 上传；无捕获像素、画质、Schema 或数据迁移。 |
| `2.16.10` | 2026-09-03 | `a06f421` | 移除不可达的旧预览分支；完整发布参数构建及包体门禁通过，不提高预算、不改变可达像素处理。 |
| `2.16.11` | 2026-09-03 | `本次贴图预览任务调度` | M08、`ALG-LR-011` v1.1.0：串行空闲预览、消费者取消、有界 LRU、隐藏结果门控及面板归属保护；78 项 Web 回归通过，完整发布参数包体 3,121,381 字节低于原门禁。无图像公式、输出分辨率或持久化迁移。 |
| `2.16.12` | 2026-09-03 | `本次局部重绘蒙版持久化边界修复` | UI-06/UI-10、M01/M08/M14、`ALG-LR-008` v2.4.2：局部重绘 live canvas 保存统一读取 canvas/image 注册源并编码上传，按 URL/revision 和资产槽复用 verified asset；注册源已释放且没有已验证映射时本次保存失败重试，禁止把 `liclick-live-projected-canvas:` 写进 Revision。服务端将 live/blob 视为 volatile，优先保留同图层上一 Revision 的 durable mask/source，否则返回 `PROJECT_SAVE_CONFLICT`。GPU/CPU/Worker/shader、coverage、投影/UV/export、分辨率、Schema 与 ownership 不变；旧坏 Revision 保留审计，可从最近 durable Revision 原位恢复，无批量迁移。 |
| `2.16.13` | 2026-09-03 | `本次模型删除撤回运行时恢复修复` | UI-04、M01/M03/M12、`OBJECT-DELETE-HISTORY` v1.0.0：模型删除改为完整 runtime 历史事务；撤回同步复用被删 Three.js 实例并恢复对象、选择、变换、图层、Generation/Capture、参考图、烘焙与 Bake Workspace，清除删除墓碑，重做再次执行完整删除；实例缺失时按 durable source 渐进恢复。保留最新 Revision CAS/asset manifest/lastSavedAt，不回滚服务端并发状态。Project Schema、对象资产格式、GPU/CPU/Worker/shader、投影/UV/export 与 ownership 不变，无迁移。 |
| `2.16.14` | 2026-09-03 | `本次贴图导入自动聚焦修复` | UI-04/M02/M03、`MODEL-IMPORT-CAMERA-FOCUS` v1.0.0：贴图工作区导入模型完成并发布到 SceneStore 后，立即复用 F 键的轨道中心聚焦，将相机与 target 同量平移到新模型中心；保持观察方向、距离、投影、模型排列和变换不变。场景/法线/导出、项目恢复、Schema、Revision、资产与 ownership 不变，无迁移。 |
| `2.16.15` | 2026-09-03 | `本次投影橡皮纹理级原子交接修复` | UI-06/UI-10、M03/M06/M12、`ALG-ERASE-001` v1.3.4：普通 projected 橡皮提交和历史恢复直接把正式全分辨率 CanvasTexture 提升到所有驻留材质，验证全部绑定后才撤下实时 multiplier；图层、眼睛或预览在提交中切换时保留 root，最后一个 pending commit 完成后再清理。修复擦除后切换图层/预览旧内容回弹、刷新后才恢复的问题；覆盖公式、补缝、持久化、分辨率、Schema、资产与 ownership 不变，无迁移。 |
| `2.16.16` | 2026-09-03 | `本次场景变换手柄视觉中心修复` | UI-04/M03/M12、`OBJECT-TRANSFORM-PIVOT` v1.0.0：场景移动、旋转、缩放不再把 TransformControls 直接绑定到可能带 FBX/GLTF 原始枢轴偏移的模型根节点，而以当前世界包围盒中心创建独立代理枢轴；拖动期间用代理世界矩阵相对起点的增量驱动完整模型，正确换算父级矩阵，结束后仍走既有 Transform、BoundingBox、Project 保存与历史事务。切换模型、撤回或外部变换会重新对齐代理；不修改模型层级、顶点、导入归一化、场景排列、Schema、Revision、资产或 ownership，无迁移。 |
| `2.16.17` | 2026-09-03 | `本次局部重绘结果图层自动选择修复` | UI-06/UI-10/M08、`LOCAL-REPAINT-RESULT-SELECTION` v1.0.0：新局部重绘结果真正发布到可见图层栈时保持 `setLayers` 对首个可见新结果的选择，使其立即高亮并成为当前编辑层；已发布结果的后台刷新、空白目标准备、GPU 预热仍保留用户当时选择，不提前跳层，也不强制展开图层面板。投影、蒙版、GPU/CPU/Worker/shader、UV/export、Schema、Revision、ownership 与资产不变，无迁移。 |
| `2.16.18` | 2026-09-03 | `本次项目恢复模型贴图原子显示修复` | UI-04/M02/M03/M12、`PROJECT-TEXTURED-ATOMIC-REVEAL` v1.0.0：刷新或打开项目时，服务端项目数据返回前显示页面加载动画；进入视口后，每个恢复模型在自身位置独立显示旋转动画，bounds、outline 与 512px proxy 保持隐藏，只在该模型 full 阶段且权威 UV/投影材质绑定完成后立即单独显示，不等待其他模型。无贴图模型在 full 阶段显示最终白模；普通手动导入不延迟。合并性能版与本次功能后的生产 JS 实测 3,125,470 bytes，总预算重定标为 3,134,000 bytes，仍保留约 8 KiB 余量且 shell/editor/bake/shared 分包硬门禁不变。模型、材质、投影、UV、Schema、Revision、资产与 ownership 不变，无迁移。 |
| `2.16.19` | 2026-09-03 | `本次局部重绘交互计算与上传分段` | M08、`ALG-LR-008` v2.4.3：返图三纹理上传间显式让帧并检查取消；`ALG-LR-007` v2.2.0 像素语义不变的内侧羽化双扫描/查表输出，作者蒙版读回提示。216 组逐像素对照和实际上传片段回归通过；浏览器端到端体验待验收，无数据迁移。 |
| `2.16.20` | 2026-09-03 | `本次实时纹理重复上传修复` | M06、`ALG-PROJ-007` v2.1.1：未变的 live source/mask 读取不再置脏，显式发布、参数变化、backing 替换和持久化 revision 契约保留；新增多层读取及写入回归，不改像素/分辨率/Schema，无迁移。 |
| `2.16.21` | 2026-09-03 | `本次重绘层无效驻留等待修复` | M08、`ALG-LR-008` v2.4.4：准备/来源切换/退出等待遵循既有 merged UV 显示边界，不再等待不会进入材质的旧重绘行；实际显示图层保留真实绑定屏障，不改 UV 合成或持久化，无迁移。 |
| `2.16.22` | 2026-09-03 | `本次材质编译与发布调度修复` | M06、`ALG-PROJ-007` v2.1.2：抢先预热限 outline，direct 材质链接完成后发布，正式编译加入已有 cold warmup，修正 Promise Map 清理身份；shader/像素/分辨率/持久化不变，无迁移。 |
| `2.16.23` | 2026-09-03 | `本次原生画笔尾部重复拾取修复` | M03、`ALG-VIEW-INPUT-001` v1.1.0：按 canvas/pointer 路由画笔已接管的 up/click 尾部，保留原生提交与 R3F 选择/捕获；60 笔 120→0 多余拾取。像素/分辨率/持久化不变，无迁移。 |
| `2.16.24` | 2026-09-03 | `本次捕获首次等待状态隔离修复` | M03、`ALG-CAP-006` v1.0.0：离屏捕获首次及逐 tile/pass 等待前恢复 renderer/背景，重绑捕获 clear 值；真实函数边界/完整像素/异常清理回归。无输出尺寸、Schema、资产迁移。 |
| `2.17.0` | 2026-09-04 | `本次单/多视图统一质量合成` | UI-05/UI-06/UI-09、M04/M05/M06/M07，`ALG-PROJ-004/005` v3.0.0、`ALG-UV-004` v4.0.0：普通单视图不再作为 priority source-over，也不再生成距离场 Alpha；单+单、单+多统一进入 Top-3 coverage/depth/angle/颜色一致性合成。旧 priority 行读取时惰性迁移，局部重绘 literal、显式 Overlay、UV 层级保持。删除 priority shader/uniform 与 CPU overlay 分支；Project/Layer 持久字段、Revision、ownership、分辨率和历史资产不批量迁移。 |
| `2.17.1` | 2026-09-04 | `本次局部返图显示读取分段` | M08、`ALG-LR-011` v1.1.1：显示原图/depth 异步解码与分条读取，完整绘制及 RGBA 不变，条间让任务/交互空闲/取消；默认消费者不变。无分辨率、阈值、Schema 或资产迁移；真实返图帧稳定性待验收。 |
| `2.17.2` | 2026-09-04 | `本次 IDaaS 个人莉刻账号固定回调及 QA 接入` | M13、`LICLICK-ACCOUNT-BINDING` v1.3.0：JWT 应用使用固定注册 callback，SP 发起改传同源一次性 `target_url`，删除动态 `redirect_uri/state`；回调校验 origin/path/唯一 UUID并立即清除令牌 URL。Cloud 配置启用 QA JWT 应用 `LI3D-QA`（`testplugin_jwt92`）用于三名已授权用户的隔离验收；每个飞书用户仍只绑定自己的独立 Atlas home，共享测试账号默认关闭。无 Schema、ownership 或资产迁移。 |
| `2.17.3` | 2026-09-04 | `本次本地与 Cloud IDaaS 回调模式隔离` | M13、`LICLICK-ACCOUNT-BINDING` v1.3.1：Cloud 仅在显式启用 QA JWT SP 时使用固定 callback/`target_url`；本地 4517 恢复 Atlas SkillHub 原生固定 `localhost:20265/callback` 登录并在子进程完成后绑定个人 Atlas home，修复清除历史 Token 后动态 LI3D Service 地址被拒、无法重建个人绑定的回归。两条路径仍共用 Atlas 安全缓存、工具权限与飞书/莉刻邮箱一致性门禁；无 Schema、ownership 或资产迁移。 |
| `2.17.4` | 2026-09-04 | `本次 K8s 个人 IDaaS Token 模式隔离` | M13、`LICLICK-ACCOUNT-BINDING` v1.3.2：仅为明确用户 Atlas home 的子进程移除 Atlas 2.9.1 的 K8s/ArkClaw/TIP 自动探测信号，确保固定 HTTPS 回调写入的个人 IDaaS Token 被用于权限校验与业务调用；机器级调用仍保留 TIP 语义。用户 Token 不进入环境变量，不回退公共账号；无 Schema、ownership、资产或个人 home 迁移。 |
| `2.17.5` | 2026-09-04 | `本次 QA IDaaS 与 Atlas Gateway 环境配对` | M13、`LICLICK-ACCOUNT-BINDING` v1.3.3：当前 `LI3D-QA` 显式使用 test Atlas Gateway，正式 IDaaS 使用 prod Gateway；启动与缓存校验均拒绝跨环境 Token，修复 QA JWT 被生产 Gateway 以 `invalid_token` 拒绝。无 Schema、ownership 或资产迁移。 |
| `2.17.6` | 2026-09-07 | `本次选择预热元数据复制优化` | M03、`ALG-VIEW-SELECT-001` v1.0.2：编译网格跳过 userData 及原材质序列化，保留 Three 子类复制契约；真实复制热点 389.8ms，整体帧稳定性尚未达标。无像素、Schema 或数据迁移。 |
| `2.17.7` | 2026-09-07 | `本次预览缓存并发持有修复` | M06、`ALG-PROJ-007` v2.1.3：普通 hook 与 bulk 共用解码到上传完成的引用计数保护，取消不发布过期纹理，结束后恢复 24 项上限。并发 26 张 4K 回归通过；无像素、Schema 或数据迁移。 |
| `2.17.8` | 2026-09-07 | `本次显示预览阶段让帧与精确边界优化` | M08、`ALG-LR-011` v1.1.2：重处理阶段跨呈现边界并检查取消；逐行首末非零 Alpha 给出相同裁切范围。400 组边界及预览回归通过；九模型热缓存 P95 约 83→67ms，首次编译仍有 651ms 峰值。无像素/分辨率/Schema 或数据迁移。 |
| `2.17.9` | 2026-09-07 | `本次选择预热串行调度` | M03、`ALG-VIEW-SELECT-001` v1.0.3：等待旧原生编译终态，过期选择入队后跳过；最终选择的完整预热、失败及 renderer 隔离保留。无像素/Schema 或迁移，单次编译尖峰仍待定位。 |
| `2.17.10` | 2026-09-07 | `本次显示遮罩 CPU 优化` | M08、`ALG-LR-011` v1.1.3：透明像素短路、RGB 标量判定、深度清零按字访问；冻结旧实现 600 组输出逐字节一致。隔离 CPU 收益不代表整体流畅度达标，无算法语义/Schema 或迁移。 |
| `2.17.11` | 2026-09-07 | `本次线框辅助层驻留` | M03、`ALG-VIEW-SELECT-001` v1.0.4：模型隐藏保留已预热线框，只切显隐；71 次切换保持一次编译/真实几何预热，真实卸载释放。捕获/导出继续排除辅助层，无像素/Schema 或迁移。 |
| `2.18.0` | 2026-09-07 | `本次图层小缩略图缓存` | M08、`ALG-LR-011` v1.2.0：明确为 48px 图层小图派生 128px 有界缓存，复用原投射遮罩/裁切；原图、放大预览、UV/export、蒙版及 Schema 不变，无迁移。 |
| `2.18.1` | 2026-09-07 | `本次显示临时画布及时释放` | M08、`ALG-LR-011` v1.2.1：完整读回/缩放后以及取消/异常时释放 scratch bitmap，保留输出 RGBA 与图像处理顺序；共享 PNG helper 消除重复编码入口。无分辨率、算法语义、Schema 或数据迁移。 |
| `2.18.2` | 2026-09-07 | `本次 master 正式发布包体复查` | M08/M15、`ALG-LR-011` v1.2.1 不变：共用原裁切和边界公式，保留各路径留白/回退；正式 Cloud 发布包体 3,133,956 bytes 通过原门禁，无算法、Schema 或数据迁移。 |
| `2.18.3` | 2026-09-07 | `本次单/多视图主提示词统一` | UI-05/M04、`ALG-GEN-001/002` v1.1.0：删除旧的全表面迁移提示词，单视图初始白模、已有贴图补全及多视图统一使用白模区域补全模板；用户补充要求仍追加在统一模板末尾。生成输入图片、蒙版、供应方、轮询、投影、分辨率、Schema、Revision、ownership 与资产不变，无迁移；回退仅恢复旧模板分流。 |
| `2.18.4` | 2026-09-07 | `本次重绘共享图片显式解码` | M08、`ALG-LR-008` v2.4.5：加载器等待原图 decode 后发布共享 Promise，保留失败兼容、六项 LRU、调用方取消及原始像素/尺寸。无算法语义、Schema 或数据迁移。 |
| `2.18.5` | 2026-09-07 | `本次全仓性能审计与列表查询裁剪` | M14/M01、`PERF-PROJECT-LIST-001` v1.0.0：数据库仅返回原 JSON 摘要字段，保留隔离/排序/默认值；11 项后端回归通过。443 个代码文件静态筛查，其他候选热点列入审计清单。无图像算法、Schema 或数据迁移。 |
| `2.18.6` | 2026-09-07 | `同步 master 后继续烘焙 I/O 优化` | M10、`PERF-BAKE-IO-001` v1.0.0：粗糙度阶段整图读写异步化，保留校验与发布顺序。保留上游提示词/解码修复；无算法语义、Schema 或数据迁移。 |
| `2.18.7` | 2026-09-07 | `ZIP 导出重复整包复制移除` | M11、`PERF-EXPORT-ZIP-001` v1.0.0：直接由 Blob 快照 ArrayBuffer-backed 视图，完整 ZIP 字节对照与输入隔离通过，无格式、像素、Schema 或数据迁移。 |
| `2.18.8` | 2026-09-07 | `模型工程订阅缩窄` | M03、`PERF-VIEW-PROJECT-001` v1.0.0：只订阅 id/captures/bakedTextures，阻止无关工程字段使所有模型订阅失效；缓存算法和完整图像结果不变，无迁移。 |
| `2.18.9` | 2026-09-07 | `ZIP CRC 索引读取` | M11、`PERF-EXPORT-ZIP-001` v1.0.1：16 MiB 隔离 CRC 中位 80.55→26.25ms，400 组与完整 ZIP 精确对照通过；无字节/Schema/分辨率或数据迁移。 |
| `2.18.10` | 2026-09-07 | `后端流式 ZIP CRC 优化` | M11/M10、`PERF-EXPORT-ZIP-001` v1.0.2：64 KiB 分块累计校验中位 46.90→25.60ms；真实流背压及归档字节对照通过，无算法语义/Schema 或数据迁移。 |
| `2.18.11` | 2026-09-07 | `master 集成与交接测试夹具补全` | M15：保留 4fe9a58 运行时修复，补齐可见根节点/对象身份测试；旧断言与隐藏/跨对象/legacy 用例并存，不更改业务算法或数据。 |
| `2.18.12` | 2026-09-07 | `中断下载释放文件句柄` | M14/M01、`FILE-RESPONSE-LIFETIME` v1.0.0：共享 pipeline 关闭被取消的模型/图片响应源流，防止 Windows 文件占用阻碍回收站移动；无算法或数据迁移。 |
| `2.18.13` | 2026-09-08 | `官方生产 IDaaS 应用接入配置` | M13、`LICLICK-ACCOUNT-BINDING` v1.3.4：官方 lilithplugin_jwt62/lilith 与 prod Gateway 配对，保持根路径固定回调、target_url 和个人账号隔离；增加部署配置及生产 URL 回归。实际发布、正式授权和多用户生图待验收，无 Schema 或数据迁移。 |
| `2.18.17` | 2026-09-08 | `本次投影橡皮跨界面重建交接修复` | UI-05/UI-06/UI-09/UI-10、M04/M05/M06/M08/M12，`ALG-ERASE-001` v1.3.5：全分辨率 projected keep-mask 提交未完成时同时保留对象 root 与共享实时蒙版权威，使单视图准备、切层和预览开关产生的新材质继续绑定已擦结果；正式蒙版验证驻留后再清理。覆盖公式、分辨率、Schema、Revision、ownership 与资产不变，无迁移。 |
| `2.18.18` | 2026-09-08 | `本次投影橡皮材质驻留交接修复` | UI-05/UI-06/UI-09/UI-10、M04/M05/M06/M08/M12，`ALG-ERASE-001` v1.3.6：在像素提交后继续保留实时 keep-mask，直到新 projected 材质确认绑定当前 mask URL；切换图层复用实时采样器前等待两段交接，修复单视图、选择图层及预览切换后的旧蒙版回弹。覆盖公式、分辨率、Schema、Revision、ownership 与资产不变，无迁移。 |
| `2.18.19` | 2026-09-08 | `本次 GPT2 单/多视图材质补全模板精简` | UI-05/M04、`ALG-GEN-001/002` v1.2.0：单视图初始白模、已有贴图补全与多视图统一使用新模板；图一锁定几何、轮廓、视图和排版，图二只控制白模内部的特有材质，并排除低模分面明暗。服务端同步识别新模板，不再追加旧光照约束。输入图、供应方、投影、分辨率、Schema、Revision、ownership 与资产不变，无迁移。 |
| `2.18.20` | 2026-09-08 | `ModelView 远端多视图逐视角生成与回贴` | UI-05/UI-06/UI-12、M03/M04/M05/M06/M09/M12/M15，`ALG-GEN-006` v1.0.0：多视图可选远端，按最近相机方向串行执行；每张返图先投影并等待材质驻留，后一视角再捕获当前效果。完全覆盖跳过，部分覆盖复用外扩蒙版，中断停止当前及后续请求。不改提示词、投影公式、分辨率、Schema、Revision、ownership 或资产，无迁移。 |
| `2.18.21` | 2026-09-08 | `后台多视图参考生成保持当前页签` | UI-05/M04：自动补全配对多视图参考图后只更新参考图状态，不再强制切换生成页签、预览模式或视图模式；单视图任务完成后仍停留在单视图。生成资产与后续管线不变，无 Schema 或数据迁移。 |
| `2.18.22` | 2026-09-08 | `UV 导入模型上限放宽至 7 万面` | UI-14/M10：Auto UV 导入前置限制由 20,000 调整为 70,000，并同步阈值提示；贴图工作区和本地 UV 内核的 200 万安全上限不变，无 Schema 或数据迁移。 |
| `2.18.23` | 2026-09-08 | `远端多视图顺序与顶底 GPT2 混合生成` | UI-05/UI-06/UI-12、M03/M04/M05/M06/M09/M12/M15，`ALG-GEN-006` v1.1.0：预览与执行共用维护者指定顺序，新增视角按普通/顶部/底部分组插入；顶底及接近极向的自定义视角使用 GPT2，其余使用 ModelView，继续逐张回贴驻留后再生成下一张。无分辨率、提示词模板、投影公式、Schema、Revision、ownership 或资产迁移。 |

`ALG-LR-008` v2.4.1：局部重绘仍自动创建独立目标和结果图层；pointer-down 不再依赖当前图层是否选中、可见或为 UV，只检查自身 source/composite/Session/显示资源。默认保持按钮激活、GPU promotion、结果发布前的原选择（含 undefined），防止内部隐藏 draft 触发面板选择普通投影层。普通画笔/橡皮擦限制、GPU/CPU/Worker/shader、作者 mask、投影/UV/export、分辨率、Schema、Revision、ownership 与资产不变。真实 store 三类选择与入口 gate 回归通过；无数据迁移，回退选择保持与 gate 即可。详见 CHG-20260903-LOCAL-REPAINT-SELECTION-INDEPENDENCE。

`ALG-LR-008` v2.4.2 将浏览器运行期 `liclick-live-projected-canvas:` 与项目资产契约彻底分离。前端保存时必须从 live canvas/image 注册表取得同一 revision 的像素、编码 PNG 并上传；成功后按项目/槽位/source URL 保留 verified asset 映射，使 GPU 注册源稍后释放也能安全复用。若 live source 已释放且从未上传，保存队列保留当前内存画面并重试，不创建不可重开的 Revision。服务端二次校验 `maskUrl`、`localRepaintMaskUrl`、`depthUrl`、`localRepaintSourceUrl` 和 projected `imageUrl`，volatile 值只能回退到同层上一 Revision 的 durable URL，否则以 Revision 冲突拒绝。该变更不修改 GPU/CPU/Worker/shader、coverage、depth/surface-lock、投影/UV/export、分辨率、Project/Layer/Generation/Capture Schema、ownership 或对象存储类别。旧的坏 Revision 不改写；迁移只允许通过正常 CAS 新建恢复 Revision，回退代码时不得恢复写入 runtime URL 的行为。详见 CHG-20260903-LOCAL-REPAINT-DURABLE-MASK-PERSISTENCE。


## 2026-09-08 双入口统计补充

M13/M15，`IDENTITY-TELEMETRY` v1.1.0，日聚合 schema v3：来源由后端确定并加入唯一键；A100/正式站共表分行，OAuth 创建会话后幂等记录登录。旧事件原子标记来源，不补造历史登录；回滚先停同步。详见 [双入口统计变更卡](changes/CHG-20260908-DUAL-SOURCE-TELEMETRY.md)。


2026-09-08 `CHG-20260908-MODELVIEW-IDEMPOTENCY-LENGTH`：UI-05/M04（协作 M13/M15），`MODELVIEW-IDEMPOTENCY` v1.1.0。真实单视图任务 ID 拼普通后缀为 125 字符，补全后缀为 147，超过远端 128 限制导致第二张 422。保留全部旧合法键，仅对超长键使用完整原始 ID 的 SHA-256 + 原 workflow 后缀；同任务重试稳定，不截断尾部 UUID。三入口共用并加入 Server HTTP 回归，旧代码失败/修复通过。输入图片、mask、prompt、GPU/CPU/Worker/shader、投影/UV/export、分辨率、Schema、Command/Revision、ownership 与资产不变，无迁移；回退仅恢复旧键构造，会重新引入 422，不删除历史成果。详见对应变更卡。

2026-09-08 CHG-20260908-PERFORMANCE-LAB-PRODUCTION：M13/M15/UI-01，ALG-PERF-SESSION-001 v1.0.2。效率组正式站启用主动性能录制与三位管理员只读日志监测；服务端能力控制首页入口，白名单+飞书身份+维护角色控制跨用户读取，稳定游标分页超过 200 条记录。报告 Schema 2 不变，只处理新站新录制，不迁移 A100 历史；无生产算法、Project/Revision/ownership/资产语义变化。回滚关闭录制开关并恢复代码，保留全部记录。详见对应变更卡。

2026-09-08 性能日志详细归因补充：ALG-PERF-SESSION-001 v1.0.3 / collector 2.1.1。span 耗时在事件广播前确定；管理员详情关联最慢 12 帧与同期任务，相关性和建议不冒充根因，缺失数据不补造。Schema 2 与生产图像算法、工程持久化不变。详见 CHG-20260908-PERFORMANCE-LAB-PRODUCTION。

性能详细采集最终 collector 2.2.0：构建与支持能力、脚本位置、单调时钟、Observer drain、渲染器每秒快照、有效 GPU 查询、数值参数及模块覆盖明细；普通登录不启用录制，不改生产渲染输出。性能参数无法等同系统级采样，缺失与上限随报告明确说明。

2026-09-08 `CHG-20260908-REPAINT-TOOL-HANDOFF-PROFILE`：UI-06/UI-10 → M08，`ALG-LR-007` v2.2.1。真实 perf_224920a6 记录切换时 overlay 提前隐藏、正式材质约 4.75 秒后才发布。保留有内容的 preview owner 至真实 resident mask 绑定与呈现屏障完成，缓存复用/可见性入口同义，空预览和 eye-off 仍遵守原规则。GPU/CPU/Worker/shader 像素、UV/export、分辨率、Schema、Command/Revision/ownership/资产不变，无迁移；回滚只恢复这些判断。旧生产回调时序回归失败、新实现通过；M06 / ALG-PROJ-007 v2.1.4 同时令带深度/法线的 live+array 混合栈使用既有 compact 循环，保留简单 live 栈原 GLSL、采样预算与所有像素公式；7 组真实 WebGL 三状态像素对照一致，9 层 GLSL 约 82 KB 降至 31 KB。首次编译仍可能阻塞，不承诺用户原项目整体帧率已达标。详见对应变更卡。

2026-09-08 CHG-20260908-PROJECTED-OFFSCREEN-COMPILE：UI-06 / M06，协作 M08/M13；ALG-PROJ-007 v2.1.5。正式材质的 UV 离屏预热先异步编译精确 framebuffer 变体，绑定目标只跨同步 compileAsync 调用，立即恢复 target/cube face/mip；保留采样预热、GPU fence、取消与交互门禁。真实 14 层 WebGL 对照首绘 554.7ms → 1.0ms，180224 字节像素一致；原项目实测待新录制。Shader/CPU/Worker/UV/export/分辨率/Schema/Command/Revision/ownership/资产不变，无迁移；回退恢复原同步首绘。详见对应变更卡。

2026-09-09 CHG-20260909-CI-WATCH-CONFIG-MERGE：M15/M13/M08，一次性 SSR 回归改用忽略全部路径的监听配置，修复 Vite 合并时丢弃 watch:null 导致的 CI EMFILE；新增零监听断言，保留所有业务断言。算法、Schema、资产与部署语义不变，无迁移。

2026-09-09 CHG-20260909-METRICS-EMPTY-SUMMARY：M13/M15，统计空样本分支去重，保持所有统计结果与报告 Schema；正式配置包体减少 197 字节并通过原门禁。算法语义、像素、QA、持久化和导出不变，无迁移。

2026-09-09 CHG-20260909-PREVIEW-UPLOAD-CLEANUP：M06/M07/M13/M15，ALG-PROJ-007 v2.1.10。分条预览上传取消/异常清理涵盖分配、当前与在途位图及帧监测器；90 组故障注入覆盖资源归零、原图所有权和 GL 状态。安全压缩遍历 3→4，原门禁与诊断保留。像素、4K、QA、Schema、持久化和导出不变，无迁移。

2026-09-09 CHG-20260909-RESIDENT-MULTILAYER-SUBSETS：M06，ALG-PROJ-007 v2.1.11。至少两层的严格兼容有序子集复用原材质槽位，保留橡皮索引与不兼容回退；单层因真实像素差异明确排除。570 次状态回归、24 组 WebGL 输出零差异；无像素公式、4K、QA、持久化/导出或 Schema 迁移。见对应变更卡。

2026-09-11 CHG-20260911-PROJECTED-VISIBILITY-RESIDENCY：M06，ALG-PROJ-007 v2.1.12。模型内分别保留已有单层/多层材质，减少白模逐层恢复时重复上传、编译与发布；沿用严格兼容判断和独立单层公式，失配与卸载清理。新增 60 次恢复及所有权/失配回归。GPU 资源持有期变化，CPU/Worker/shader/UV/export 像素与 4K、QA、持久化、Schema 不变，无迁移；回滚方式见对应变更卡。

2026-09-11 CHG-20260911-VIEWPORT-WARMUP-PRESENTATION：M06/M03，ALG-PROJ-007 v2.1.13。投影预热同步提交后立即还原 framebuffer/cube/mip/autoClear，避免跨 GPU fence 等待时视口帧写入离屏目标。实际预热回调的三帧等待与取消/错误清理回归旧失败、新通过。GPU/CPU/Worker/shader/UV/export 计算与分辨率、QA、持久化、Schema 不变，无迁移；范围与回滚见对应变更卡。

2026-09-09 CHG-20260909-UV-READBACK-TASK-YIELD：M09/M07，ALG-UV-008 v2.0.2。离屏 8 MiB 读回条间改用既有任务让出，保留可见 renderer 呈现等待；6 次真实 4K 全 RGBA 零差异，隔离阶段均值 175.2→140.4ms，不代表总合成/FPS 收益。无像素、QA、Schema 或资产迁移。见对应变更卡。

2026-09-10 普通模式性能浮条隐藏（M13，UI 展示调整）：普通视口不再挂载 LightweightPerformanceHud，同时移除其独立 rAF 采样。调试开关及 perfLab=1 仍挂载原 PerformanceTestHud，perfLab=0 隐藏。独立性能录制、指标算法、生产渲染、Schema 与持久化不变，无迁移；回退恢复轻量浮条及普通模式挂载即可。
