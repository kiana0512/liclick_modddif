# CHG-20260910-UV-DEFAULT-RESIDENT

主模块 M07；协作 M06/M09。ALG-UV-003 v2.1.1（路由和失败策略），准备策略 v2.2.2（GPU 所有权），ALG-UV-005 v2.0.5（等价候选删减）。用户要求所有正常入口使用新实现，旧实现仅作代码备份；速度目标毫秒级且保持正确。此前 ac2afb2 已推送 master，release 分支/tag/部署配置不动。

## 已实现

最新用户明确要求先砍掉补洞：公共 Merge/export profile 的 uvCoverageGapPixels、uvInteriorHolePixels 均设为 0，完整停用拓扑覆盖扩展与内部孔洞填充，未覆盖区域保留原样。保留独立几何接缝 band 和 UV 外侧过滤 gutter。旧补洞函数留在代码供其他明确修补用途/诊断，不再在普通 Merge 调用。此前正在开发但尚未接入的 GPU 补洞草稿已移除，不等待其完成才关闭补洞。Merge 像素语义因此升为 v8，会话键 v12、持久派生键 uv-composition-8/resident-2.2.2/persistent-3 拒绝含补洞的旧准备结果，历史资产不改写。首次新语义需重新计算一次。

后台准备在多视图生成期间暂停，避免每返回两张图就立即跑一次昂贵的中间 UV。最终 PNG 使用私有 RGBA buffer 转移所有权，去掉一份64MiB复制；CRC32 从每字节8次位循环改为同一多项式查表，不改压缩级别/PNG像素。

- 普通入口不再依赖 perfResidentQuality=1；旧 localStorage CPU 选择和普通 URL 的禁用参数不再把用户送回旧核。单层 public API 转发同一 GPU stack；可见自动合成、Merge、补缝底图及纹理/FBX 导出共用此入口。旧单层 CPU 函数保留 LegacyReference；仅 perfLab=1 显式诊断可调用。CPU/GPU 对照也要求此诊断入口，避免把两份新结果误当旧/新对照。
- 普通质量合成启用 resident Top-3，首轮保留完整 CPU 校验；失败抛错并保留原输入，不使用 CPU 结果替代。GPU 异常不再自动 CPU raster fallback；literal 批次失败也不再自动旧逐层重跑。旧代码仍可在诊断中访问。单层也覆盖真实 WebGL 校验。8K 或超过 255 层的普通质量合成尚未适配新常驻核，明确失败而不是降分辨率/旧算法回退；纯 GPU coverage overlay 不受此质量核限制。
- 裂缝阶段只对有一组相对拓扑邻点的未覆盖像素做射线搜索：原射线遇第一个 topology=0 就停止，所以其他点绝不可能成为有效修补。复用已有 component 分块队列，按原行顺序保存候选，各 pass 仍批量写入，alpha、donor tie-break、regionIds 与 RGB 限制不改。
- 普通可见纹理上传启用已验证 4ms 提交预算和任务让出，保留掉帧反馈、交互避让、取消、末尾实际呈现门禁。
- 完整无损 PNG 预热时提前上传一张有界 GPU 纹理，持有独占 pin。点击正式保存同一不可变 Blob 成功后移动缓存键到返回资产 URL，沿用同一个 Texture 和 GPU allocation；不建立 alias、不重解码/上传。不同 Blob、目标键已存在、多人持有、上下文丢失或未上传完整均拒绝接管并走正常新上传。取消/失败等上传 finally 再释放，已转交纹理不会被旧 URL 清理。持久化 Command/CAS/ownership 与已验证资产保存未改。

## 审计和验证

GPU/GLSL：质量核公式不改，单层首次纳入校验；转交纹理保留同一对象/GL 数据，不改 gamma、翻转、滤波。CPU/Worker：首轮 QA、稀疏舍入修正、overlay 和拓扑后处理仍存在，**不宣称全 GPU**。旧 CPU fallback 正常路径禁用；公共补洞对 GPU 和诊断 CPU 消费者同样生效。导出沿用共用入口及完整源 alpha/蒙版约束。

114 项套件已接入新增正常路由/校验拒绝/上下文恢复、单层派发、准备纹理独占所有权、精确 Blob 身份、取消/失败/目标已存在保护回归（最终总套件状态见后续实测）。600 gutter、500 repair、40 seam 冻结核对照通过。类型与 lint 无错误；15 个既存 warnings。真实 WebGL 23 层/单层两种 alpha 模式通过原门禁。

隔离 4K 裂缝场景（6 UV 区域）：1303.1→413.1ms，78,000 repaired texels，完整 RGBA/coverage/count 零差异。4K 上传原路径 2169.8ms，新调度87.1ms；同 PNG 预上传后 GPU 接管0.2ms，确认为同一 Texture，与重新解码上传的完整64MiB图像逐字节零差异。都是阶段数据，**不是完整 Merge 或首次合成时间**。用户当前 shelter 项目旧链实测20,879ms；新完整链仍需浏览器验收。

最终无补洞版本：114 项 Web 回归、类型检查、lint（0 errors/15既存warnings）、Cloud 构建与包体检查通过。PNG CRC 变更在随机1²、17×39、257×255、1024² RGBA输入的完整 PNG 文件与原实现逐字节相同。Cloud JS 最终3,192,466 bytes，仍在本功能3,194,000预算内，保留每个 chunk 限制与全部质量检查。不修改 CI/部署配置。

内置浏览器 index-D7W8pyi8 构建确认：用户新 shelter 13层/4096 的一次准备4262.7ms，gpuRasterAndReadback3124.9ms、quality311.2ms、coverageRepair0ms、seam51.3ms、gutter317.7ms、最后清理138.3ms；完整PNG准备约1395.8ms。用户确认比之前快，但仍要求继续改。此记录未包含首次GPU完整校准/页面加载时间，也不是最终点击到显示时间，不能宣称毫秒级达标。

## 迁移和回滚

### 后续：精确源交付与选择预热（PERF-UV-SOURCE-PREPARE-001 v1.2.0）

最终发布约束/验收：Worker 源快路径仅用于 IHDR 验证尺寸、不需要缩小的静态 PNG；JPEG 和所有需缩放源使用原 HTMLImage 高质量采样。非整数 PNG 缩放候选也出现覆盖差异，已排除，与下述中间实验区分。最终四组真实 WebGL（4K原尺寸、512多层蒙版、JPEG和PNG非方形缩放）全部零差异；4K新2197.1/2240.0ms、旧3549.6/4545.2ms，新0 longtask、最大帧间隔33.4/33.5ms。115项回归通过，类型/构建通过，lint 0 errors/15既有warnings，最终包体3,197,326 bytes在3,198,000门禁内。内置浏览器应核对index-Dc0fgHIJ构建。后文保留定位过程及阶段数据，不把阶段结果冒充整体Merge达标。

原项目内置浏览器已确认 index-Dc0fgHIJ，瓶子002原有合并UV显示正常。仅打开隐藏投影“前”的菜单验证预热（没有重新合并/删除用户图层）：准备4,044.7ms，PNG+GPU810.6ms，源等待79.7ms、上传20.5ms、GPU采样/读回757.7ms；GPU质量byte mismatch=0，最终preparation/GPU均ready。仍有quality253.8ms、seam641.9ms、topology550.9ms、gutter649.5ms、finalize200.8ms及持久准备成本；此完整冷路径未达毫秒级，不能用上述隔离阶段或已热命中冒充达标。

主模块 M07，协作 M06/M09。GPU 源复用同一软件 Canvas drawImage、缩放与 alpha 转换后直接输出 ImageBitmap，删除整图 getImageData、CPU RGBA 缓存插入、第二张 Canvas putImageData 及两次固定等帧。CPU 参考采样入口和 live 同步快照不变。没有降低输出分辨率。

预热静稳等待 1500→250ms，仍避让可见视口交互/生图/手工烘焙。图层面板只发布选区意图，引擎按真实多选和右键单选准备投影及有序 UV 底层，包含显式选中的隐藏层。前台加入相同 pending PNG/GPU 任务，ready 只在完整 GPU 预览准备后发布。无变化的底层仅在逐字节比较完整 RGBA（含 alpha=0 下的 gutter RGB）相同后复用 projection-only PNG。会话 final key 升为 v2，包含底层完整属性与 live revision；过期结果拒绝发布。当前只预热选定对象/选择，不宣称所有对象或未完成的新输入均已驻留。

CPU 私有 atlas 复制按 1MiB 切片、4ms 提交预算让出，切片间等待视口空闲；PNG 仍交 Worker，像素计算仍用既有 GPU 核。GPU shader/Top-3/深度/蒙版/背面/采样/QA 不改；首轮 CPU QA、稀疏修正、拓扑后处理仍存在，不能宣称全部 GPU。Merge 与共用源加载的自动烘焙/export 获益，持久化仍经原 Command/CAS、ownership 和 verified asset。最终 Blob 对象身份与 GPU 所有权接管契约保留。

公开算法核查（2026-09-10）：[Modddif 官方纹理文档](https://docs.modddif.com/project/texture/) 说明默认 2K、Pro 可 4K、质量 blend 与独立 Fill missing area，但没有公开 Merge 内核/计时，不能推断其必用低分辨率预览。[NVIDIA nvdiffrast](https://nvlabs.github.io/nvdiffrast/) 将 GPU 光栅化、属性插值、纹理采样分离；[Stable Fast 3D TextureBaker](https://github.com/Stability-AI/stable-fast-3d/blob/main/texture_baker/texture_baker/baker.py) 独立提供 rasterize/interpolate，可复用几何映射。这为后续 UV 几何缓存提供依据，但单表每 texel 单表面不等价于我们的重叠 UV、逐层 discard/tie-break，因此没有未经验证替换生产核、没有引入 CUDA/Windows 组件或第三方源代码。

真实 WebGL，冻结 b688408，旧/新/新/旧及每轮新 Blob URL：完整 4K 源、4K 输出、6 层全部 256 种 alpha，完整 RGBA/coverage/count 零差异；512/13 层含蒙版、缩放和保留逐层 quality 数据也零差异。首轮 4K 源阶段旧4657.2/4794.7ms，新3345.7/3492.8ms；追加帧探针运行旧3407.4/4556.6ms，新3557.5/3515.0ms，收益有波动，均非整个 Merge。新4K冷源场景仍记录 241–243ms 长任务和约234ms最大帧间隔，零卡顿尚未达标；512已热核场景最大帧间隔约16.8ms且0 longtask，不可外推整个工程。

拒绝的候选：硬件 Canvas 改变缩放/alpha 像素（对照213/217），已恢复 willReadFrequently:true；按 clip 切条绘制保留像素但没有消除4K长任务且无稳定总耗时收益，也未采用。测试夹具新增 rAF/longtask 及同步 Canvas/GL 调用归因，后续优化以观测定位为准。

帧归因后的最终迭代：静态 PNG 通过既有授权 urlToBlob 取得不可变 Blob，Worker 内完成 createImageBitmap、相同软件 Canvas 缩放/alpha、transferToImageBitmap。主线程从 Canvas 创建位图约210ms、从 HTMLImage 创建位图约165ms 的同步开销均移除；仅把 Canvas 换成 OffscreenCanvas 仍在主线程转交不能消除长任务，未采用。JPEG Worker 解码候选在非方形缩放/蒙版覆盖对照出现差异，明确排除；JPEG/其他格式保留已有 HTMLImage 兼容入口，live 源保持同步快照。新 Worker 错误传播，不调用旧 CPU 烘焙；测试覆盖失败、孤立回复、重建和位图释放。

常驻核的最终 Y 翻转/完整 RGBA 搬运/alpha 覆盖统计改交现有 readback Worker 的 resident 模式，保留 alpha=0 下 RGB，不再次解除预乘、不改透明阈值；首轮 QA 仍保留。舍入边界扫描分成 1MiB 片段让出，其标记与 CPU 精确修正公式不变。Worker 协议只会话新增 resident 模式，随同一构建整体发布，无持久 Schema 迁移。冻结原循环对随机1/17/255/1024尺寸完整 RGBA、覆盖和计数一致。

最终核对照4K六层：旧2979.7/4528.1ms，新2133.1/2130.8ms；新主线程 longtask 0/0，最大帧间隔33.4/50.1ms，旧长任务7/8、最大199/243ms。仍是隔离源+GPU阶段，不含原项目所有视口/网络/后处理，不能宣称任意时刻零延迟。参考旧模块共享舍入扫描的调度实现，像素参考保持原公式。

回归增加 pending 去重/等 GPU ready、live 修订失效、单选/多选/跨对象、完整 alpha/gutter/非对齐比较、取消与有界复制让出。含 Worker 构建约3,197,064 bytes（上版3,193,980）；本功能总预算增加4,000 bytes至3,198,000，每个 chunk 和 QA 门禁不变。持久 RGBA 格式及 profile v8不变，不清空已验证磁盘预热、不迁移历史资产。回滚本轮源/预热/readback Worker 代码、恢复 session final key 即可；保留已发布无补洞语义和严格 GPU 路由。

### 后续：源准备与 GPU 执行重叠（PERF-UV-SOURCE-PREPARE-001 v1.1.0）

M07 / 协作 M06、M09。两个 GPU 栈入口共用一层 lookahead：当前层上传/光栅化期间只准备下一层，不同时加载整个栈；失败和取消排空在途资源。live canvas/image URL 不提前采样，仍在消费时同步快照。借用 resident bitmap 期间持有缓存引用，异常解码回收已完成的兄弟纹理；未使用的 neutral 及时释放。

删除每个纹理（包括 1px neutral）上传前必等一帧的固定成本，改用 4ms 提交预算，纹理内部的分条上传/交互让出保留。新增源等待、上传、逐层读回分段计时，便于继续定位，不能把总时长都归因于 GPU 运算。

GPU/CPU/Worker/shader：本轮只调整准备/提交调度和资源所有权，不改采样、Top-3、蒙版/深度/alpha、RGBA 转换或 QA。Merge、自动合成和 export 经同一入口获益；持久数据/缓存字节不变，无 Schema/资产迁移，不因等价调度再次失效持久预热。回滚仅恢复本轮调度代码，历史版本 8 / 缓存 v12 保持。release 和 CI 配置不改。

冻结 d3800a9 原 GPU 模块，真实 WebGL 同源 PNG、新 URL 防止解码缓存偏置、旧/新/新/旧顺序：4K/6层阶段旧 1222.6、1609.0ms，新 851.0、1043.7ms；完整 RGBA、coverage、覆盖计数/三角计数一致。512/13层旧 3113.5（含首次编译）、1539.0ms，新 704.8、719.6ms。均为隔离平面夹具的源准备+GPU合成阶段，不含持久保存/接缝/gutter，也不证明用户整个 Merge 已达毫秒级。

新增 23 层调度/有界资源/同步 live 快照/错误/取消回归；真实 WebGL 脚本 `verify-uv-source-lookahead-webgl.mjs` 固定旧模块对照。后续实际工程验收另记。

本轮 115 项回归通过，类型检查通过，lint 0 errors/15 既有 warnings，Cloud 包体 3,193,980 bytes 通过原 3,194,000 门禁。内置浏览器当前 shelter 工程刷新后确认 `uvMergePreparationRead=disk-hit`；13层/4096 实际点击 Merge，`mergeDurationMs=48.8`（处理开始至合并图层发布），`previewPrewarmDurationMs=0.5`、`uvMergeGpuPreparation=adopted`、final cache hit，截图确认合并 UV 已显示。随后撤销一次恢复原始 13 个投影层供用户测试。此结果依赖已完成的持久结果恢复/PNG与GPU预热，不代表冷启动或任意编辑后都能 48.8ms。

最终核再次验证：4K/6层旧 1220.4、1628.7ms，新 866.5、1174.2ms，字节零差异，存在运行时波动；新增512/13层带蒙版与首轮保留 rasters 路径，逐层 RGBA/coverage/quality 与最终结果全部零差异，旧2486.0、2430.2ms，新1611.2、1608.5ms。CPU参考和首轮校验依然保留。

不修改 Project/Layer Schema、历史资产或派生缓存格式；关闭补洞改变新输出语义，缓存版本按上文更新，旧含补洞结果不复用。GPU 纹理只会话预热，页面刷新从当前版本持久 RGBA 恢复后重建 GPU，不能把显存本身写到磁盘。回滚本卡路由、候选删减和GPU转交，并恢复旧 profile/版本；旧算法保留于源码。正常用户不用 debug 参数。release 保持不动。
