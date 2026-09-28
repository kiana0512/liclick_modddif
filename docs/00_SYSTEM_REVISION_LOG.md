# LI3D Cloud 准则修订流水与历史变更记录

## 2026-09-28 内容填补完整覆盖

M09（协作 M07/M08）：`ALG-CA-003` v1.4.0 让前两轮局部及一条物理缝仍无法到达的严格 UV core 残余使用已有可靠纹理均色作不透明最终兜底；无可靠纹理则拒绝发布，自动多视图补缝失败不再伪装完成。原分辨率、投影 QA、Layer/Project Schema、Command/CAS/ownership/verified assets 与导出合成契约不变；旧资产不自动重写。验证与回退见 [完整覆盖变更卡](changes/CHG-20260928-CONTENT-REPAIR-COMPLETE-COVERAGE.md)。

## 2026-09-28 轻量计时收敛

2.25.0：M13/M15，FUNCTION-TIMING/1.0.0，默认关闭。按用户要求用 --DEBUG 构建门与 start/stop 取代旧重型 Trace 方案，只保留阶段/函数 wall、本地表格与 JSON；原 Performance Lab 独立保持。移除本次服务端诊断及未发布迁移，无业务算法或数据迁移。见 CHG-20260928-FUNCTION-TIMING。

> 本文件是 [00_SYSTEM_MODULES_AND_CHANGE_STANDARD.md](00_SYSTEM_MODULES_AND_CHANGE_STANDARD.md) 在 2026-09-22 结构重整时移出的历史部分，内容逐行保留，未做删改。
>
> **读取时机**：仅在追溯某个决策的来由、排查旧工程兼容问题或回归问题时读取。日常修改不需要打开本文件。
>
> **效力**：本文件只记录"当时发生了什么"，不表达"现在必须成立什么"。当前规则一律以唯一准则正文为准；两者冲突时以基线源码与唯一准则为准，不反向改写本文件的历史事实。
>
> 单张变更卡的完整格式记录在 `changes/CHG-*.md`。

## 2026-09-23 master 合入时保留的修订记录

2026-09-24 M02：新导入参考图统一执行 4,000,000 字节上限，压缩后再保存与去高光；旧参考图不重写。类型检查与边界/失败回归通过，见 CHG-20260924-REFERENCE-IMPORT-BUDGET。

2026-09-23 M08/M06：按用户后续要求，ALG-LR-006 v2.2.0 将局部重绘朝向门槛从 0.01 调整为 0.03；共享落笔保护与新建/重新发布图层参数，保持原深度、遮挡、羽化宽度及旧资产不批量迁移。回退为 0.01，详见 changes/CHG-20260923-REPAINT-FACING-THRESHOLD.md。

2026-09-23 M08/M06：按用户指定将 ALG-LR-006 v2.1.0 局部重绘最小绝对 face-on 从 0.08 调至 0.01，共享用于落笔保护与新建/重新发布图层的 minimumProjectionFacing。既有层显式参数和烘焙图不批量迁移，深度/遮挡与羽化宽度不变。Web typecheck、projection-layers、layer-retention、ordered-composition、seam-harmonization 均通过。详见 changes/CHG-20260923-REPAINT-FACING-THRESHOLD.md。

2026-09-23 M08/M06：`GPT-RETURN-BACKGROUND-CLEANUP` v2 在共享回图还原路径增加半透明外部背景清理。仅在原 alpha>=128 边界失败、alpha>=200 主体边界与原构图相符时，清理观测主体包围框安全边距之外、连通画布边缘且 alpha<192 的像素；提交前重新验证全部剩余 alpha>=128 边界，保留 RGB、主体及邻近抗锯齿。GPT 单视图/多视图/局部重绘共用；原不透明孤立边缘清理保留。无持久化/Schema 迁移，既有失败不自动重发，回滚恢复 v1。详见 docs/changes/CHG-20260923-RETURN-ALPHA-RESIDUE.md。

2026-09-23 M08/M04：`LOCAL-REPAINT-SAMPLING-MASK` v3 恢复原局部重绘远端采样蒙版自适应外扩和羽化（原半径公式），继续按冻结可见轮廓裁切。白色输入标记、原选区及未贴图区域并集、实际回贴写入范围保持不变。GPT 和单/多视图补全行为不变。GPU/CPU/Worker 回贴、保存与导出继续消费未外扩选区；无需资产或 Schema 迁移，历史请求不重写。回滚仅将 local 的 dilationRadius/featherRadius 置零。验证生产 Worker 输出存在外扩/灰度过渡、背景与孔洞仍为零及回贴合成回归。

2026-09-23 M15（关联 M02/M10）：`BLENDER-SERVER-RUNTIME/1.0.0` 将固定 SHA-256 的官方 Blender 5.1.2 Linux x64 及运行库纳入最终 server 镜像，显式配置路径，并以正式非 root 账号执行真实 UV 修复/GLB 回读及破坏性输入拒绝验收，失败阻止镜像发布。`IMPORT-UV-REPAIR/1.3.0`、`IMPORT-DECIMATE/1.1.0` 算法及 GPU/CPU/Worker/shader、保存/export、Schema/Command/CAS/ownership 不变，无资产迁移；验证、限制和回滚见 [Blender 镜像运行时变更卡](changes/CHG-20260923-BLENDER-SERVER-RUNTIME.md)。本地修改，尚未部署。

2026-09-23 M04：`MATERIAL-REFERENCE-UPLOAD/1.0.0` 对明确材质参考自动选择原尺寸无损、经逐像素验证的近无损及最后的最高可容纳质量上传副本，完整请求严格小于莉刻 4,000,000 字节。原图与去光照保留，法线/蒙版/结构输入仍精确；`REFERENCE-LIGHTING/2.0.1` 仅迁移无远端 taskId 的已知旧上传前失败，不重复已接受任务。GPU/CPU/Worker/shader 投影、UV、保存导出、Schema/Command/CAS/ownership 不变，无资产迁移；验证与回滚见 [材质参考上传变更卡](changes/CHG-20260923-MATERIAL-REFERENCE-UPLOAD.md)。本地修复，未部署此补丁。
## 2026-09-23 新增文档修订

2.24.0：M13/M15，默认关闭 Pipeline Trace 扩展到 Browser/Worker/Node/Blender、诊断存储/续接、CPU/GPU 采样和 Perfetto。真实 Bicycle 12 attempts、8/9 QA 结果与 30 分钟合成稳定性分别记录；未归档、未部署、未宣称外部硬件/完整性能预算验收。见 [实施卡](changes/CHG-20260923-PIPELINE-TRACE-IMPLEMENTATION.md)。

## 2026-09-22 新增文档修订

`2.23.0`：M13/M15，用户批准 OpenSpec apply；登记默认关闭的 Pipeline Trace 基础预览及明确缺项，无业务算法变更。见 [基础接入卡](changes/CHG-20260922-PIPELINE-TRACE-FOUNDATION.md)。

`2.22.2`：M13/M15，`CHG-20260922-TRACE-PROPOSAL-REVIEW`。仅修订待实施 OpenSpec 的采样边界、生命周期、分级、开关隔离和代码落点，新增阅读入口；当前准则 collector 版本由陈旧的 2.1.0 校正为代码现值 2.2.1。无算法变更、无运行时变更；旧人工录制契约继续有效。详见 [评审修订卡](changes/CHG-20260922-TRACE-PROPOSAL-REVIEW.md)。下方迁入历史内容不改写。

## 2026-09-22 已被取代的条款

### 第 14 节 变更分级与修改上限（2026-09-22 前的审批触发）

原文逐字保留：

> 默认一次修复只跨一个大模块，不超过 5 个源码文件或 300 行净变化。跨两个以上大模块、修改投影/UV/局部重绘阈值、Project/Layer/Capture/Generation 契约、默认分辨率、目录移动或兼容删除，必须先提交证据化方案并获得批准。

取代原因与新条款见 `changes/CHG-20260922-DOC-PROGRESSIVE-DISCLOSURE.md`。新条款把审批触发改为风险维度判定，规模降级为自查提示。


2026-09-21 M08：`ERASER-FEATHER` v2 将橡皮擦同步为实心中心与线性外圈，实心半径为 1-min(0.9,feather)，最大羽化仍保留 10% 中心。擦除保持完整光标半径，不套用彩色局部重绘的 3px 内缩或最小 16px 过渡。UvRepaint 原生彩色图层及普通 UV/投影蒙版 GPU 擦除共用线性公式；Canvas 笔刷缓存区分线性橡皮与原选区曲线，预热/实时/历史提交沿用同一擦除像素。画蒙版、普通画笔、颜色重绘、远端输入、CPU/Worker 合成和导出公式不变，不重写已有资产，无迁移。回滚恢复橡皮 smoothstep 与 Canvas 旧渐变。浏览器测试覆盖 2K/4K、最大羽化中心、线性外圈、撤销及保存。
2026-09-21 UI-05/UI-06 → M03/M08：`ALG-CAP-006` v1.0.1 将共享 renderer/背景快照限制在每次同步 GPU 提交段，逐 tile/pass 重新取得当前状态，恢复幂等，避免异步完成覆盖 resize。`INPAINT-PROJECTION-TEXTURE-SIZE` v1.0.0 在蒙版 canvas 改变尺寸或历史恢复时释放旧 WebGL2 不可变纹理分配，沿用原上传重新分配，修复落点偏移/上传失败。像素公式、相机、完整分辨率、QA、CPU/Worker/shader、UV/export 与 Schema/资产不变，无迁移。真实 Edge 旧实现约 82px/51px 偏移，修复后三路径小于 1px；回归及回滚见 [截图与蒙版对齐](changes/CHG-20260921-CAPTURE-RESIZE-MASK-ALIGNMENT.md)。

2026-09-21 UI-05 / M04（M03）：`MULTIVIEW-PRESETS` v1.2.1 按用户确认将默认预设 1 八向俯角由 15° 改为 30°，方向 y=水平长度×tan(30°) 后归一化。方位角、底方向 (0,-1,0)、九视角顺序、GPT 2+4+3 分批、ModelView 串行和预设 2/自定义不变；既有结果/相机数据不重写、无迁移，刷新加载新预设。回滚恢复默认俯角及描述为 15°。回归覆盖 30° 单位方向、方位不变、正底和分组。

2026-09-21 UI-05 / M04：按用户要求移除 UI 预设 3（旧水平十视角）定义和入口；仅保留预设 1（内部 preset-3、默认九视角）、预设 2 和自定义，入口恢复三列。`MULTIVIEW-PRESETS` v1.2.0，调度保留历史配对兼容和自定义继承；既有图层、生成结果及相机数据不删除，无资产迁移。回滚恢复旧定义和入口即可。

2026-09-21 三批生成发布检查：删除自定义预设定义未被读取的 label，保留按钮 title 与实际视角计数，确保发布元数据预留空间；不修改功能或包体预算。

2026-09-21 M04：`GPT-MULTIVIEW-PAIR-SEQUENCE` v1.5.1 将当前 UI 预设 1（内部 preset-3，九视角）的底视角合入最后的左后/右前批，批次变为 2+4+3；继承该环绕方案的自定义预设沿用合批规则，新增自定义单视角仍独立。现有十视角及十四视角完整预设批次不变，ModelView 串行不变。相机方向、提交顺序、QA/重试/取消、贴图算法、资产/Schema 不变，无迁移；回滚删除底单视角合批分支。回归检查九视角三批、相机对象保留和自定义隔离。

2026-09-21 M08：`ALG-LR-014` v2 自动消费工作蒙版与颜色羽化强度解耦。投影/原生 UV 两条路径保留原有效覆盖阈值 0.01、正反面和 source/depth 门控，通过后以 1.0 清除该侧选区，覆盖外不变。UV 覆盖提取同时识别 alpha 不增但 RGB 改变的重绘像素；完全无变化笔画仍为 no-op。颜色笔迹 GPU/CPU/Worker、PNG/export、羽化和内缩公式、冻结生成蒙版不变；工作蒙版仍通过既有稀疏 patch 撤销/重做和持久化，无资产迁移。回滚恢复消费 alpha 与 alpha-only 差异判断。

2026-09-21 UI-05 / M04：`MULTIVIEW-PRESETS` v1.1.1 将俯视 15° 八向加底的 9 视角方案显示为预设 1，排在首位并作为初始化默认；旧水平 10 视角方案显示为预设 3，预设 2 不变。保留内部 preset-3 / preset-1 稳定身份和缩略图 ID，以免改变既有调度及缓存语义。GPT 配对、ModelView 顺序、像素处理、存储结构和已有资产不变，无迁移；回滚只恢复按钮名称、顺序和初始化选择。回归覆盖名称顺序、默认选择、9 视角方向与串行流程。

2026-09-21 UI-07 → M03：`ALG-VIEW-PROJECTION-001` v1.0.0 保持透视/正交切换的轨道中心、方向、up 及中心平面屏幕比例。以透视有效 FOV/距离和正交 frustum/zoom 换算，不再因相机 UUID 变化自动 fit；恢复请求匹配类型后只消费一次。冻结 Capture/projector、GPU/CPU/Worker/shader 纹理投影、UV/export、分辨率、QA、Schema/Command/CAS/ownership/资产不变，无迁移。真实 Edge 旧控制器首次切换复现 target jumped，新版通过连续切换/缩放/resize/恢复测试；本地修改，未推送部署。详见 [投影切换取景连续性](changes/CHG-20260921-CAMERA-PROJECTION-SWITCH.md)。

2026-09-21 预设 3 发布检查：移除预设按钮配置从未读取的 `detail` 重复文案，显示计数仍从视角定义计算，交互及算法不变；不调整包体预算。用户已确认实际模型九宫格预览并要求发布。

2026-09-21 UI-05 / M04（协作 M03）：`MULTIVIEW-PRESETS` v1.1.0 新增预设 3（9 视角），前→左前→左→左后→后→右后→右→右前→底。用户补充八向应略俯视；截图无精确角度，明确按 15° 实现：保留方位角，方向 y=水平长度×tan(15°) 后归一化；底保持 (0,-1,0)，不含顶。抬高预设使用独立 ID，避免复用水平缩略图。四个预设入口采用两列，计数读取定义。`GPT-MULTIVIEW-PAIR-SEQUENCE` v1.5.0 复用预设 1 环绕配对并保留实际相机，底单独收尾；ModelView 保持显示顺序逐张准备、请求和回贴。默认预设 1、预设 2、自定义基础方向、QA、GPU/CPU/Worker/shader 投影公式、UV/export、分辨率、Schema/Command/CAS/ownership/资产不变，无迁移。回滚删除预设 3、可选俯角参数和调度别名，已有结果保留。八向归一化/方位角/15°/正底、GPT 配对和自定义继承、ModelView 顺序、Web typecheck/lint 回归通过；未付费生成或部署。

2026-09-21 UI-06/UI-10 → M08：`REPAINT-BRUSH-CONTEXT-MENU` v1.0.0 将局部重绘画笔的鼠标右键从擦除改为打开已有大小/羽化面板；在射线拾取、历史和擦除派发前返回。右键打开后，面板外左键只关闭并消费 pointerdown/click，面板内调参保留；下一笔正常绘制。独立橡皮、笔尾擦除、其他工具右键和 Alt/MMB 导航不变。算法像素、GPU/CPU/Worker/shader、UV/export、Schema/Command/CAS/ownership/资产不变，无迁移。验证与回退见 [右键画笔面板](changes/CHG-20260921-REPAINT-BRUSH-CONTEXT-MENU.md)。本地修改，未推送或部署。

2026-09-21 M08（审计 M06/M07/M11）：`ALG-LR-UV-PAINT` v3.0.0 将原生 UV 局部重绘彩色笔迹改为实心中心加线性外圈羽化；保留羽化比例与 3px@2K 退让，过渡宽度上限为有效半径的 90%，保证至少 10% 实心半径。橡皮/选区仍走原 smoothstep，未修改旧资产或生成蒙版。GPU 输出 RGBA 直接用于显示、历史、PNG、CPU/Worker 合成及导出，无二次羽化或 Schema 迁移。批准、公式、验证与回退见 [线性外圈羽化](changes/CHG-20260921-REPAINT-LINEAR-FEATHER.md)。本地修改，未推送或部署。

2026-09-21 M08（审计 M06/M07/M11）：`ALG-LR-UV-PAINT` v2.0.0 补齐原生 UV 手动彩色笔迹内缩：按实际屏幕笔段解析距离，2K 视口参考退让 3px、向内至少 16px 过渡并保留较大用户羽化，小笔刷限制宽度；既有 max-alpha 累计，不做全局 UV 岛腐蚀，不以生成蒙版限制手动绘制。橡皮/mask-only 不变，GPU 实时与历史/PNG/合并/export 共用已处理 RGBA，不新增 GPU pass、RT 或逐笔全图读回。无 Schema/资产迁移，旧笔迹不重写；ADR、批准、矩阵与回退见 [实际笔迹内缩](changes/CHG-20260921-UV-REPAINT-STROKE-INWARD.md)。本地验证，未推送或部署，真实座垫黑边仍需发布后复核。
2026-09-21 M08 / M15：个人 AutoDL 接口切换用户指定 li3d-8-2，版本 `autodl-li3d-8-2-768-2step-20260921-v1`；精确恢复提示词节点 Ready 序列化异常，修正后实际参数与 li3d-8 相同。复测热运行 2.333s、新文件名四图 2.783s，接口返图 2048×2048。网页仍通过 LI3D 后端，此次不修改其上游；无图像算法或 Schema 迁移。细分计时、边界及回滚见 [li3d-8-2 记录](changes/CHG-20260921-LI3D82-SWITCH.md)。

2026-09-21 M08：按用户要求先将个人直连当前版本本地提交为 159cb1f（未推送），再关闭 personalRepaintEnabled，所有入口恢复 LI3D 后端 /api/modelview/inpaint；旧 URL 参数不再启用直连。仅调用路径恢复，输入/GPU/CPU/Worker/shader/回贴/persistence/export 语义不变，无 Schema 迁移。详见 [个人直连记录中的切回说明](changes/CHG-20260921-AUTODL-DIRECT-REPAINT.md)。

2026-09-21 M08 / M15：按用户指定将个人 AutoDL 接口切换为 li3d-8（768 推理、2 步、单 LoRA 0.8，输出保留原尺寸），更新四图节点映射与远端版本；修复源文件提示词缓存节点旧字段错位。原组图片实测重复输入 2.341s、新文件名输入 2.728s；接口实际执行 2.711s，2K PNG 校验通过。无前端图像算法/Schema 变更，旧生成保留；参数差异、原始数据与成组回滚见 [li3d-8 切换记录](changes/CHG-20260921-LI3D8-SWITCH.md)。

2026-09-21 M08 / M15：AUTODL-DIRECT-REPAINT-STATUS/1.0.0 将个人服务等待与 ComfyUI 排队显示为“排队中”，以本任务进入 queue_running 为执行依据，按钮/预览同步上传、排队、执行和返图状态。工作流、图像算法、QA、Command/CAS/export 不变，无历史迁移；验证与回滚见 [个人直连变更卡](changes/CHG-20260921-AUTODL-DIRECT-REPAINT.md)。

2026-09-21 M08：个人 AutoDL 节点级诊断，使用同组四图对比未命中节点缓存、重复输入、新文件名输入及追加采样进度；未修改运行算法或服务。执行实测 13.324 / 7.190 / 8.101 秒，追加缓存状态变化样本 15.077 秒亦保留，不以单步进度代替总耗时。原始数据、事件区间口径及限制见 [节点耗时报告](changes/CHG-20260921-AUTODL-NODE-TIMING.md)。无 Schema 或迁移变更。

2026-09-21 M08 / M15：个人直连上传优化 AUTODL-DIRECT-REPAINT-UPLOAD/1.0.0，gzip 原请求字节与多视图参考内容缓存；仅缓存明确失效且尚未入队时补传，保持原幂等性、鉴权、解压体积上限及完整图片。无图像算法/Schema 迁移。固定输入交错 3 轮对照，命中缓存请求体减少 52.4%，含压缩准备的上传往返中位 1712.2→838.4ms；测试边界、原始数据与回滚见 [个人直连变更卡](changes/CHG-20260921-AUTODL-DIRECT-REPAINT.md)。

2026-09-21 M08 / M15：个人直连新增可选诊断 AUTODL-DIRECT-REPAINT-TIMING/1.0.0，独立记录请求准备、POST 往返、云端排队/执行/完成发现、PNG 下载、结果处理；计时落盘到原任务与 Generation metadata，旧记录兼容，无图像算法或 Schema 迁移。真实 2K 样本及嵌套计时边界见 [个人直连变更卡](changes/CHG-20260921-AUTODL-DIRECT-REPAINT.md)。

2026-09-21 M08（协作 M04/M13/M15）：新增用户明确授权的个人 AutoDL 直连试用，`AUTODL-DIRECT-REPAINT/1.0.0`。仅个人构建与 `personalRepaint=1` 同时启用时，四图生图直达指定 AutoDL HTTPS 受限接口，采用用户确认的云端 True-V3 Q5_K/2 步工作流；不经 LI3D 生图代理，不调用网站润色或自动参考生成。默认正式构建编译移除此入口；工程保存仍走 Cloud verified assets / Command / CAS / ownership。AutoDL 管理 Token 与 SSH 凭据不进入浏览器，个人访问码不写工程或 Git。GPU/CPU/Worker/shader、原选区/回贴/UV/export 保持，无历史迁移。实现、验证边界及回滚见 [个人直连变更卡](changes/CHG-20260921-AUTODL-DIRECT-REPAINT.md)。用户批准后已启动云端接口；真实 HTTPS 鉴权、浏览器四图生成、2K 返图、模型回贴及撤销像素一致性验收通过。仅本机个人入口已提供，正式站未部署，实例重启自启动和多用户运行不在本次验收范围。

2026-09-21 UI-04 / M02：高面数导入减面确认框仅说明细节丢失、轮廓变化和贴图拉伸/错位风险，并提示用户可取消、自行手动减至 150 万三角面以内确认效果后重传；不再描述实现步骤。纯文案 Patch，IMPORT-DECIMATE 算法、阈值、独立 UV 确认、取消/失败和原文件保护行为均不变，无 Schema 或资产迁移；回滚仅恢复文案。浏览器回归同步新提示断言。

2026-09-20 M08（审计 M06/M07/M11）：`ALG-LR-008` manual scope v3.1.0 纠正手动局部重绘以生成蒙版限制绘制范围的问题。用户确认融合内缩针对实际笔迹而非生成选区；手动源权限使用中性白色，不再按原选区裁切或径向衰减，空选区仍拒绝。原生 UV 继续按实际笔刷边缘向内羽化，兼容 Canvas 路径继续从累计笔迹生成 inward blend。源 alpha、深度、遮挡、透明边界预乘采样、自动生成范围、3px 模型轮廓保护及图层选择规则不变。CPU/Worker 共用手动核、缓存版本更新，无持久化 Schema/资产迁移，旧像素不重写。详见 [手动绘制范围与融合边界](changes/CHG-20260920-REPAINT-MANUAL-OUTSIDE-SELECTION.md)。本地验证，未推送或部署。

2026-09-21 M04（协作 M03/M05/M06/M09）：`ALG-GEN-006` v1.2.0 将 ModelView 多视图改为按需捕获：每个视角先冻结当前贴图和相机，再准备该视角完整白模/法线/mask/depth，持久化后立即提交；上一张回贴驻留后才准备下一张。保留预览顺序、完整覆盖跳过、取消和一次末尾补缝；按整批视角更新进度。GPU/CPU/Worker/shader、分辨率、QA、UV/export 和 Schema/Command/CAS/ownership 不变，无迁移。详见 [逐视角快照](changes/CHG-20260921-MODELVIEW-ON-DEMAND-CAPTURE.md)。本地修改，未推送或部署。

2026-09-20 M06（协作 M07/M08）：`UV-REPAINT-PREVIEW-BINDING` v1.0.1 统一手动 UV 重绘层在 React、显隐订阅及异步材质发布中的顶层/下层划分；运行时纹理不再进入静态图片预热，含 live 输入的组合不复用静态显示缓存。普通 PNG 图层显隐也刷新组合所有者，全可见预热只在请求键匹配且结果 ready 后登记缓存，防止旧贴图写入新组合。GPU/CPU/Worker/shader 合成公式、源像素、分辨率、QA、保存/合并/导出协议均不变；无需迁移，回滚仅恢复显示绑定。详见 [多层 UV 重绘显隐修复](changes/CHG-20260920-MANUAL-UV-PREVIEW-VISIBILITY.md)。

2026-09-20 M08（审计 M06/M07/M09/M11）：`ALG-LR-008` bounded falloff v3.0.0 / `ALG-LR-UV-PAINT` v1.3.0 修复局部重绘范围外暗带。CPU/Worker 共用作者选区内向羽化，区域外/孔洞为零；原生 UV 取色以原生源 alpha/蒙版约束支持范围，透明边界按预乘颜色插值，不扩大3px内缩，不改相机、深度、分辨率和 QA。GPU/CPU/Worker/历史/PNG/合并/export 审计与回滚见 [范围外暗带修复](changes/CHG-20260920-REPAINT-BOUNDED-PROJECTION.md)。旧像素不自动改写，无 Schema/资产迁移。本地验证完成；发布以对应提交的 master 流水线和 A100 发布记录为准。

2026-09-20 M04（协作 M03/M08/M12）：`GPT-REPAINT-GEOMETRY-FRAMING/1.0.0` / `GPT-CONTENT-BOUNDS/1.1.0` 修复 GPT 局部重绘把不透明蓝/黑法线背景误当主体的问题。提交前复用同冻结相机的 linear-view packed depth 提取模型边界，保存到既有 framing；保留长边 1:1 配对裁切、原生返图和严格轮廓阈值。作者选区、GPU/Worker/shader/UV/export、Schema/Command/CAS/ownership 不变；旧失败任务需重新生成，无资产迁移。真实 WebGL 蓝/黑背景与透明返图坐标/像素回归通过。详见 [局部重绘轮廓来源修复](changes/CHG-20260920-GPT-REPAINT-GEOMETRY-FRAMING.md)。本地修改，未推送或部署。

2026-09-20 M04（协作 M03/M08/M15）：`GENERATION-RESULT-PARSE/1.0.0`、`LOCAL-REPAINT-DATAURL/1.0.0` 修复后台生图完成与模型交互重叠时的主线程卡顿。真实 4517 长帧定位到 `Response.json.then 1009.4ms` 及两次 `FileReader.onload 864.8/858.7ms`；大于等于 256KiB 的服务 JSON 改为 Worker 解码/解析，大 Blob 的 Data URL 转换改为 Worker `FileReaderSync`，两者先返回小型 ready 并在视口静默后才发布完整对象/字符串；小响应和小 Blob 保留原生快路径。局部重绘返图直接通过短生命周期 Blob URL 解码，移除一次无效 base64 往返。响应字段、图片字节、完整分辨率、QA、GPU/shader、Project Command/CAS/ownership/verified assets、持久化/export 不变，无迁移。4517 生产构建 12MiB 等价响应最终复测：持续交互 350ms 内不发布，保护/全程最大帧 `16.8/16.8ms`、P95 `16.8ms`，结果精确一致；合并最新 master 后 Web 全量回归 `151/151`，交互任务复用已有后台 payload Worker 制品且每次仍使用独立实例，ready/release/result 握手压缩为等价定长消息；同时对无预处理指令、无注释、无插值的静态应用 GLSL 仅压缩空白并以 token/directive 回归保证语义，正式包体 `3,255,804/3,256,500` bytes，保留 696-byte 总量余量并通过 256-byte 发布余量门禁，未提高预算。未重新发起付费生图，首次九模型恢复仍有独立长帧。详见 [生图结果发布的交互优先级](changes/CHG-20260920-GENERATION-RESULT-INTERACTION-SAFETY.md)。本地修改，未推送或部署。

2026-09-20 M07（协作 M06/M09/M15）：`UV-PREVIEW-DETACHED-UPLOAD/1.0.0`、`UV-PERSISTENT-MERGE-READ/1.1.0`、`UV-BAKE-FRAME-PACING/1.0.0` 处理 4K 投影转 UV 的交互掉帧。detached 精确上传由每 renderer 每任务 8 个 128K 条带收紧为 1 个；64 MiB 派生缓存的读取、SHA/尺寸/元数据验证移入 Worker 并转移原 buffer；透明清理、CPU postprocess 和派生缓存写入在有界批次间跨真实 paint，避免 `scheduler.yield` continuation 在一次呈现前聚集。完整 4K、RGBA/coverage、拓扑最终差异、QA、shader、作者资产、export、Schema/Command/CAS/ownership/verified assets 不变，无迁移。真实 4517 S4 修改前上传峰值 116.8ms/8% 掉帧；热复测 16.8ms 最大帧/0%，冷复测交互保护 16.9ms 且 RGBA/拓扑差异 0；后续冷样本暴露的 53–242ms 缓存读取/后处理峰值据此继续分帧。验证、回滚及仍未解决的首次恢复/生图并行热点见 [4K 投影转 UV 交互帧调度](changes/CHG-20260920-UV-MERGE-INTERACTION-FRAME-PACING.md)。本地修改，未提交、推送或部署。

2026-09-20 M07（协作 M06/M09/M15）：`UV-UNDERLAY-ATTRIBUTION/1.0.0` 将 Resident UV underlay 的 rendered-color attribution 从 UI 主线程两次全图遍历迁入既有 WebGPU/CPU Worker。WebGPU 输出经原 CPU 抽样验证后按原整数公式分片更新 R8 mask；CPU 交互/失败 fallback 在原 source-under 合成循环内同步更新，移除 4K 约 16 MiB alpha 临时数组。source-under 顺序、RGBA/mask 字节、完整分辨率、QA、GPU shader、持久化/export、Schema/Command/CAS/ownership/verified assets 不变，无迁移。Edge 152 实际 WebGPU Worker 的 512/4096 RGBA 与 mask 对照均零差异；交错 8 轮的 4K underlay 阶段中位数 `132.8→112.8ms`、P95 `135.4→117.5ms`，采样最大帧间隔 `33.4→16.8ms`。Web 全量回归 150/150、生产 Web build/typecheck、改动文件 lint、原包体及 256-byte 总量余量门禁通过：109 chunks、3,253,249/3,256,500 bytes，hot chunk 714,739/715,000；未提高预算。详见 [Resident UV underlay 归属更新](changes/CHG-20260920-UV-UNDERLAY-ATTRIBUTION.md)。本地修改，未提交、推送或部署；未做真实用户工程端到端 P95/P99 与 30 分钟 soak，不宣称整体投影转 UV 已无卡顿。

2026-09-20 M07（协作 M03/M08）：`UV-COMPOSITE-BITMAP-LIFETIME/1.0.2` 补齐主线程实时 UV 位图失败清理。正常路径保留并行快照、输入顺序、原始尺寸/透明度及 Worker 所有权；仅失败时释放每个已完成或迟到成功的位图，并等待全部在途解码终态后保留原错误退出，避免下一轮与遗留解码重叠。统一两个原本相同的 Worker 派发入口并复用队列探针引用，未改变调度/计数。GPU/CPU/Worker/shader 像素、QA、分辨率、持久化/export、Schema/Command/CAS/ownership/verified assets 不变，无迁移。真实 Edge 152 隔离 1K×13 层、4K×4 层完整 RGBA 对照零差异，原生异常清理通过；交错各 40 次的 4K 阶段 P95 2.8→2.9ms（约 +3.6%，低于 5% 退化门禁），不宣称提速或真实工程无卡顿。Web 全量回归 150/150、Cloud 参数 Web build/typecheck、改动文件 lint、Cloud/Repository 边界通过；原包体及 256-byte 总量余量门禁通过：109 chunks、3,252,925/3,256,500 bytes，hot chunk 714,997/715,000（仅剩 3 bytes，不提高预算）。验证细节、采样波动、对应实现审计及回滚见 [主线程位图生命周期](changes/CHG-20260920-UV-LIVE-BITMAP-LIFECYCLE.md)。本地修改，未提交、推送或部署；真实工程投影转 UV 分阶段提速、帧稳定性和 30 分钟 soak 仍待后续验证。

2026-09-20 M10/M13 与 M07 稳定性审计四项独立修复：`BAKE-JOB-PERSISTENCE/1.0.1` 隔离后台失败终态再次写盘失败并报告错误；`UV-COMPOSITE-DISPATCH/1.0.1` 在 Worker 构造/派发失败后释放活动槽与输入、继续队列；`UV-COMPOSITE-BITMAP-LIFETIME/1.0.1` 取消剩余 fetch 并等待在途解码后释放失败任务位图；`UV-DISPLAY-DERIVED-CACHE/1.4.1` 保留排队项自己的 scope。四项故障回归均旧失败、新通过。GPU/CPU/Worker/shader 像素公式、完整分辨率、QA、持久作者资产/导出与 Schema/Command/CAS/ownership/verified assets 不变，无数据迁移；详细异常边界、验证与独立回滚见 [Bake 监控](changes/CHG-20260920-BAKE-MONITOR-FAILURE.md)、[UV 派发](changes/CHG-20260920-UV-DISPATCH-FAILURE.md)、[位图生命周期](changes/CHG-20260920-UV-BITMAP-LIFECYCLE.md)、[缓存 scope](changes/CHG-20260920-UV-CACHE-QUEUED-SCOPE.md)。Web 149/149、Server 27/27、Contracts 9/9、全仓 typecheck/lint、Cloud/Repository 边界、Cloud 构建/制品/部署模拟通过；最终派发精简后再次通过对应回归、Web build/typecheck/lint。原包体门禁及总 JS 256-byte reserve 通过：109 chunks、3,252,923/3,256,500 bytes，hot chunk 714,995/715,000（仅剩 5 bytes，后续提交必须重新实测，未提高预算）。本地修改，未提交、推送或部署，未运行要求干净提交的 verify:prepush 包装器；未做本轮真实 GPU 像素回放或 30 分钟 soak，不宣称生产长期稳定性或端到端帧率已验收。成功路径多图同时解码峰值、GPU 总预算与 Bake 历史索引仍留待独立优化。

2026-09-20 UI-05 → M04：`SINGLE-VIEW-COMPLETION/1.0.0` 在 GPT/ModelView 单视图自动回贴事务成功保存图层与回执后，复用同一已确认的 Generation，不再改写回贴完成时间并串行保存第二次。仅本次保存 Promise 成功且单张结果/实际图层完整、无失败时跳过收尾重复 checkpoint；已有内存标记、保存失败、图层删除和多视图仍走原收尾保存。等待必要保存时明确显示“回贴完成，正在保存”，不提前假报完成。GPU/CPU/Worker/shader、分辨率、QA、投影/UV/export 像素与 Schema/Command/CAS/ownership/verified assets 不变，无历史迁移。详见 [单视图完成保存去重](changes/CHG-20260920-SINGLE-VIEW-COMPLETION.md)。本地修改，未推送或部署。

2026-09-20 M04（协作 M03/M06/M07）：`MODELVIEW-PRESENTATION-BARRIER/1.0.0` 将 ModelView 多视图的单次 resident 事件等待改为目标对象实际显示材质与本次新图层 ID 检查，复用 GPT 的严格 presentation 屏障。Resident UV 材质原位更新或检查开始前已完成均可确认；旧 atlas、缺失对象、warmup 材质和未完成 mesh 不放行，经过两次浏览器绘制调度再复核，取消仍中止串行。60 秒只提示等待，不超时跳过、不重复生图。GPU/CPU/Worker/shader、完整分辨率、QA、回贴/导出像素与 Command/CAS/ownership 不变，无 Schema/历史资产迁移。详见 [ModelView 回贴完成屏障](changes/CHG-20260920-MODELVIEW-PRESENTATION-BARRIER.md)。本地修复，未推送或部署。

2026-09-20 M02（协作 M10/M13）：`IMPORT-DECIMATE` v1.1.0 在导入严格超过 150 万三角面并获用户确认后，先逐对象按距离合并顶点（对象本地坐标 threshold=0.0001，与导入展 UV 一致），再执行原约 20 万面 COLLAPSE 减面。合并后重新统计预算与比例；每对象合并面积比例须在 [0.99,1.01]，保留有限坐标、非空表面、减面/GLB 回读 QA。确认框说明几何变化，后续异常 UV 仍独立确认。不跨对象，不修改存量资产或原文件，GPU/CPU/Worker/shader/持久化/export 继续消费最终验证 GLB；Schema/Command/CAS/ownership 不变，无历史迁移。真实 1,999,546 面模型经完整 HTTP/Blender 流程得到 199,998 面，面积变化约 +0.034%；浏览器取消/失败/阈值/两阶段导入回归通过。详见 [高模导入减面前合并顶点](changes/CHG-20260920-IMPORT-DECIMATE-MERGE-DISTANCE.md)。本轮未推送或部署。

2026-09-20 M06/M07（协作 M09/M15）：`UV-LAYER-CONTRIBUTION` v1.0.3 将 Resident UV 图层贡献缓存的 64×64 无损占用索引从三次 4×4 GPU 归约改为两次 8×8 GPU 归约。两者覆盖同一 64×64 texel，仍逐 texel 以 alpha>0 判定，不改 packed RGBA、质量字节、Top-K 顺序、完整分辨率或最终/导出像素；仅移除一个派生索引 render target、一次 GPU pass 和一次 browser-task 让步。CPU/Worker/持久化读取仍消费相同瓦片协议，旧贡献仅为会话级可丢弃缓存，无 Schema/资产迁移。回滚恢复 4×4 三层归约即可。详见 [Resident UV 贡献索引两级归约](changes/CHG-20260920-RESIDENT-UV-CONTRIBUTION-REDUCTION.md)。

2026-09-20 M06/M07（协作 M09/M15）：`UV-DISPLAY-DERIVED-CACHE` v1.4.0 将 Resident UV 的可信派生键计算与同工程、同对象、同分辨率、同可见层状态的压缩缓存读取/解压并行。Worker 只保存一个小型 active pointer；候选 RGBA/mask 仍先校验压缩字节 SHA-256，主线程再以完整账号范围、真实几何/来源字节 SHA-256 的 64 位 key 二次比对，任一 scope/key 不符即丢弃候选并回到原串行精确恢复/重算，绝不提前发布。GPU raster、Top-K、质量合成、完整分辨率、QA、持久作者资产和 export 像素不变。真实 4517 4K 六投影层热恢复 `cacheLookupMs` 从 `1195.5ms` 降至连续三轮 `884.8/820.6/779.6ms`（中位约 `-31%`）；隔离回放中位约 `832.5→630.0ms`，`completeBakeMs=0` 且错误为 0。为守住 CI 包体，Bake high 的纯数据快照改用平台 `structuredClone` 保持深拷贝语义，hot chunk `714292/715000`、总 JS `3251496/3256500`，未提高预算。Project Schema/Command/CAS/ownership/verified assets 不变；新增 Cache Storage pointer 为可丢弃派生元数据，无数据迁移。回滚移除 speculative pointer/并行分支即可恢复串行验证。详见 [Resident UV 验证与解压并行](changes/CHG-20260920-RESIDENT-UV-VERIFIED-RESTORE-OVERLAP.md)。

2026-09-20 M08（协作 M06/M07/UI-06/UI-10/M15）：`ALG-ERASE-001` 调度修订 v1.5.7 / `UV-DISPLAY-BUFFER` v1.5.5 / `ALG-PROJ-007` v2.1.14 消除多 UV 投影层橡皮擦的逐层 GPU 预热和 texture-array 假性等待。投影数组的有界条带上传仅在视口正在交互时等待下一呈现帧，空闲构建改为 browser-task 让步，避免 hidden/throttled rAF 的 120ms 保险超时被 117 个条带重复累加。已编译的全分辨率 `UvRepaint` 引擎改为同模型+同分辨率所有；上一层的笔画提交、Resident 验证交接及历史捕获完成且无活动指针后，白化 GPU keep-mask 并同步重绑到下一层，不再重建 4K render target、网格副本和 shader。正式 mask、历史/撤销/重做、完整分辨率、QA、CPU/Worker 细化、持久化与 export 不变；实时擦除仍不使用 Resident UV，笔画提交后可后台收敛最终 verified UV。4517 真实 4K/13 投影层：数组 pipeline `17569.6ms → 2074.8–2262.0ms`，26 次连续切层全部命中复用（0 超时、0 重建、Resident revision 不变），真实 4K 首笔提交 `5.8ms`，测试笔迹已撤销。发布构建去掉重复 DOM 上传分项副本但保留逐数组结构化性能事件和总 pipeline 耗时，清理两个死代码 lint 警告；Cloud 配置实测 hot chunk `714787/715000`、总 JS `3251055/3256500`，未提高预算。Project Schema/Command/CAS/ownership/verified assets 不变，无数据迁移；回滚恢复逐条带 paint 等待与逐层 `UvRepaint.dispose()` 重建。详见 [橡皮擦 GPU 会话复用与数组调度](changes/CHG-20260920-ERASER-GPU-SESSION-REUSE.md)。

2026-09-20 UI-05 → M04（协作 M03/M13/M14）：`SINGLE-VIEW-RESULT-BLEND/1.0.0` 对新单视图远端补全请求冻结当前纹理图、模型轮廓、原法线与相机；模型缺纹理处权重1、已有纹理处clamp(N·V,0,1)、背景0，控制面按字节混合返图与旧图，保存最终PNG和raw/base/gradient资产。远端原四图及黑白mask外扩/羽化字节保持，渐变不外发；不改GPT、手绘局部重绘、无纹理生成或多视图。尺寸不符拒绝合成，取消保留已有资产；GPU/Worker/shader/UV/export仍消费原捕获几何与已保存最终图，分辨率、QA、Command/CAS/ownership不变。旧请求无该参数继续直出，无历史迁移。范围、回滚与验证见 [单视图返图渐变合成](changes/CHG-20260920-SINGLE-VIEW-RESULT-BLEND.md)。本地实现，未部署。

2026-09-18 M12（UI-05 接线）：`NORMAL-GUIDE-BACKGROUND/1.0.0` 新增“法线黑色背景”会话开关，默认关闭蓝底，开启黑底；覆盖 ModelView 单/多视图、ModelView/GPT 局部重绘法线输入。只对原法线 pass 设置不透明背景和忽略 scene.background，不按 RGB 匹配替换蓝色，不增渲染 pass/CPU 遍历/Worker 重编码；模型法线编码、相机、尺寸、材质/蒙版/外扩、回贴及 QA 不变。生成配置/提交双重锁定；逐视角仍重新捕获，局部重绘 fingerprint/诊断记录底色。Project Schema、Command/CAS/ownership/verified assets、GPU/CPU/Worker/shader 合成及 UV/export 不变，无历史迁移；开关不写工程，刷新默认关闭。回滚恢复原捕获背景和 UI 即可，历史资产不重写。详见 [法线背景开关](changes/CHG-20260918-NORMAL-GUIDE-BACKGROUND.md)。未推送或部署。

2026-09-18 M04（协作 M12/M13）：`MODELVIEW-SINGLE-NORMAL/1.0.0` 为 ModelView 单视图生成及单视图补全增加必填 `normal_image`；分别提交主图/参考图/法线三图和主图/参考图/原外扩蒙版/法线四图。逐视角串行复用同一 Capture 的完整法线，不重新捕获、不填白、不转换通道；前端阻止缺失法线，代理校验同尺寸及有效图片并原字节透传。工作流与幂等后缀使用 2026-09-18 refcontrol-normal 版本。保留最新 master 的普通局部重绘四图输入、原始法线编码与按需加载；GPT、蒙版外扩、润色、串行回贴、QA、GPU/CPU/Worker/shader、UV/export 和 Schema/Command/CAS/ownership 不变。无历史迁移；回滚需前后端与远端双/三图旧契约成套协调。专项回归覆盖两入口正常/缺失/错尺寸/无效法线、原字节透传、串行顺序、取消和原 GPT/局部重绘流程。

2026-09-18 M08：`MODELVIEW-NORMAL-INPUT/1.0.0` 对接 `2026.09.18-refcontrol-normal-4step-r1`，局部重绘在纯白选区效果图、材质参考和外扩 mask 外增加同冻结相机、同画布原生 2K 几何法线。原始法线不滤波、不改色，控制面原字节转发并校验存在性、可解码性及尺寸；升级幂等后缀。单视图/GPT、回贴/Worker/UV/export、Project schema 和质量标准不变。旧结果无需迁移，回退需前后端与远端协调；未部署。详见 [原始法线四图输入](changes/CHG-20260918-MODELVIEW-NORMAL-INPUT.md)。

2026-09-18 M06/M07/M09：`UV-PERSISTENT-MERGE-KEY` v1.1.0 / `UV-DISPLAY-DERIVED-CACHE` v1.2.0 缩短 Resident UV/投影转 UV 的确定性派生键准备，并修复工程恢复 A→B→C 合法状态在两条磁盘窗口中循环淘汰。模型 position/normal/uv/index 的真实字节 SHA-256 以最多 2 路队列和既有 3 路来源校验并行；派生缓存改为最多 4 条且压缩总字节硬限 256MiB，裁剪时固定当前显示与新写状态，旧无长度元数据条目保守淘汰。输出键、像素、完整分辨率、QA、GPU/shader、Project Command/CAS/ownership、作者资产与导出不变。4517 真实 4K 六层工程从连续重载约 2342–2348ms 全量重算降到连续三次 987.0/909.4/924.5ms 精确恢复，均为 `completeBakeMs=0`。详见 [Resident UV 派生键与恢复缓存稳定化](changes/CHG-20260918-RESIDENT-UV-PERSISTENT-KEY-OVERLAP.md)。

2026-09-18 M08（协作 M06/M07/UI-06/UI-10）：`ALG-ERASE-001` 调度修订 v1.5.6 / `UV-DISPLAY-BUFFER` v1.5.4 消除多投影层橡皮逐层约 2–5 秒预热。WebGL2 多视图 texture-array 在工程完整恢复后一次性后台驻留，材质转移后保留 GPU-ready 签名；每个作者层预留唯一 keep-mask array slice，实时笔画先走完整分辨率 live multiplier，提交/切层再在 GPU 内原位乘入该 slice，不把中性 mask、正式 mask URL 或 Canvas revision 变成整组数组重建条件。未落笔的中性预览同步释放；撤销/重做使用正式 paint canvas 原位替换 slice。Resident UV 在橡皮交互中不启动，最终资产、历史与质量链不变。4517 真实六层完成 18 次切层、30 次落笔（含 12 次首点）及 4 次撤销+4 次重做；首点调用 18–217ms、短划 158–597ms（均含浏览器自动化开销），`active === prepared`、array=`ready`、材质 revision=2、Resident revision=1 全程成立。测试笔迹最后通过带 CAS 的 Project Command 恢复到测试前六层 mask；无分辨率、QA、Schema 或资产迁移。详见 [多层橡皮一次驻留快速切层](changes/CHG-20260918-ERASER-ARRAY-RESIDENCY.md)。

2026-09-18 M08（协作 M06/M07/UI-06/UI-10）：`ALG-ERASE-001` 调度修订 v1.5.5 / `UV-DISPLAY-BUFFER` v1.5.3 将 projected-mask 橡皮的快速路径所有权提前到工具激活，而非首次 pointer-down。多视图投影栈超过 direct sampler 预算时使用已有精确 texture-array 材质，live keep-mask 继续作为独立全分辨率采样器叠乘；橡皮激活期间 Resident UV 不启动 draft/final bake，在途最终收敛立即取消。WebGL2/预算不安全设备保留最后 verified front，不用 Resident UV 模拟交互。正式 mask 提交、历史、撤销/重做、Top-K/gutter 最终收敛、持久化/export、分辨率和 QA 不变；无 Schema/资产迁移。六投影层 4517 实测工具激活为 `useTextureArrays=true`，连续笔画期间 Resident draw/revision 与材质 build revision 均不增加。详见 [多视图橡皮 texture-array 快速路径](changes/CHG-20260918-ERASER-MULTIVIEW-TEXTURE-ARRAY.md)。

2026-09-18 M08（协作 M06/M07/UI-06/UI-10）：`ALG-ERASE-001` 调度修订 v1.5.4 / `UV-DISPLAY-BUFFER` v1.5.2 强制 projected-mask 橡皮交互只走已武装的完整分辨率 GPU live keep-mask：Resident UV compositor 在同对象、同层 draft 活动时不 flush、不 snapshot、不 bake、不 readback、不上传；已有最终 UV 收敛若遇到新笔迹即取消，待抬笔提交且交互空闲后只重算最终签名。多个可见 UV/投影层不再让每个 pointer revision 争用 Resident UV。正式 mask、历史、撤销/重做、质量合成、接缝/gutter、持久化/export、完整分辨率和 QA 不变；无 Schema/资产迁移。详见 [橡皮交互禁用 Resident UV](changes/CHG-20260918-ERASER-RESIDENT-DEFER.md)。

2026-09-18 M08（协作 M06/M07/UI-06/UI-10）：`ALG-ERASE-001` 调度修订 v1.5.3 / `UV-DISPLAY-BUFFER` v1.4.1 修复 `352cd3e8` UV-only 改造切断 `251700e9` 全分辨率 GPU 橡皮实时显示的问题。空闲仍只显示 verified Resident UV；仅活动模型的普通 projected-mask 橡皮或其提交交接临时启用预算安全的 exact direct 栈，拖动帧直接采样 live keep-mask。中性预热新增 renderer-only `displayArmed=false`，不会提前切换显示；sampler/uniform 预算失败继续 fail-closed。覆盖/深度/顺序、CPU/Worker 正式细化、完整分辨率、QA、持久化/export、Schema/Command/CAS/ownership/verified assets 不变，无迁移。详见 [投影橡皮实时快速显示恢复](changes/CHG-20260918-PROJECTED-ERASER-FAST-DISPLAY.md)。

2026-09-18 UI-04/UI-05（协作 M01/M02/M04/M10）：`USER-FILE-UPLOAD/1.0.0` 为浏览器手动文件入口统一单文件 100×1024×1024 字节上限，超过时先提示“文件大小超过 100MB 限制”并整批返回，不读取、解析、更新项目或发起上传。覆盖编辑器模型/配套资源/参考图/工程/图层替换、参考图面板选择/拖入/粘贴、Bake 模型/材质/Cage、资产处理文件选择；恰好上限允许，多文件不合计。仅前端用户选择门禁，不修改内部生成/恢复/自动保存的资产限制，也不是服务端全局请求体限制；GPU/CPU/Worker/shader、算法像素、Schema/Command/CAS/ownership 不变。无迁移，回滚移除入口门禁；详见 [手动上传上限](changes/CHG-20260918-USER-FILE-UPLOAD-LIMIT.md)。未推送或部署。

2026-09-18 M08（协作 M04/M06/M07/M12）：`ALG-LR-013` v1.2.0 将原局部重绘模型轮廓内缩改为 3px@2048，半径按最长边等比取整且至少 1px，外轮廓退缩和内部孔洞扩大同时生效。新结果 metadata.modelSilhouetteClipVersion=2，保留版本 1/2 源 alpha 识别，历史结果不重算；GPT 原始 RGBA 路径、作者蒙版、内向渐变、输入外扩、RGB/画布/相机和分辨率不变。GPU/CPU/Worker/合并/export 继续透传同一裁后 alpha，无 Schema 或资产迁移；回滚与兼容边界见 [3px 内缩变更卡](changes/CHG-20260918-REPAINT-INSET-3PX.md)。未推送或部署。

2026-09-18 M08（协作 M03/M04/M06/UI-06/UI-10）：`INPAINT-TOOL-SESSION/1.0.1` 将“生图完成回贴后按钮 1 偶发不能画/错位”纳入真实生产视口回归。内置浏览器运行 `BottomToolDock + ViewportCanvas + sceneStore + layerStore`，普通状态 30 轮重复激活并穿插视角/缩放；再以真实单视图回贴与多视图 preview batch 完成路径交替 20 轮、累计 56 图层。全部生成作者蒙版且无 warning，完成态最大归一化落点漂移 X `0.00361`、Y `0.00091`。生产修复仍为非持久 activation revision 与视口输入会话 rearm；GPU/CPU/Worker/shader、蒙版像素、分辨率、QA、持久化/export 不变，无迁移。详见 [蒙版工具会话自愈](changes/CHG-20260917-INPAINT-TOOL-SESSION.md)。

2026-09-18 M04（协作 M03/M06/M08/M12/M13）：`GPT-CONTENT-FRAMING/2.2.1` 修复 v2 将原生回图尺寸不同误判为比例错误：v1/v2 统一校验真实宽高比与既有 16px 网格容差，保留原生像素，不拉伸/裁切/降采样；真实比例偏差、轮廓、空 Alpha 和安全上限仍 fail-closed。`GPT-MULTIVIEW-PAIR-SEQUENCE/1.4.1` / `GPT-SILHOUETTE-RETRY/1.0.2` 仅在本组缺失完全由已识别 QA 拒绝解释时保留成功兄弟并继续后续组；网络、提交、保存、投影、resident、取消及未知错误仍停止。至少一张成功才执行批末补缝。仅复用可选 Generation metadata，无 Schema/资产迁移；Command/CAS/ownership/verified assets 不变。详见 [GPT 回图比例 QA 与多视图续跑](changes/CHG-20260918-GPT-RETURN-QA-CONTINUATION.md)。

2026-09-18 M15：`CI-CONTAINER-DEPENDENCY-RETRY/1.0.0` 修复 master `4fb1d8ec` pipeline `633789` 仅 server 容器在 Corepack 下载中被远端断开而失败的问题。Docker deps 阶段对固定 pnpm 9.15.4 准备与 frozen-lockfile 安装分别最多尝试 3 次，等待 5/10 秒；连续失败仍阻断，不更换 registry、依赖、基础镜像，不跳过 verify/build/包体/Cloud 产物门禁。server/web 镜像目标、推送与部署规则不变；浏览器/服务端功能、GPU/CPU/Worker/shader、投影/UV/重绘/Bake 像素、分辨率、QA、Schema/Command/CAS/ownership/verified assets 和导出均不变，无迁移。验证、边界与回滚见 [容器依赖重试变更卡](changes/CHG-20260918-CI-CONTAINER-DEPENDENCY-RETRY.md)。

2026-09-18 M10/M13（协作 M15）：`BAKE-DOWNLOAD-METADATA/1.0.0` 将 Bake 单图下载与 ZIP 清单构造中的 Job 冷读取、输出存在性和文件大小检查从同步文件 API 改为异步 metadata。所有入口继续要求成功终态、持久化 owner、已请求通道和普通文件；ZIP 按通道顺序逐项检查，避免一次请求扩大共享卷 I/O 扇出，文件名、CRC/ZIP64、HEAD/GET 与流式背压不变。GPU/CPU/Worker/shader、Bake 像素/通道/分辨率/QA、远端幂等、Job JSON、Project Command/CAS/ownership/verified assets、Schema 和导出字节均不变，无迁移。验证与回滚见 [Bake 下载异步 metadata 变更卡](changes/CHG-20260918-BAKE-DOWNLOAD-ASYNC-METADATA.md)。

2026-09-17 M04（协作 M12/UI-05）：`TEXTURE-GENERATION-RECOVERY-OWNERSHIP/1.0.0` / `GPT-SILHOUETTE-RETRY/1.0.1` 为前台单/多视图纹理流程建立项目级恢复写入所有权，后台单任务轮询、历史恢复在流程期间不接管 texture-map 校验/状态，跨越所有权变化的迟到成功或异常均丢弃；结束后恢复后台接管。QA 阈值、同一冻结视角重试一次、组内有序回贴与组间等待不改。被 QA 拒绝及已被重试替代的结果不反复恢复；单个历史任务异常不阻断其余任务。仅新增可选结果 metadata，无 Schema/数据迁移；GPU/CPU/Worker/shader、像素、分辨率、UV/export、Command/CAS/ownership/verified assets 保持不变。回滚移除恢复所有权门禁及可选拒绝标记消费者，历史资产保留。详见 [QA 与后台恢复所有权](changes/CHG-20260917-TEXTURE-QA-RECOVERY-OWNERSHIP.md)。本轮未推送或部署。

2026-09-17 M08（UI-10，协作 M05/M12）：`MASK-CLEAR-SHORTCUT/1.0.0` 将清空蒙版默认快捷键从 Ctrl+Shift+D 改为 Ctrl+D（沿用 primary 修饰键的 Mac Cmd 兼容）。按用户确认移除复制图层的默认快捷键及菜单 Ctrl+D 标签，保留复制菜单与自定义快捷键能力；清空提示同步为 CTRL D。现有清空历史、输入框保护、任务锁、preventDefault 与撤销入口不变；GPU/CPU/Worker/shader、蒙版像素算法、持久化、导出、Schema/Command/CAS/ownership 无变更。仅默认配置调整，无数据迁移，显式用户 overrides 保留；回滚恢复两项旧默认和标签即可。功能回归覆盖 Ctrl/Cmd+D、旧组合不触发、无复制冲突、菜单保留及自定义覆盖。本轮未推送或部署。

2026-09-17 UI-06/UI-10 → M08：`ALG-LR-UV-PAINT` v1.2.0 / UV_REPAINT_VERSION=5 修复刷上去即出现的 UV 岛细黑缝。按原分辨率 WebGL strict core，仅在岛外双线性足迹复制最近 core RGBA，透明/羽化 donor 保持，不补岛内孔洞或放宽作者/深度/可见性。留边纳入脏瓦片、撤销/重做/擦除与原 CPU 读回、Worker 合成、PNG/合并/export；复用 scratch，新增 R8 core。64–4K 实时接缝暗化 8→0，既有 HiDPI/遮挡/alpha/保存回归通过。旧资产不自动迁移，重刷命中区域生效；Schema/Command/CAS/ownership/verified assets、分辨率、QA 与 M06 采样不变。详见 [UV 重绘岛外留边](changes/CHG-20260917-UV-REPAINT-ISLAND-GUTTER.md)。本轮未推送或部署。

2026-09-17 M04（UI-05）：`TEXTURE-PROVIDER-SWITCH/1.0.0` 修正单/多视图入口被固定为 ModelView 的产品行为，在模式页签下恢复 GPT / ModelView 两项切换，默认 GPT；两个页签共用会话选择，生成中双重锁定，避免在途请求混用 provider。GPT 原成组生成与参数/提示词恢复可达，ModelView 全角度纯白输入及逐视角串行不变；局部重绘独立开关不改。无持久化或像素算法变更，GPU/CPU/Worker/shader、UV/export、分辨率、QA、Schema/Command/CAS/ownership 不变，无迁移；回滚仅移除切换并恢复固定 provider。详见 [生成模型切换](changes/CHG-20260917-TEXTURE-PROVIDER-SWITCH.md)。尚未推送或部署。

2026-09-17 M04（协作 M08/M12/M13）：`MODELVIEW-SINGLE-WHITE/1.0.0` 按用户确认将单/多视图所有角度（含顶/底）统一走 ModelView，多视图严格按预览顺序等待生成、回贴与 GPU resident 后再请求下一视角。无贴图整物体使用黑底纯白图一与参考图两字段，已有贴图补全使用纯白缺口合成图、参考图及原外扩 RGB 蒙版三字段；覆盖率仍由 alpha 判断，禁止 RGB 白色启发式。旧提示词不发送，远端采用 2026-09-17 内置提示词版本；更新幂等后缀与 45/46 分钟等待上限。Worker 增加显式远端白色策略，不改变 GPT 重绘/旧 GPT 补全、GPU/shader、UV、回贴/导出、分辨率、QA、Schema、Command/CAS/ownership 与 verified assets。无数据迁移；历史结果保留，回滚需配套远端工作流。详见 [单/多视图纯白输入](changes/CHG-20260917-MODELVIEW-SINGLE-WHITE.md)。尚未推送或部署。

2026-09-17 模型导入 → M02（协作 M10/M13）：`IMPORT-UV-REPAIR` v1.3.0 按用户要求在智能 UV 投射前执行 Blender 编辑模式“按距离合并”，每对象本地坐标 threshold=0.0001，不跨对象。该步骤实际改变网格连接，确认框明确告知；合并前后和 GLB 回读检查对象、有限坐标、非空表面及每对象面积比例 [0.99,1.01]。UV 三角面一致性以合并后为基线，0–1/退化 QA 保持；排布及按需内缩不变。GPU/CPU/Worker/shader/导出均读取最终保存模型，原文件、存量工程、Schema/Command/CAS/ownership 不改，无迁移。详见 [UV 合并顶点](changes/CHG-20260917-IMPORT-UV-MERGE-DISTANCE.md)。尚未推送或部署。

2026-09-17 模型导入 → M02（协作 M10/M13）：按用户要求恢复 `IMPORT-DECIMATE` v1.0.2。导入总三角面严格超过 150 万时确认，服务端 Blender 精简修改器 COLLAPSE 以约 20 万面为目标；保留 v1.0.1 共享顶点恢复和减面/回读表面积保护。减面后异常 UV 仍单独确认，沿用当前智能 UV 投射 v1.2.0，不恢复旧基于角度展开。此前简化步骤隐藏的服务器/目标面数确认文案继续隐藏。GPU/CPU/Worker/shader 读取最终资产，绘制/烘焙/保存/export、Schema/Command/CAS/ownership 不变，无存量迁移。详见 [恢复减面](changes/CHG-20260917-IMPORT-DECIMATE.md)。尚未推送或部署。

2026-09-17 M08（协作 M04/M12/M13）：`MODELVIEW-WHITE-INPUT/1.0.0` 适配 `2026.09.17-li3d4500-defaultprompt-steps2-r1`。原局部重绘图一改为效果图内纯白选区，图二参考、图三原外扩蒙版保持；不再捕获多余白模。智能润色项目开关默认关闭，默认仅三图、无 prompt；显式开启才走既有润色覆盖。新增策略 fingerprint/幂等后缀，保留冻结相机、作者蒙版、回贴、图层及持久化安全边界；GPT/单视图、GPU/shader/UV/export、分辨率与 QA 不变。无资产迁移；可选设置兼容旧项目，回滚需前后端与远端工作流协调。见 [三图纯白输入变更](changes/CHG-20260917-MODELVIEW-WHITE-INPUT.md)。本轮未推送或部署。
2026-09-17 M10/M13（协作 M15）：`BAKE-JOB-PERSISTENCE/1.0.0` 将 Substance Bake 的 `job.json` 从同步 `mkdirSync/writeFileSync` 改为按 Job ID 串行的异步临时文件 + 原子替换。同一 Job 的轮询、并发产物下载、失败、取消和成功终态按提交顺序写入；不同 Job 可并行，单次替换失败不会阻塞后续快照，终态路径等待落盘后返回。替换失败保留上一份完整 JSON 并清理临时文件。Job JSON 字段、状态机、远端幂等键、恢复语义、GPU/CPU/Worker/shader、Bake 像素/通道/分辨率/QA、Project Command/CAS/ownership/verified assets、Schema 与导出均不变，无迁移；本轮未推送或部署。验证和回滚见 [Bake Job 异步原子持久化](changes/CHG-20260917-BAKE-JOB-ATOMIC-PERSISTENCE.md)。

2026-09-17 M07（协作 M05/M06/M08/M09）：`LOCAL-BOUNDARY-REPAIR/1.4.0` / `CONTENT-REPAIR-SEAM-FALLBACK/1.0.0` 为首轮同 region 修复后仍无 donor 的余量增加按需 fallback：只有统计确认残余才构建同 Mesh/同材质/法线兼容的物理 seam links，第二轮最多跨一条 seam 且只能写 residual mask；全局平均、跨材质和岛链传播仍禁止。Worker 原地回传已转移 source/mask 并在 Worker 内合并两轮稀疏 RGBA，避免 4K continuation 复制；fallback 为 lazy chunk，常规首屏与无余量任务不加载。GPU/shader、投影/UV/repaint/export、分辨率、QA、Schema/Command/CAS/ownership/verified assets 不变，无迁移；孤立无可靠 donor 的表面仍明确保留余量。回滚与验证见 [内容填补按需物理缝余量修复](changes/CHG-20260917-CONTENT-REPAIR-BOUNDED-SEAM-FALLBACK.md)。

2026-09-17 M08（协作 M03/UI-06/UI-10）：`INPAINT-TOOL-SESSION/1.0.0` 修复局部重绘“绘制蒙版”按钮仍显示激活、但视口偶发不再接收笔画，刷新后恢复的问题。每次进入或重复点击蒙版工具发布非持久 activation revision；视口先结束失去捕获的孤立笔画、释放旧 pointer ownership，再按当前模型重同步投影、深度和覆盖层，尤其清除历史 GPU direct-ready 标记。普通点击、当前加/减选模式及作者蒙版保持；不使用延时重试，不重置已画内容。GPU/shader 像素核、CPU/Worker、Capture/GPT 输入、UV/repaint/export、分辨率、QA、Project Command/CAS/ownership/verified assets 与 Schema 不变，无数据迁移。回滚移除 activation revision 和重激活处理即可；详见 [蒙版工具会话自愈](changes/CHG-20260917-INPAINT-TOOL-SESSION.md)。本轮尚未推送或部署。

2026-09-17 M07（协作 M08/M11）：`UV-MANUAL-PAINT-COMPOSITION/1.0.0` / UV composition 12 将无专用 role 的普通 UV 绘制层纳入手动/自动合并和模型导出，不再依赖旧原生重绘 ID。底图/内容修补仍在投影下面，绘制层按现有 UV 栈顺序 source-over，保留原透明度；显隐、对象过滤、内部 draft 及旧版重绘兼容保持。GPU Worker、CPU fallback、预热和 FBX/GLB 共用新分类；普通模型导出先等待 live commit。原分辨率、QA、shader/绘制内核、持久化/CAS/ownership/verified assets 不变，无 Schema 或资产迁移；不自动改写旧合并图。详见 [手动 UV 重绘合并修复](changes/CHG-20260917-MANUAL-UV-MERGE.md)。本轮未推送或部署。

2026-09-17 M04（协作 M03/M08）：`GPT-CONTENT-FRAMING/2.2.0` 修复远端输入仅画布为正方形、短边背景仍被长方形 clip 清空的问题。上传引导图直接按长边方框截取完整原始 RGBA，颜色/法线共用坐标；仅超出源图的区域保留透明。比例、边距、回贴映射及历史 framing v1/v2 不变。GPU/CPU/Worker/shader、投影/UV/export、分辨率、QA、Schema/Command/CAS/ownership 均不改，无迁移。横图、竖图、触边和双引导逐像素回归旧失败、新通过。详见 [远端输入方形裁切](changes/CHG-20260917-SQUARE-INPUT-CROP.md)。本轮仅本地修改，尚未推送或部署。

2026-09-17 M04（协作 M03/M06/M08/M12/M13）：`GPT-RETURN-SILHOUETTE-QA/1.2.0` / `GPT-SILHOUETTE-RETRY/1.0.0` / `ALG-GEN-001/002` v1.3.1 实测“前下 45°”失败回图在预期主体底部之外新增大面积半透明背景/光晕，Alpha 底边外扩约 269 px，不放宽 12% 轮廓门禁。仅对稳定轮廓错误码，复用同一冻结 Capture/相机/参考/分辨率及确定性任务 ID 自动替代当前视角 1 次；恢复提示禁止背景、光晕、移动和裁切。第二次异常仍 fail-closed，两份结果均保留，无无界重试；同组成功视角不丢失。framing 提交与返图恢复/QA 按需分包，重试构造从 Editor 热包下沉；实测 Editor/framing/总 JS 余量分别为 `1034 B` / `1005 B` / `35449 B`，不调高预算。不改 GPU/CPU/Worker/shader、投影/UV/export、像素、Schema、Command/CAS/ownership/verified assets，无迁移；见 [GPT 轮廓漂移有界重试](changes/CHG-20260917-GPT-SILHOUETTE-RETRY.md)。

2026-09-17 M07（协作 M05/M06/M08/M09）：`LOCAL-BOUNDARY-REPAIR/1.3.1` / `CONTENT-REPAIR-WORKER-RESULT/1.0.0` 令正式内容填补发布只从 Worker 接收稀疏 RGBA 与统计，不再在 UI 线程保留未消费的 `repairedMask`、`sourceExclusionMask`；4K 少驻留约 32 MiB。诊断/测试调用默认仍返回完整结果，遗漏请求的诊断时 fail-closed。CPU/Worker 像素、GPU/shader、投影/UV/repaint/export、分辨率、QA、Schema/Command/CAS/ownership/verified assets 不变，无迁移；Edge 2K 精简 Worker/主线程 RGBA 字节差 0，4K 精简 Worker 通过。回滚与验证见 [内容填补 Worker 结果内存收敛](changes/CHG-20260917-CONTENT-REPAIR-WORKER-RESULT.md)。

2026-09-17 M15（协作 M04）：`RELEASE-PREPUSH/1.2.0` 修复发布前仅执行 lint/build 而遗漏其他 verify 任务的问题；从 CI 配置发现全部 verify script，保留各任务变量与任意失败即停止，再执行 build 和 256 字节余量门禁。多视图旧测试不再硬编码临时上传 ID，实际持久化行为由 reference-binding 回归覆盖新建、光照原位替换、独立参考、重复处理、选择与保存。生产功能、UV/GPU/CPU/Worker/shader、QA、Schema/Command/CAS/ownership 和资产不变，无迁移；回滚仅涉及测试与发布脚本。详见 [CI 回归修复](changes/CHG-20260917-CI-REFERENCE-SELECTION.md)。

2026-09-17 模型导入 → M02（协作 M10/M13）：`IMPORT-UV-REPAIR` v1.2.0 按用户要求改为 Blender 智能 UV 投射（66°），保留平均岛尺度、0.001 排布边距与按需补足 1e-6 外边界。为支持非索引 GLB，仅在临时 UV 工作网格恢复同位置顶点连接，按原面角写回 UV，不导出临时网格；原始几何、面数、材质及法线保持普通 Blender 回读语义。确认弹窗、0–1/退化 QA、GPU/CPU/Worker/shader、分辨率、保存/export、Schema/Command/CAS/ownership 不变；无存量工程迁移。真实 400162 面模型回读 UV 合格，2K 原始前后视图 GPU 投影通过。详见 [智能 UV 投射](changes/CHG-20260917-IMPORT-SMART-UV.md)。

2026-09-17 参考图菜单 UI-05 → M04（协作 M12/M13）：`REFERENCE-LIGHTING` v1.0.0 为已有多视图增加“光照处理”，直接以当前图提交一次 Sunburst medium，复用保色去光照提示词，不生成六视图。`REFERENCE-GROUP-BINDING` v1.2.0 在处理成功并持久化图片后原位替换多视图，保持 ID、分组及来源单视图绑定；上传独立多视图和重复处理也支持，失败保留旧图，取消/锁/重载沿用现有任务机制。新增可选任务 metadata 与 pipeline 值，无 Project Schema 或数据迁移；GPU/CPU/Worker/shader、贴图/重绘/export 像素不变。详见 [多视图光照处理](changes/CHG-20260917-REFERENCE-LIGHTING.md)。本轮未推送或部署。

2026-09-17 模型导入 → M02（协作 M10/M13）：按用户要求移除 IMPORT-DECIMATE 导入自动减面流程、确认弹窗和服务端接口/脚本。`IMPORT-UV-REPAIR` v1.1.0 恢复 UV 检查前的原有 200 万三角面门禁，150–200 万面保持原网格；异常 UV 仍须单独确认才由服务端 Blender 展开。GPU/CPU/Worker/shader、绘制/烘焙、Schema、Command/CAS/ownership 和已有资产不变，无迁移。独立重拓扑工作区不变；回滚恢复移除前版本，已有减面结果不自动复原。详见 [导入减面记录](changes/CHG-20260917-IMPORT-DECIMATE.md)。本轮未推送或部署。

2026-09-17 模型导入 → M02（协作 M10/M13）：`IMPORT-DECIMATE` v1.0.1 修复 FBX 转非索引 GLB 后各三角片断开导致简化漏面的问题，Blender 初次导入启用共享顶点恢复，保持每面角 UV；新增每对象表面积 [0.8,1.2] 保留率门禁，导出回读再验。真实服务样本 199999 面，面积比 1.000355，浏览器灰模和贴图无花斑；旧输出面积比仅 0.372370。用户确认、绘制/UV 内核、CPU/GPU/Worker/shader、Schema/Command/CAS/ownership 不变，无迁移；已有损坏结果需从源文件重新处理。并按用户要求删除确认框服务器/20万面描述。详见 [导入减面修复记录](changes/CHG-20260917-IMPORT-DECIMATE.md)。未推送或部署。

2026-09-17 M07（协作 M05/M06/M08/M09）：`LOCAL-BOUNDARY-REPAIR/1.3.0` / `ALG-CA-001` v1.1.0 将实时 shader 已显示为深色斜线的严格 UV core 缺口全部保留，不再按 4K 面积分量误删短裂缝；真实几何空隙、core 外保守 halo、跨 region/UV seam、全局平均兜底仍禁止。正式策略固定不跨 seam，因此编辑器不再构建/传递无效 seam links；局部混合仅在完整一轮字节无变化时结束。GPU/shader、分辨率、QA、持久化/export、Command/CAS/ownership/verified assets 与 Schema 不变，无迁移；Edge 2K Worker/主线程字节差 0，4K Worker 夹具通过，复杂真实模型仍需用户工程视觉验收。回滚与验证见 [放大视图深色斜线缺口修复](changes/CHG-20260917-CONTENT-AWARE-HATCH-GAPS.md)。

2026-09-17 M13（协作 M10/M15）：`ASSET-HISTORY-REFRESH/1.0.0` 将 UV/拓扑历史的非终态远端刷新纳入进程级有界协调器；全局最多 8 路、单用户最多 4 路，同一用户/Job 的同时请求共享一个 in-flight Promise。历史 HTTP 请求最多等待 2.75 秒，超出后返回已有持久记录，剩余刷新继续有界完成；远端失败仍保留旧记录。limit、排序、可信 kind 恢复、终态、产物、ownership、PostgreSQL/本地持久化、Asset TLS 与 API 均不变。两个身份、12 个活动任务、16 个并发历史读取的严格 TLS 冒烟测得全局 8/8、单用户 <=4、每 Job 一次远端访问；实现提交为 `d745d066`，无 Schema/数据迁移。详见 [Asset 历史刷新并发变更卡](changes/CHG-20260917-ASSET-HISTORY-REFRESH-CONCURRENCY.md)。

2026-09-17 模型导入 → M02（协作 M10/M13）：`IMPORT-DECIMATE` v1.0.0 在总三角面严格超过 150 万时弹窗，确认后服务端 Blender 简化至约 20 万面，再检查 UV；异常 UV 必须单独确认才执行现有展开/排布/内缩。取消或失败不注册模型；保存最终 GLB 并保留源单位，原文件及存量工程不变。原 200 万面门禁移至处理后；CPU/GPU/Worker/shader、绘制/烘焙 QA、Schema、Command/CAS/ownership 不变。无迁移，回滚入口与前置面数门禁，保留已生成资产。详见 [高面数导入减面](changes/CHG-20260917-IMPORT-DECIMATE.md)。实现已随 `20baefc2` 进入 `master`，未据此声明生产部署。

2026-09-17 模型导入 → M02（协作 M10/M13）：`IMPORT-UV-REPAIR` v1.0.0 检查 UV0 越界、非有限、缺失及 Float32 退化三角形；异常模型先弹窗，明确同意改变 UV 后才调用受认证的服务端 Blender 展开/排布/按需内缩。取消、修复或回读 QA 失败不加入工程。外边界补足 1e-6 余量，保留 0.001 岛排布 margin；保存修复后 GLB，正常模型和存量工程不改。源物理单位随对象保留；CPU/GPU/Worker/shader、绘制/烘焙阈值、Schema、Command/CAS/ownership 不变。无迁移，回滚关闭新入口并保留已修复资产。原贴图不转烘焙，确认框明确告知可能错位。已随 `32ad28ce` 进入 `master`；独立真实浏览器回归及 Server 回归通过，尚未据此声明生产部署。详见 [导入 UV 修复变更卡](changes/CHG-20260917-IMPORT-UV-REPAIR.md)。

2026-09-17 M10（协作 M13/M15）：`BAKE-ARTIFACT-IO/1.1.0` 将远端 Bake 产物缓存尺寸检查、自动 Roughness 的 Base Color 存在检查和 PNG 24-byte 文件头验收从同步文件 API 改为 `fs.promises` / 异步 FileHandle；缓存异常仍按未命中重新下载，完整写入、SHA-256、MIME、通道、分辨率和失败后不发布保持。GPU/CPU/Worker/shader、像素/QA、远端幂等、Job JSON、Project Command、Revision CAS、ownership、verified assets 和 Schema 不变，无迁移。已随 `2222576c` 进入 `master`，最终 Server 24/24 与正式 pre-push 门禁通过；回滚与验证见 [Bake 产物异步 I/O 变更卡](changes/CHG-20260917-BAKE-ARTIFACT-ASYNC-IO.md)。

2026-09-17 M13/M15（协作 M10）：`BAKE-HISTORY-LIST/1.1.0` 将 Bake 历史 HTTP 请求中的目录、Job JSON 和输出 metadata 改为异步读取；同时到达的多用户请求共享一次目录扫描与最多 8 路未缓存读取，批次按持久化 owner 建索引，单请求逐任务构造输出以限制 I/O 扇出。owner 隔离、无 owner 旧任务拒绝、排序、limit、未终态监控恢复和 Job JSON 保持不变；10 身份/34 归属任务/40 并发请求冒烟通过。`ASSET-TRANSFER-TEST-PORT/1.0.0` 令本地对象存储夹具避开 WHATWG Fetch 禁止端口。两项均不改变 GPU/CPU/Worker/shader、投影/UV/重绘/export、分辨率、QA、Project Command、Revision CAS、ownership、verified assets 或 Schema，无迁移；已随 `2222576c` 进入 `master`，正式构建为 104 chunks / 3,214,864 bytes，Cloud release-readiness 仍因 8 项真实生产证据为 `in_progress` 而拒绝发布。见 [Bake 历史并发变更卡](changes/CHG-20260917-BAKE-HISTORY-CONCURRENCY.md) 与 [2026-09-17 性能稳定性审计](PERFORMANCE_STABILITY_RISK_AUDIT_2026-09-17.zh-CN.md)。

2026-09-17 M15：本地 API 冒烟的缺失图层引用恢复夹具改为显式种入旧版 `<layer-id>.png` / mask / depth 确定性文件，再验证现有 legacy repair；不再要求该兼容路径从当前 UUID 防冲突上传文件中猜测随机 URL。生产代码、资产推断、ownership、verified assets、Project/Revision Schema 均不变，无迁移。

2026-09-16 UI-01：`EDITOR-HEADER-STYLE` v1.0.0 统一贴图工作台项目头、贴图/UV/烘焙切换栏、视角/分辨率工具组和新手引导外框为 64px 高度，内容垂直居中；新手引导改为不透明黑底白字，使用与工作流按钮一致的 text-sm / font-semibold。仅当前编辑器样式调整，不改变其他工作流页、教程进度、导航/绘制/生成、CPU/GPU/Worker/shader、Schema 或保存/导出。无迁移；回滚两个生产组件的样式即可。详见 [新手引导变更卡](changes/CHG-20260916-TEXTURE-ONBOARDING.md)。本轮未推送或部署。

2026-09-16 UI-06 → M03：`ALG-VIEW-INPUT-001` v1.4.1 将 Alt＋右键拖动改为左/上缩小、右/下放大；仅反转拖动缩放输入符号，保持 0.005 灵敏度、滚轮、旋转、中键平移、相机界限与指针归属。透视/正交四方向和双向界限执行真实控制器回归。GPU/CPU/Worker/shader 绘制、捕获、UV/export、保存及 Schema 不变，无迁移；回滚仅恢复拖动符号和对应测试。详见 [Alt 视角导航变更卡](changes/CHG-20260915-ALT-VIEWPORT-NAVIGATION.md)。本轮未推送或部署。

2026-09-16 UI-01：`TEXTURE-ONBOARDING` v3.0.1 将新手引导入口移至顶部工具栏分辨率右侧，活动教程也保留入口；移除“定位操作区”按钮，进入步骤自动展开对应面板并滚动到操作区，保留高亮与暂停/继续。窄屏工具栏可换行。仅 UI 展示调整，v3 本地进度、Project Schema、生成/绘制/CPU/GPU/Worker/shader/持久化和导出不变，无数据迁移；回滚恢复原入口位置与按钮。验证见 [新手引导简化](changes/CHG-20260916-TEXTURE-ONBOARDING.md)。本轮未推送或部署。

2026-09-16 UI-01 → M12/M14：恢复已在 A100 验证但未进入 master 的 `DB-CONNECTION-RECOVERY/1.0.0` 与项目列表单次 JSON 展开修复。515da7f9 发布覆盖了线上独有修复，导致数据库断连再次触发 API 进程未处理 error 退出；本次通过正式 cherry-pick 61338e99 保留新手引导与最新存储更新。空闲/借出连接异常、ROLLBACK 失败保持原错误且丢弃坏连接，禁止重放不确定写入；列表只一次解压 JSON，前端保留缓存并提供重试与正确云端提示。无像素/Project Schema/数据迁移。发布前必须比较实际线上 SHA 与候选提交差异，线上 SHA 非候选祖先时逐项核对独有修复，不能仅以候选 master 健康检查替代。详见 [断连修复与覆盖事故](changes/CHG-20260916-DATABASE-DISCONNECT-RECOVERY.md)。

2026-09-16 UI-01（协作 UI-05/UI-10）：`TEXTURE-ONBOARDING` v3.0.0 将新手主线缩为导入模型、添加参考图、生成纹理三步；单视图调整与局部重绘改为主动选学。关闭/Escape 只暂停，生成期间保留组件与项目进度；返回上一步进入手动复习，旧教程不重复弹出。生成完成需成功结果、回贴提交与可见图层；局部蒙版需真实内容，最后涂抹由用户明确确认。提示卡避让实际操作区，空间不足收起。只读消费现有业务状态，无 GPU/CPU/Worker/shader、生成请求、持久化/导出及 Project Schema 改动。浏览器本地进度使用 v3，保留 v1/v2 以便回滚。验证和范围见 [新手引导简化](changes/CHG-20260916-TEXTURE-ONBOARDING.md)。本轮未推送或部署。

2026-09-16 账号菜单 → M13（纯 UI）：`USER-MENU-PRODUCT-LABEL` v1 在“退出登录”下方以分隔线和次要文字显示固定“版本 0.1”。这是上线前产品展示文案，不读取或覆盖前后端 release manifest、Git SHA、构建时间、package 版本及部署配置；正式上线时再调整文案。无算法、Schema、数据迁移或网络请求增加，移除此静态行即可回滚。尚未推送或部署。

2026-09-16 UI-10 → M08：`PAINT-MASK-BRUSH-DEFAULT` v1.0.1 将视口蒙版加选/减选画笔初始大小从 45 调整为 35；应用重绘画笔仍为 30，普通绘制/橡皮、羽化和用户手动调节不变。只修改初始设置，GPU/CPU/Worker/shader 像素核、分辨率、保存及导出协议不变，无 Schema/数据迁移；回滚默认常量到 45 即可。详见 [画笔默认值记录](changes/CHG-20260912-LOCAL-REPAINT-BRUSH-DEFAULT.md)。本轮尚未推送或部署。

2026-09-16 UI-10/UI-11 → M08（协作 M03）：`ALG-LR-MANUAL-TARGET` v1.1.1 修复黄色“新建图层”按钮将用户层误标为内部 draft、导致图层列表隐藏的问题。显式创建普通 UV 层，与面板新建使用同一 store 动作；旧版无生成/捕获/相机/投影配对的独立 draft 只读显示，不改 ID、像素、顺序或数据库。真正生成绑定/配对的内部 draft 继续隐藏。GPU/CPU/Worker/shader、绘制核、保存/export 协议不变。生产创建回调与真实图层面板点击/重载验证通过；详见 [手动局部重绘目标层变更卡](changes/CHG-20260916-MANUAL-REPAINT-LAYER.md)。

2026-09-16 UI-06/UI-10 → M08：`ALG-LR-MANUAL-TARGET` v1.1.0 将新建绘制层模态框改为现有顶部黄色 warning 提示，显式“新建图层”按钮沿用历史边界、创建/选中/开始绘制流程。关闭不创建，不遮挡编辑器；内容识别填补层（含旧 ID/generation 标记）禁止作为手动绘制目标，并在写回时保护。GPU/CPU 像素核、Worker/shader、分辨率、保存/导出协议不变，无迁移。回滚提示组件及目标保护即可恢复上版交互；详见 [手动局部重绘目标层变更卡](changes/CHG-20260916-MANUAL-REPAINT-LAYER.md)。本轮尚未推送或部署。

2026-09-16 UI-05/UI-06/UI-10 → M08（协作 M03/M12）：`ALG-LR-MANUAL-TARGET` v1.0.0 将视口局部重绘改为显式选择 UV 目标层。打开面板、生成完成和后台准备不再创建/合并重绘层；应用画笔没有可见同对象 UV 目标时，提示用户新建或选择。新生成仅更换来源，GPU 从目标现有 RGBA 初始化并继续写回原 ID；切层先结束旧笔画，等读回完成再绑定新目标，迟到初始化/提交不得复活删除层。保留名称/角色/顺序/透明度/混合设置及旧项目图层。GPU 像素核、CPU tile/history、Worker、shader、蒙版/法线、投影显示与导出协议不变；新增仅运行时 destinationMode，无 Schema 或数据迁移。详见 [手动局部重绘目标层变更卡](changes/CHG-20260916-MANUAL-REPAINT-LAYER.md)。

2026-09-16 UI-06 → M03（协作 M08）：`ALG-VIEW-INPUT-001` v1.4.0 将平移改为直接中键拖动，兼容原 Alt＋中键；Alt＋左键旋转、Alt＋右键拖动缩放、滚轮及普通绘制/擦除不变。相机、R3F 拾取、画笔悬停/按下、变换工具同时避让中键，保持指针归属和结束清理。透视/正交平移、原导航与拾取回归、类型检查通过。只改输入路由，GPU/CPU/Worker/shader、蒙版/UV/export、保存和 Schema 不变，无数据迁移；回滚四处输入判断及对应测试即可恢复 Alt 必需。此次本地修改，尚未推送或部署。

2026-09-16 M07（协作 M06/M08/M09）：`UV-GUTTER-TOPOLOGY/3` / UV composition 11 修正抗锯齿面积阈值与 GPU UV 像素中心不一致造成的切层白点。CPU/Worker 校准共用像素中心光栅，仅补岛外留边，保持未涂抹内部、原生 RGBA、相机、完整分辨率与 QA；派生缓存键升级，无工程/资产迁移，Command/CAS/ownership/verified assets 不变。真实车辆 A/B、WebGL 三角形与合成回归通过。详见 [白点与留边拓扑](changes/CHG-20260916-UV-GUTTER-PIXEL-CENTER.md)。

2026-09-16 UI-06/M08（协作 M03）：`PROJECTED-SELECTION-DISPLAY/1.0.0` 接入正式 ViewportCanvas，冻结屏幕投影显示不读取模型 UV，保留作者蒙版与原空闲归档时机。数组纹理有界缓存、同视角合批、会话撤销/重做与清空/反选接入；旧 UV-only 状态、消耗选区或超预算时回退原 UV 显示。真实约 200 万三角形车辆涂画/旋转约 60FPS，UV 置零显示字节一致、作者蒙版撤销摘要一致。GPU/CPU 显示历史变更、Worker/远端/持久化/export 不变，无 Schema 迁移；预算、兼容限制与回滚见 [正式投影显示](changes/CHG-20260916-PROJECTED-SELECTION-DISPLAY.md)。下方四槽原型记录仅作历史参考。

2026-09-16 UI-06/M08：`PROJECTED-SELECTION-PREVIEW/0.1.0` 为独立本地显示验证原型，尚未接入正式编辑器。直接读取投影 mask/depth 与相机，不采样模型 UV；按序加/减并反选，深度比较使用接收平面修正至采样中心以减少转动噪点。最多四个快照，超限明确报错；不宣称无限笔画、完整历史/重载及性能已完成。真实模型离屏更换 UV 坐标显示字节一致、显示/旋转不改变 UV 数据、擦除撤销恢复通过。GPU/CPU/Worker/捕获/保存/远端/UV/export 生产链路完全未接入此原型，无 Schema/数据迁移。仅本地效果评审，未推送或部署；详见 [投影显示原型](changes/CHG-20260916-PROJECTED-SELECTION-PREVIEW.md)。
2026-09-16 M07（协作 M08/M09）：`UV-DISPLAY-BUFFER` v1.5.2 修复合并 UV 上连续原生局部重绘的下层组合缓存身份。最新重绘仍使用独立顶层采样，较早的可见重绘按面板顺序进入下层 UV 组合；缓存键现在覆盖该精确下层栈，避免误复用“仅合并 UV”纹理。两次重绘可同时显示，逐层眼睛关闭/恢复保持原有覆盖语义。GPU/CPU/Worker/shader 混合公式、完整分辨率、合并/保存/导出、Command/CAS/ownership/verified assets 与 Layer Schema 不变，无迁移；详见 [合并 UV 后多次局部重绘显示修复](changes/CHG-20260916-NATIVE-UV-REPAINT-STACK.md)。

2026-09-16 M08（协作 M12/UI-05）：`LOCAL-REPAINT-ASSET-READ/1.0.0` 使局部重绘蒙版在图片标签直读失败后，仅对可持久工程资产改走已登录的资源读取通道，完成解码后释放临时 Blob URL；无效内容仍阻断 GPU 准备。后台预热失败保留状态并在主动打开工具时重试，不再弹红色错误；仅用户主动按钮 3 准备且全部读取路径失败时保留去重提示。原字节、完整分辨率、LRU/解码屏障、GPU/CPU/Worker/shader、UV/投影/导出、Command/CAS/ownership/verified assets 不变，无迁移；详见 [局部重绘蒙版可靠读取](changes/CHG-20260916-LOCAL-REPAINT-ASSET-READ.md)。

2026-09-16 M04（协作 M03/M06/M08）：`GPT-RETURN-SILHOUETTE-QA/1.1.0` 对普通 texture-map 返图使用“粗粒度位置校验＋冻结采集蒙版精确裁切”；允许生图服务的轻微 alpha 羽化，仍拒绝空轮廓、明显缩放或偏移。局部重绘保留原严格边界校验；返图尺寸/比例、冻结相机、完整分辨率、GPU/CPU/Worker/shader、UV 权重/投影、持久化/导出及 Command/CAS/ownership/verified assets 不变，无迁移；详见 [返图轮廓与采集蒙版协作校验](changes/CHG-20260916-GPT-RETURN-SILHOUETTE-QA.md)。

2026-09-16 UI-06/UI-10 → M08（协作 M03）：`INPAINT-SELECTION-DISPLAY/1.0.0` 仅对红条纹反馈用 smoothstep(0.01,0.08,coverage) 稳定 UV 岛边缘的弱覆盖，三种实时/累计预览共用；保留原 discard、前后面、深度、擦除和反选语义。不新增纹理、采样、读回或全图补边；作者蒙版、GPU 累积、CPU/Worker、Capture/GPT 输入、保存、UV/export、分辨率与 QA 保持，无 Schema 或资产迁移。约 200 万三角形模型四视角隔离测试弱显示像素减少约 94–97%，捕获字节不变；不承诺修补零覆盖裂缝。验证、边缘语义与回滚见 [选区显示强度](changes/CHG-20260916-INPAINT-SELECTION-DISPLAY.md)。

2026-09-16 M03（协作 M04）：`NORMAL-CAPTURE-MATERIAL/1.0.0` / `ALG-CAP-005` v1.0.1 按离屏 renderer 与 normal space 弱持有至多三份不可变法线材质，消除多视角重复编译；renderer 释放仍回收 GPU 程序。真实 49,152 三角形、三个空间各十视角对照完整 RGBA 一致，程序创建 30→3，总耗时约 702–742→568–569ms。相机、法线公式、完整分辨率、其他 pass、UV 权重/QA、持久化/导出及 Command/CAS/ownership/verified assets 不变，无迁移；详见 [法线采集材质复用](changes/CHG-20260916-NORMAL-CAPTURE-MATERIAL-REUSE.md)。

2026-09-16 M07（协作 M03/M08/M09/M12/M13）：`MASKED-PROJECTED-PNG/1.0.0` 将逐层投影蒙版输出的私有 RGBA 转交 Worker PNG 编码，串行一个全尺寸 Canvas，失败释放并保持原 pixel/兼容消息。4K 两种 alpha 策略完整 decoded RGBA 一致，旧四次 51–60ms 长任务、新四次无 >50ms 长任务；总编码/处理仍约 1.6–1.9s，不宣称用户全流程零掉帧。原缓存借用像素不转移，GPU/CPU/Worker/shader、UV 权重、QA、相机/framing、分辨率、Command/CAS/ownership/verified assets 与保存/导出保持，无持久迁移；详见 [蒙版 PNG Worker 变更卡](changes/CHG-20260916-MASKED-PROJECTED-PNG-WORKER.md)。

2026-09-16 M12（协作 M04/M08/M14）：`GENERATION-ASSET-REFERENCE/1.0.1` / `GENERATION-IMAGE-SOURCE/1.0.0` 对不可变 data:image/ 原字节准备设置 64MiB/32 项完整 URL 缓存，减少历史 Base64 读取/摘要重复；不缓存权限或跨工程资产。`GPT-GROUP-STATUS-CHECKPOINT/1.0.0` 仅重叠已提交分组的状态保存与返图观察，付费前相机 checkpoint、组末保存与下一组呈现仍 await；不重提生成。原像素、GPU/CPU/Worker/shader、UV 权重/QA、Command/CAS/ownership/verified assets 与导出保持，无迁移；详见 [生成保存延迟变更卡](changes/CHG-20260916-GENERATION-SAVE-LATENCY.md)。

2026-09-16 UI-05/M04：`GEN-PREVIEW-STATUS/1.0.0` 统一预览文字优先级为生成中、准备中、取消/失败、空闲，防止局部重绘空提示与取消/错误文案重叠；重试准备期间隐藏旧终态提示。只改渲染条件，已保存结果、任务取消/提交、GPU/CPU/Worker/shader、投影/UV/export、保存和分辨率不变，无 Schema 或数据迁移。真实 JSX 状态组合与回滚见 [预览文案互斥](changes/CHG-20260916-PREVIEW-STATUS.md)。

2026-09-16 M03（协作 M04/M08/M06/M07）：`GPT-CONTENT-BOUNDS/1.0.0` 以逐行两侧精确边界减少取景/返图扫描，合作入口按 4ms 让出并保留空行取消；加载等待异步 decode，拒绝提示保留可绘制兼容。4K 扫描约 71–80→5–8ms，配对裁切和 native 还原字节一致；不放宽远端比例/透明轮廓错误，不改 framing v1/v2、相机、法线/mask/depth、UV 权重或完整分辨率。GPU/CPU/Worker/shader、QA、持久化/导出及 Command/CAS/ownership/资产保持，无迁移；详见 [返图扫描延迟变更卡](changes/CHG-20260916-FRAMING-BOUNDS-LATENCY.md)。

2026-09-16 M06（协作 M08/M07/M09）：`ALG-PROJ-007` v2.1.14 修复原生局部重绘从 GPU owner 切到 Canvas/PNG/多层合成后的透明边缘黑缝。UV 颜色统一在线性预乘 alpha 空间插值，普通 UV 下层 source-over 只计算一次 alpha；保留作者 RGBA、绘制/擦除/历史、投影权重、完整分辨率、QA、持久化和导出协议。真实 WebGL 硬边/羽化转换及六种材质数值回归通过，无资产迁移；原工程新构建验收待完成。详见 [重绘黑缝变更卡](changes/CHG-20260916-UV-REPAINT-ALPHA-EDGE.md)。

2026-09-16 M07（协作 M06/M03/M08/M09）：`UV-RASTER-LAYER-KEY/1.0.0` 以 owner 私有完整字符串身份减少 Base64 URL 重复序列化；64MiB/2048 条上限，溢出不淘汰而回退原字符串，dispose 释放。全部像素输入、逐层 UV/权重、GPU/CPU/Worker/shader、取消/几何/来源验证、QA、完整分辨率及持久化/导出保持。2K 七层旧/新核 20 次显隐最终字节和覆盖计数一致，无迁移；仍有 GPU 合成/回读耗时，不宣称全流程实时。详见 [返图 UV 缓存键优化](changes/CHG-20260916-UV-RASTER-LAYER-KEY.md)。

2026-09-16 M04（协作 M03/M08/M12/M14）：`GPT-COLOR-REFERENCE-UPLOAD/1.1.0` 为 GPT texture-map 的第一张有 framing 的 Current model view 结合图复用已授权原尺寸 RGB 自适应压缩。只改上传副本，原尺寸/alpha、完整 JSON <4MB、个人账号隔离及无损法线/蒙版保持；材质与六视图两阶段入口不启用。真实 4096×3072 超限样本压缩到预算内，未付费生图；GPU/CPU/Worker/shader、投影/UV 合成权重、QA、原资产、持久化/导出、Command/CAS/ownership 不变，无迁移。详见 [多视图上传变更卡](changes/CHG-20260916-GPT-TEXTURE-COLOR-UPLOAD.md)。

2026-09-16 M15：`SHADER-CHUNK-PACK/1.0.0` 对固定 Three.js 注册 shader 做构建期无损打包，运行时仅初始化一次；141 段字符串、ShaderLib 和导出保持，纯几何 Worker 删除整个解码池。修复 master 4334910b 的 CI 总 JS 超限，不提高预算、不禁用 QA、不改 GLSL 或 UV/投影/重绘像素算法。持久化、导出、Command/CAS/ownership 与资产不变，无迁移；验证和回滚见 [shader 打包变更卡](changes/CHG-20260916-CI-SHADER-CHUNK-PACK.md)。

2026-09-15 M07（协作 M06/M09）：显隐优化 rebase 集成到 `c1f412c`，保留上游逐层贡献、直接 RGBA 上传、可取消交互等待、底图 SHA-256 校验及 GPU 缓冲复用；底图内容 revision 只补充校验键，不替代读取权限与字节验证。留边保留上游跨度缓存、分块队列和线性寻址，合入分段计时并从 Worker 回传；不恢复旧 seed 列表或替换为另一套位图缓存。回读与覆盖归约重叠时保留弱透明清理索引，countMs 为独立并行时段，不能与 readAndCorrectMs/conversionMs 相加当总耗时。直接颜色上传含在 displayUploadPrepareMs，细节仍见 residentUvUploadStages；遮罩/普通条带继续细分并共用可取消呈现屏障。前述独立分支基准保留为历史数据，不代表合并后的性能。像素公式、分辨率、QA、显式导出与持久化保持，无 Schema/资产迁移；回滚本次 rebase 提交可恢复上游实现。

集成验证：类型、Lint、显隐/底图/拓扑/留边/回读/取消/导出回归通过；隔离 2K 浏览器显隐最终像素与岛边对照零差异。生产构建成功，但总 JS 3,264,191 字节超过现有 3,256,500 上限 7,691 字节，256 字节发布余量检查也未通过；本次解决冲突不提高预算、不推送或部署，发布前仍须处理包体。

2026-09-15 M15（协作 M14）：`WORKSPACE-API-DEDUP/1.0.0` 合并相同 Blob 上传 URL、XHR 进度及 FileReader 编码实现，保持传输、超时、错误、原字节、三并发和保存门禁。`RELEASE-PREPUSH/1.1.0` 使用带 UTC 偏移的时间元数据，并在原 CI 命令后要求至少 256 字节包体余量；原 CI 硬上限 3,256,500 字节不变。无图像算法、GPU/CPU/Worker/shader、Schema、Command/CAS/ownership 或资产变更，无迁移。验证与回滚见 [CI 包体余量修复](changes/CHG-20260915-CI-BUNDLE-HEADROOM.md)。

2026-09-15 M12（协作 M04/M08）：`GENERATION-SERVER-PERSISTENCE/1.0.0` 修复生成面板只识别 local-server、跳过 cloud-server 原始选区上传和关键保存的问题。统一识别两种服务端项目，覆盖生成图片、四平面 Capture、参考图、关键状态保存和投影结果保存；关键保存保留服务器返回的 workspaceMode，不把云端项目改写成 local-server。作者 mask、冻结相机、normal/depth、保存成功后才付费提交、取消和 Command/CAS/ownership 门禁保持；GPU/CPU/Worker/shader、投影/UV/export 像素与分辨率不变。兼容已有云端枚举，无数据库/资产迁移；验证与回滚见 [云端重绘保存修复](changes/CHG-20260915-GENERATION-CLOUD-PERSISTENCE.md)。

2026-09-15 M14/M12（协作 M04/M08）：`PROJECT-ASSET-LOOKUP/1.0.0` 使资源上传目录校验只查询 slug，保留 user/project/deleted_at 条件，不读取 document_json。`WORKSPACE-ASSET-UPLOAD-QUEUE/1.0.0` 在浏览器共用资源入口限制最多 3 个活动上传，生成与自动保存、不同项目共用 FIFO；保留 Blob/JSON/直传/代理和原错误、重试规则。图片字节、GPU/CPU/Worker/shader、法线/蒙版、投影/UV/export、Command/CAS/ownership 均不变，不调数据库内存、不迁移历史资产。验证及回滚见 [上传数据库峰值修复](changes/CHG-20260915-ASSET-UPLOAD-DB-PRESSURE.md)。

2026-09-15 M04（协作 M08/M12/M14）：`REPAINT-COLOR-REFERENCE-UPLOAD/1.0.0` 按维护者授权为 GPT 局部重绘结合参考图加入原尺寸 RGB 自适应 WebP 压缩；只在无损预算耗尽后启用。法线/蒙版仍走原像素路径，尺寸和 alpha 逐字节验证，完整上传 JSON 严格小于 4MB，缓存策略隔离。原 Capture、回贴/UV/QA、输出分辨率、Command/CAS/ownership、持久化与导出不变，无 Schema 迁移；不可压缩 alpha 明确阻断。构建与新旧上传、GPT 裁切/参数/上传重试回归通过，未付费生图。部署和回滚详见 [变更卡](changes/CHG-20260915-REPAINT-COLOR-UPLOAD-BUDGET.md)。

2026-09-15 UI-10 → M08（协作 M03/M06/M07/M12）：`ALG-LR-UV-PAINT` v1.1.5 修复生产构建压缩 GLSL 空白后原生局部重绘源图顶点入口未插入的问题；空白兼容入口匹配保留今日优化及原分辨率、权重/alpha/可见性/深度/历史、Worker、持久化和导出协议。真实生产组装回归旧失败/新通过，无 Schema 或资产迁移，缺失笔画需重画。4517 人工验收及正式推送结果以 [变更卡](changes/CHG-20260915-REPAINT-SHADER-ASSEMBLY.md) 为准。

2026-09-15 UI-06/UI-10 → M08：`LOCAL-REPAINT-BASELINE/1.0.0` 排查分支已撤回，恢复用户确认正常的6dcdec1e相机对齐笔刷并保留今日5895ce96的Alt/性能改动。组合涂抹故障根因修复为 `ALG-LR-UV-PAINT` v1.1.5 的生产着色器入口匹配，详见 [组装修复](changes/CHG-20260915-REPAINT-SHADER-ASSEMBLY.md)。旧夹具仅留作历史对照，不改资产、分辨率、QA、持久化或导出协议，无迁移。

2026-09-15 UI-06 → M03（协作 M08）：`ALG-VIEW-INPUT-001` v1.3.0 将视角导航改为 Alt＋左键旋转、Alt＋中键平移、Alt＋右键拖动缩放，保留滚轮缩放。导航在按下时锁定归属，松开 Alt 不切换成绘制；释放/取消/失去捕获后正常结束。Alt 按下时在表面绘制拾取前退出，R3F 跳过导航拾取及点击尾事件，变换工具原生输入同步避让；抬键后悬停与下一次选择恢复。普通绘制/擦除、完整分辨率及 GPU/CPU/Worker/shader/UV/export 像素、持久化协议保持，无 Schema 或数据迁移。类型、lint、真实 R3F/相机事件与 Edge DPR2 绘制回归通过；尚未推送或部署。回滚与验证详见 [Alt 视角导航变更卡](changes/CHG-20260915-ALT-VIEWPORT-NAVIGATION.md)。

2026-09-15 UI-10 → M08：`LOCAL-REPAINT-BRUSH-DEFAULT` v1.0.1 将局部重绘视口和独立画布画笔默认大小从 15 改为 30；新初始化生效，用户手动调节与羽化保持原逻辑。GPU/CPU/Worker/Shader、半径换算、历史、导出与持久化不变，无 Schema 或数据迁移，回滚两处默认常量为 15。详见 [默认画笔大小变更卡](changes/CHG-20260912-LOCAL-REPAINT-BRUSH-DEFAULT.md)。

2026-09-15 M03/M04（协作 M08/M12/UI-05）：`GPT-CONTENT-FRAMING` v1.0.0 对新 GPT 单视图、多视图贴图及 GPT 局部重绘按完整模型轮廓裁切，每侧留最长边 3%（至少 2px），极端长宽只补空白到服务允许的 3:1；结合图/几何法线共用整数裁切框，材质参考不裁切。服务端通过 `aspect_ratio_w/h` 传递精确约分比例（如 57:49），不再让 1:1 预设控制这些任务。新增可选 framing v1 保存原画布和裁切坐标，提交/轮询/历史恢复返回；回图在保留输出细节的透明画布上还原原捕获坐标，显著比例不符或超出内存安全范围明确阻断，未重新提交付费任务。轮廓捕获明确忽略视口背景。原相机/作者蒙版/depth、投影/UV/GPU/CPU/Worker/shader/导出采样公式、Command/CAS/ownership 均不变；旧任务无 framing 保持原路径，无批量迁移。六视图参考两阶段生成、原 ModelView 重绘不变。前后端需成套回滚，保留已还原资产；本次仅本地修改/验证，未付费生图或推送部署。详见 [自适应裁切变更卡](changes/CHG-20260915-GPT-CONTENT-FRAMING.md)。
2026-09-15 回退基线定向恢复：以 6dcdec1+c2edfae 为基础，M03（协作 M04/M08）ALG-CAP-007 v1.2.0 仅对 GPT 取景使用 98% 长边占比与固定 1:1，结合图/法线/作者 mask/depth 共用冻结相机；保留触边检查和保守回退。GPT-ALPHA-PREVIEW-CROP v1.0.0 仅裁透明结果预览、外扩 8px，原图/下载/回贴坐标不变。LOCAL-REPAINT-BRUSH-DEFAULT v1.1.0 默认 30，不包含 Alt 导航。保存、数据库、投影/UV/export、分辨率策略与资产不变，无迁移。详见 [定向恢复变更卡](changes/CHG-20260915-BASELINE-SQUARE-PREVIEW.md)。

2026-09-15 UI-05 → M08（协作 M03/M04/M12）：`GPT-REPAINT-NORMAL` v1.0.0 将新 GPT 局部重绘默认输入改为结合图＋同视角几何法线图，独立通用修复提示词不再复用单视图材质参考模板。“使用材质参考图”小开关默认关闭，开启仅追加显式选中的第三图，不从历史或配对图自动替代。法线用冻结相机与结合图同尺寸捕获，排除其他物体/网格/背景及材质 normal/bump，正式引导不走 1K 世界法线预览；前两张图禁止自动有损压缩或缩图，超过原上传预算明确失败。正常 PNG/Worker 编码、作者 mask、depth、透明回图、投影/UV/GPU/CPU/shader/导出公式保持；法线随 Capture 持久化，付费提交前保存与取消门禁保留。Project 设置仅新增可选 `gptRepaintUseMaterialReference`，缺失按 false；历史任务不改写，无批量迁移。回滚恢复旧 GPT 输入构建器/模板/面板，忽略新设置并保留资产。未运行付费生图或部署；详见 [GPT 法线修复变更卡](changes/CHG-20260915-GPT-REPAINT-NORMAL.md)。

2026-09-15 M07：`UV-RESIDENT-RESOLVE` v1.0.0（关联 ALG-UV-003/008，调度实现修订）让覆盖数量归约与最终 RGBA 回读/校正/Worker 转换重叠，任一失败均排空在途读回后再释放；校正标记扫描由每 1MiB 固定让出改为约 4ms 预算让出。2K 七层隔离热轮中位 42.9→38.0ms，RGBA/coverage/覆盖数量一致；不是用户模型完整显隐收益。完整分辨率、8MiB 双 PBO 上限、CPU 精确校正、GPU/Worker/shader 公式、QA、持久化/导出与 Schema 不变，无迁移。详见 [Resident 回读调度优化](changes/CHG-20260915-UV-RESOLVE-OVERLAP.md)。

2026-09-15 M07，协作 M06：`UV-DISPLAY-BUFFER` v1.5.1 合并普通 Resident UV 颜色/遮罩上传的末尾绘制屏障：原来每张各等两次，现在两张提交完共等两次，再原子发布；交互式橡皮路径、分块预算、240ms 交互避让及取消检查保留。`displayUploadMs` 拆分准备、分配、分块等待、CPU 上传调用、交互等待、分块让出、末尾绘制等待及其他开销。GPU/CPU/Worker/shader 像素、完整分辨率、QA、持久化/导出、缓存身份与 Schema 不变，无迁移。取消/资源回收回归、2K 浏览器及包体门禁通过；详见 [上传计时与共同等待](changes/CHG-20260915-UV-UPLOAD-BARRIER.md)。

2026-09-15 M07，协作 M06/M09：`ALG-UV-005` v2.0.8（实现 Patch）让超 32 MiB 的拓扑源直接与已保留的 Float32 三角形逐位核对，跳过额外压缩快照与热轮解压；未标记 needsUpdate 的有效 UV/index 修改仍失效。小源原始快照、大模型接缝压缩缓存及其预算保留。用户模型经导入/BVH 重排后的独立准备基准：冷轮 2729.1→184.6ms，三轮热轮中位 1061.5→87.9ms，24 MB 三角形输入逐字节一致；不是整次显隐耗时。完整分辨率、GPU/CPU/Worker/shader 像素、QA、持久化/导出与 Schema 不变，无数据迁移。专项与 2K 浏览器显隐回归通过；详见 [拓扑准备复用](changes/CHG-20260915-UV-TOPOLOGY-REUSE.md)。

2026-09-15 M07：`UV-GUTTER-TIMING` v1.0.0 为现有 Resident UV 留边阶段新增互斥计时：等待已启动的拓扑准备、边缘查找、颜色扩展、主动调度等待；兼容拓扑生成与其他编排开销单列，六项合计等于原 gutterMs。共享内核仍沿原顺序执行，计算阶段扣除主动调度等待；完整分辨率、像素、QA、接缝策略、Worker/shader、持久化/导出、Schema 与缓存版本不变，无迁移。计时、像素、取消回归与浏览器输出验证通过；详见 [留边分段计时](changes/CHG-20260915-UV-GUTTER-TIMING.md)。

2026-09-15 M07，协作 M06/M09：用户确认屏蔽接缝后视觉无差异，`UV-DISPLAY-BUFFER` v1.5.0 默认跳过常驻预览的 `ALG-UV-005` 接缝修复步骤，所有地址无需诊断参数。保留 Top-K、留边、完整分辨率与 QA；派生缓存 purpose 升为 `resident-uv-display-3-no-seams`，避免混用旧像素，恢复新结果的持久缓存。显式合并/导出及共享 CPU/GPU/Worker/shader 内核保留；本地 `skipUvSeams=0` 可恢复接缝对照。无工程/资产/Schema 迁移；回滚默认值及 purpose 即可。详见 [默认跳过记录](changes/CHG-20260915-UV-SEAM-BYPASS.md)。

2026-09-15 M07，协作 M06/M09：`ALG-UV-005` 本地诊断修订 `seam-bypass/1`。本地地址带 `skipUvSeams=1` 时，Resident UV 临时跳过接缝修复，以对比显隐耗时和画面；保留完整分辨率、留边与 QA。开关固定于显示实例，试验不读写持久派生缓存；正式地址、显式 UV 合并/导出与 CPU/GPU/Worker/shader 算法默认行为不变。无 Schema/资产迁移；移除参数并刷新恢复。详见 [接缝屏蔽对照记录](changes/CHG-20260915-UV-SEAM-BYPASS.md)。

2026-09-15 M07，协作 M06/M09：`ALG-UV-005` v2.0.7 为大模型几何增加无损分块快照；快照与修补地址共享原 64 MiB 地址预算，整体缓存上限不增加。热轮还原全部字节精确比较，直接修改位置/法线/UV/索引仍失效。修补顺序、像素、完整分辨率、QA、shader、持久化/导出及 Schema/Command/CAS/ownership 不变。缺失覆盖修补共用一份快照，取消重复压缩与中间接缝对象缓存登记。BVH 重排模型热轮通过完整像素对照，首次压缩有额外成本；无数据迁移。详见 [大模型接缝缓存变更卡](changes/CHG-20260915-LARGE-UV-SEAM-CACHE.md)。

2026-09-15 M07，协作 M06/M09：`ALG-UV-006` v2.1.1 / `ALG-UV-005` v2.0.6 实现底图复用与留边缓存优化。Resident UV 明确传入底图内容身份；Worker 按层 ID/内容 revision、URL、宽高只保留一份最多 64 MiB 解码 RGBA，release/取消/失败及 source-over 所有权均有门禁。不可变拓扑改用最多 2 MiB 单图资格位图，热路径跳过全空 coverage 和内部区域，保持原顺序传播及全部 Alpha 字节。4K 隔离中位耗时：留边热轮 105.5→28.4ms，浏览器底图 GPU 487.1→373.6ms；冷留边 102.6→112.3ms，GPU 有单轮波动，均不代表用户工程端到端延迟。像素对照、类型、lint、浏览器合成与显隐、生产打包通过；完整分辨率、QA、shader、持久化/导出、Schema/Command/CAS/ownership/verified assets 不变，无数据迁移，未提交或部署。详见 [底图复用与留边变更卡](changes/CHG-20260915-UNDERLAY-GUTTER-REUSE.md)。

2026-09-15 UI-06/UI-10 → M08（协作 M06/M07）：`VIEW-ALIGNED-BRUSH` v1.0.0 将笔刷圆环和屏幕笔迹由表面法线对齐改为当前相机对齐，斜面和硬边保持正圆；普通 UV 与旧回贴范围沿观察方向换算到命中面。GPU 可见性、羽化、深度、Worker、完整分辨率、QA、持久化和导出协议不变；只影响后续笔迹，无 Schema 或资产迁移。32 组真实函数及 Edge 斜面圆环、4K 曲面/遮挡、回贴擦除/撤销/PNG/FBX/重新打开检查通过。回滚恢复原切线范围；本次发布合并 master 的 UV-only 显示与上传优化，实际发布结果以部署记录为准。详见 [视角对齐笔刷变更卡](changes/CHG-20260915-VIEW-ALIGNED-BRUSH.md)。

2026-09-14 UI-05/M04：六视图参考生成按钮将第一步/第二步的服务端阶段标签统一显示为“生成多视图中”，隐藏 Sunburst、质量与去光照实现信息，保留进度百分比和取消能力。只修改按钮文案映射；提示词、两阶段流程、模型参数、错误提示和持久化不变，无算法或 Schema 修订，无数据迁移。回滚 compactTextureProgressButtonLabel 的阶段映射即可。

2026-09-14 UI-05 → M04（协作 M08）：`ALG-GEN-001/002` 提示词修订 v1.3.0。GPT 单视图、多视图贴图与 GPT 局部重绘共用用户确认的弱光影模板，仅待补全区域抑制强明暗、高光和反射，保留真实纹理及非常轻微的接触明暗，已贴纹理/几何/背景/透明区不变；补充要求仍追加。服务端识别新旧模板，不为新版附加整图光影约束。六视图参考生成/第二步去光、原 ModelView 重绘、模型参数、GPU/CPU/Worker/shader、UV/export 与持久化协议不变；只影响新构造请求，无 Schema 或数据迁移。回滚恢复模板与识别分支，保留历史。未运行付费生图，不承诺模型必然达到目标效果；详见 [弱光影提示词变更卡](changes/CHG-20260914-GPT-TEXTURE-WEAK-LIGHT-PROMPT.md)。

2026-09-15 M07，协作 UI-06/M06/M08/M09/M11/M13：`UV-DISPLAY-BUFFER` v1.4.1 / `PERF-UV-SOURCE-PREPARE-001` v1.12.1。显隐旧请求取消后直接接续最新状态；源与最终纹理的相机静默等待也检查取消，保留交互保护。首次磁盘恢复仍校验实际字节，几何/来源验证时点保留；可选压缩缓存写入延后到实际 UV 绑定之后。S2 新增顶层/中层冷、热状态的绑定探针，不再把保护窗口 FPS 当作显隐延迟。完整分辨率、Top-K、QA、接缝/gutter、CPU/Worker/shader 像素、生成屏障、Command/CAS/ownership、资产/持久化/导出不变，无迁移，回滚不恢复投影视口材质。详见 [显隐响应变更卡](changes/CHG-20260915-UV-VISIBILITY-RESPONSE.md)。

2026-09-15 M07（协作 M06/M09/M11）：`UV-LAYER-CONTRIBUTION/1.0.0` 本地实现逐层精确 UV 瓦片与无损会话溢出。显隐复用 UV，预算淘汰先保存贡献；颜色/质量/覆盖与原 Top-3 不变。真实 4K/14 层测试投影绘制保持 14 次，但新组合仍约 600ms（最终直传优化前），未宣称实时、未推送。GPU/CPU/Worker/shader、生成屏障、持久化/导出审计、包体与剩余限制见 [逐层 UV 贡献变更卡](changes/CHG-20260915-UV-CONTRIBUTION-COMPOSITION.md)。

2026-09-15 M07（协作 M06/M09/M11）：`UV-LAYER-CONTRIBUTION/1.0.1` / `UV-ALPHA-CLOSURE/1` 持续优化显隐尾段。普通 RGBA 采用 1 MiB 精确条带、4ms 时间预算；Worker 独占输入原地翻行，提供最多 64KiB 的精确弱透明像素索引；保留原始输出和普通完整清理后备。原候选修正公式不变，整数四元组经完整键比较后复用精确结果，表上限 5MiB；gutter 仅改为线性邻居寻址/整像素复制，不改首来源顺序。全覆盖 donor 计划复用在真实工程不命中，试验已撤下。不是实时交付声明；125 项回归通过，实际首次组合仍需继续优化，尚未推送。GPU/CPU/Worker/shader、生成输入屏障、持久化/导出与回滚说明见逐层 UV 贡献变更卡。

2026-09-15 M07：`UV-LAYER-CONTRIBUTION/1.0.2` 把正常质量合成的 gutter 送往同部署内置 Worker，执行同一个 `dilation.ts` 内核；独占 RGBA/coverage 转移后以新 owner 返回，取消后不得发布，拓扑只缓存一份且最多 64MiB，更大拓扑保留原协作内核，不降分辨率。邻居队列改为两份复用的分块 Uint32 队列，来源/覆盖写入顺序不变。实测发布 P95 改善但新组合仍约 0.4 秒、最大帧仍偏高，不是实时验收通过；未推送。

2026-09-15 M07：`UV-GUTTER-ORDERED-GPU/1.0.0` 增加独立验证候选，不接入生产显示。双 uint 保存原始来源与有序邻居路径，保持 CPU 广度优先首来源语义、1..8 像素宽度和三种 alpha 模式，输出 GPU RGBA8/R8、不回读。初版 61 组真实 WebGL 对照零差异；复用实例版本与生产集成仍待验收。4K rank scratch 为 256MiB，输出 80MiB，不能隐瞒显存增量。现有像素/生成/导出/持久化路线保持；回滚删除未接入候选即可，无数据迁移。详见逐层 UV 贡献变更卡。

2026-09-15 M07/M09：`UV-UNDERLAY-DECODE/1.0.0` 去除显隐混合中相同 UV 底图的重复解码。每次仍读取当前资源并验证 SHA-256/尺寸/MIME；至多缓存一张 64MiB 只读 RGBA，source-over 分支取得独立副本。权限失败不返回旧缓存、取消不发布、release 期间旧请求不得重新填充缓存。GPU/CPU/Worker 混合公式与顺序、投影次数、分辨率、QA、生成屏障、持久化/导出不变；无数据迁移，回滚移除该派生缓存即可。实测与限制见逐层 UV 贡献变更卡。

2026-09-15 M04/UI-05，协作 M03/M07：`GEN-CANCEL-CLASSIFICATION/1` 不再把所有 AbortError 或包含“已取消”的内部错误当成用户意图；多视图入口检查自己的取消 signal，意外中断保留错误提示和 toast，错误/警告不受精简进度文案过滤。`ALG-CAP-007/1.1.1` 固定方向且不驱动视口动画的批次相机已独立冻结，因此不再因屏幕相机微小变化停止下一组；交互取景/无固定方向仍检查相机变更，主动取消仍有效。分组 2+4+4 / 2+4+4+4、前组 UV 呈现屏障、原分辨率和 GPU/CPU/Worker/shader 像素算法、持久化与导出不变；不重新投影、不自动重提付费请求，不修改历史成功图片。无需数据迁移，回滚恢复取消分类和实时相机比较分支即可。单元覆盖首组成功后中断、前六张成功后第三组中断、固定相机移动和显式取消；实际付费全流程与用户本次根因仍待控制台证据核实。

2026-09-15 M07（协作 M03/M15）：`UV-ARCHIVE-HTTP-ID/1.0.1` 修复内网 HTTP 下 UV 会话缓存构造时直接调用不可用的 crypto.randomUUID 导致编辑器崩溃；改用已有 createId 兼容入口。实际构造函数回归覆盖无 crypto、缺少 randomUUID 和原生 UUID 三种环境，保留会话隔离。GPU/CPU/Worker/shader、完整像素与分辨率、QA、生成、持久化/CAS 和导出均不变，无 Schema 或历史资产迁移；详见 [HTTP 缓存初始化修复](changes/CHG-20260915-UV-ARCHIVE-HTTP-ID.md)。
2026-09-15 M03（协作 M04/M06/M08）：CAPTURE-NORMAL-ISOLATION/1.1.0 在真实模型挂载后复制离屏场景，取消过时预览，复用同模型已完成视角；180ms 合并快速预设切换。原尺寸、拟合 QA 和持久化/导出不变；无数据迁移，回滚及验证见 [离屏采集变更卡](changes/CHG-20260915-CAPTURE-OFFSCREEN.md)。

2026-09-15 M07（协作 M03/M06/M08/M09）：UV-READBACK-SCHEDULING/1.2.0 将独立上下文回读改为四个 2MiB 段，在途仍不超过 8MiB，可见上下文保持原 1MiB 绘制边界。UV-READBACK-SCAN/1.0.1 减少 RGBA 标记与 coverage 的重复读取。原像素/质量/持久化语义保持，无迁移；真实 4K 全字节对照、范围与回滚见 [UV 回读延迟变更卡](changes/CHG-20260915-UV-READBACK-LATENCY.md)。

2026-09-15 M13（协作 M07）：S4-SAMPLE/1.0.1 的 4K 合成基准接受当前对象 1–14 个有效投影层，报告实际数量，空样本继续拒绝；保留 benchmarkOnly、全尺寸编码/预热及质量门禁，不提交图层或保存工程。原生产算法、Schema 与资产不变，无迁移；回滚仅恢复 14 层最低数量限制。

2026-09-15 M03：ALG-VIEW-INPUT-001/1.3.2 在鼠标接触前即让 R3F 悬停遵守 Alt 所有权；保留普通 hover 和已锁定拖动。旧实现拾取回归失败、新实现通过，用户实际首帧延迟需继续录制。无像素/持久化迁移，见 [Alt 悬停变更卡](changes/CHG-20260915-ALT-BRUSH-HOVER.md)。

> 文档版本：`2.21.2`

2026-09-16 UI-16 → M14（协作 M01/M12/M13/M15）：`ASSET-LIFECYCLE-GC` v0.4.0 / `STORAGE-INVENTORY-001/4` 将 Cloud 工程/Revision 引用页默认 8→32，并由单条 PostgreSQL CTE 完成分页、assetId 提取与引用 upsert，Node 不再回传引用数组后二次写库；每 256 条文档约 64→8 次数据库往返，保持 45 秒单查询上限与有界 Node 内存。当前 ready scan 引用索引保留到下一快照原子切换，旧 /3 快照自动重扫。Cloud 隔离区改按真实 quarantine 且排除重新可达对象统计；新增用户级幂等持久 purge job/item，以最多 4 并发签名 DeleteObject 后逐项事务删除 transfer、写 deleted_at，404/Pod 重启可安全重放。新增 `asset_storage_purge_jobs/items`，无 Project/Revision/Asset 内容迁移；Command/CAS/ownership/verified 及 GPU/CPU/Worker/shader、投影/UV/重绘/export、分辨率与 QA 不变。回滚前停 purge 并保留任务表，详见 [Cloud 存储盘点与物理清理变更卡](changes/CHG-20260916-CLOUD-STORAGE-INVENTORY-BOUNDED.md)。

2026-09-16 M14/M15：`ASSET-LIFECYCLE-GC` v0.3.5 修复生产 `node-postgres` 将 JavaScript 数组编码为 PostgreSQL array、导致 `jsonb_to_recordset` 报 `invalid input syntax for type json` 的驱动边界差异。引用与候选批次现在显式序列化为 JSON 文本；分页、分类、快照切换、权限、对象和清理语义不变，无数据迁移。4517/PGlite 与生产驱动参数回归覆盖该边界；回滚 v0.3.4 会恢复 Cloud 扫描失败。

2026-09-16 UI-16 → M14（协作 M01/M12/M13/M15）：`ASSET-LIFECYCLE-GC` v0.3.4 将 Cloud 存储盘点从全量加载全部 Asset Transfer 与 Project/Revision JSON 改为 PostgreSQL 原生引用提取、键集分页和扫描专属暂存表。工程页默认 8 条、资产页默认 256 条；Node 只接收 assetId 投影和单页资产，候选按页批量落库，完成后原子切换快照，失败清理暂存且保留上一份可用快照。查询使用 45 秒 statement timeout，失败状态不会被自动扫描立即覆盖。`LOCAL-SETTINGS-REFRESH` v1.1.0 删除 3 秒固定请求风暴，改为单飞、前台可见刷新和 30 秒至 5 分钟指数退避。新增 `asset_storage_inventory_scan_references` 暂存表，无 Project/Revision/Asset Transfer Schema 语义变化；`STORAGE-INVENTORY-001/3` 分类规则、Command 幂等、Revision CAS、ownership、verified assets、隔离/删除规则、GPU/CPU/Worker/shader、投影/UV/重绘/export 与分辨率不变。5.6 MB 工程文档回归中 Node 响应小于 1 KiB；详细迁移、内存边界与回滚见 [Cloud 存储盘点有界化变更卡](changes/CHG-20260916-CLOUD-STORAGE-INVENTORY-BOUNDED.md)。

2026-09-15 UI-06 → M03：`ALG-VIEW-SELECT-001/1.0.5` 将常驻线框预热绑定到 renderer/模型生命周期，透视/正交相机替换不重新编译或释放同一辅助材质，避免旧编译完成后释放当前材质。16 次相机替换旧实现启动 17 次编译，新实现一次；71 次显隐及卸载清理保持。GPU 线框/CPU 几何/Worker/shader、捕获/UV/重绘/导出、分辨率和 QA、持久化/Schema 均不变，无迁移。其他工具切换仍有长帧，不宣称全操作无卡顿，验证和回滚见 [线框相机生命周期变更卡](changes/CHG-20260915-WIREFRAME-CAMERA-LIFETIME.md)。

2026-09-15 M07（协作 M06/M09）：UV-UNDERLAY-FENCE/1.0.0 删除空闲计算及映射前冗余整队列等待，mapAsync 继续保证此前 buffer 写入完成；活动交互/8MiB 映射/yield/完整像素/QA/shader/持久化/导出保持。哈希隔离基线热总耗时 67–75→60–64ms，部分 GPU 等待转移到 readback，不能以 computeMs 作为净收益。无迁移，验证和回滚见 [UV 底图变更卡](changes/CHG-20260915-UV-GUTTER-SEED-SCAN.md)。

2026-09-15 M07（协作 M03/M06/M08/M09）：UV-READBACK-SCHEDULING/1.2.1 在独立上下文完成回读段后先补位、再让步，保持可见 paint gate、完整 RGBA、四槽 8MiB 上限和失败排空。真实 4K 新旧 12 次全字节零差异，热中位数 80.4→76.0ms；不代表整体显隐延迟。GPU/CPU/Worker/shader、QA、持久化/导出保持，无迁移，回滚见 [UV 回读延迟](changes/CHG-20260915-UV-READBACK-LATENCY.md)。

2026-09-15 M03/M04（协作 M08/UI-05）：`GPT-CONTENT-FRAMING/2.1.0` 按用户新要求将新任务改为轮廓居中的 1:1 输入/远端输出，长边每侧留 1%（至少 2px），不伸缩模型像素。`GPT-ALPHA-PREVIEW-CROP/1.0.0` 为生成面板和放大预览新增透明源图裁切副本，按 alpha>=16 的边界向外扩 8px，全弱透明图回退非零 alpha；无色键抠图、depth 二次遮罩或降采样。原始 resultUrl、回贴/UV/导出及下载源图保持不变，旧 v1/v2 任务坐标和现有回贴 QA 保留，固定方图不保证模型构图绝对一致。无 Schema/资产迁移；仅本地修改，未推送/部署或付费生图。详见 [方图输入和预览裁切](changes/CHG-20260915-GPT-SQUARE-PREVIEW.md)。
2026-09-15 M07（协作 M08/M09/M12）：UV-SNAPSHOT-COPY/1.1.0 将不可变烘焙结果的完整复制统一为分段让步，覆盖合成与内容修补，保留独立缓冲所有权和取消；原像素、QA、持久化/导出不变，无迁移。见 [UV 快照复制变更卡](changes/CHG-20260915-UV-SNAPSHOT-COPY.md)。

2026-09-15 M07（协作 M05/M06/M08/M09）：LOCAL-BOUNDARY-REPAIR/1.2.1 缓存局部混合中不变的四邻边判断，保留方向、舍入、轮数和完整输出，新增每修补像素 1 字节临时内存。旧版本完整黄金像素及实际 4K 校验一致，无 Schema/资产迁移，范围与回滚见 [内容填补边缓存](changes/CHG-20260915-CONTENT-REPAIR-EDGE-CACHE.md)。

2026-09-15 M13（协作 M07）：S9-SAMPLE/1.0.1 接受实际 1–14 个有效投影层，仍报告真实数量并执行完整修补/发布/恢复检查；空输入拒绝，专门的 14 层压力门禁不变。PERF-SCENARIO-SUMMARY/1.0.1 合并六份相同统计到 engine，保持 60Hz、P95/最大值/丢帧定义与全部样本，不筛掉慢帧；105 组指标对照通过。仅测试入口与实现整理，无生产像素、Schema 或资产迁移；回滚恢复入口数量限制和内联统计函数。

2026-09-15 M07（协作 M06/M09/M12/M13）：ALG-UV-003 / UV-QUALITY-RESOLVE/1.0.1 将单候选色彩转换移至混合分支、复用完全相同的强权重幂值；CPU/Worker/GPU 稀疏修正共用。原 Top-K、shader、完整像素/QA、分辨率、持久化和导出保持，无 Schema/资产迁移。实际单候选内核中位数 7.6→5.5ms，多候选基本持平，不代表完整显隐延迟；验证与回滚见 [UV 质量解析快路径](changes/CHG-20260915-UV-QUALITY-RESOLVE-FAST-PATH.md)。

2026-09-15 M07（协作 M06/M09）：UV-UNDERLAY-UPLOAD/1.0.0 复用已验证只读底图的现有 GPU 缓冲，WeakRef 不保留过期 CPU 副本；变更、重分配、release、失败仍重新上传。实际 4K 热段 81–86→65–72ms、192→128MiB、GPU/CPU 零差异；不代表完整显隐延迟。原像素/QA/分辨率/持久化/导出不变，无迁移，回滚见下方变更卡。

2026-09-15 M07（协作 M06/M09/M12/M13）：UV-GUTTER-SEED-SCAN/1.0.0 对缓存跨度内已证明全零的 coverage 分组跳过，原 donor 顺序、完整像素和全部 QA 不变；UV-CACHE-WRITE/1.1.0 分段复制私有快照并流式写入，SHA、缓存格式、写完才就绪及 Project/CAS/ownership 保持。无迁移，测量限制与回滚见 [UV 填边扫描变更卡](changes/CHG-20260915-UV-GUTTER-SEED-SCAN.md)。

2026-09-15 基础与高强度测试验收见 [4517 测试记录](changes/QA-20260915-BASIC-STRESS-UV.md)：2800 次模式/图层操作与完整 4K 内容修补分别统计，保留 S6/S8 失败、14 层样本不足和剩余长帧，不以交互保护结果替代端到端质量与延迟验收。

2026-09-15 M03/M04（协作 M08/M12/M15）：`GPT-CONTENT-FRAMING/2.0.0` 在模型轮廓裁切阶段完成比例适配：3% 边距后换算不超过 100 的通用整数比例，按 1K/2K/4K 的 16px 网格预期画布补透明边，结合图/法线共用整数裁切，不发送原始像素宽高作为新任务比例。新 framing v2 保存 cropBounds/subject、比例及预期输出尺寸；已有 v1 仍支持，包括合法的独立网格取整。新回图检查尺寸及透明轮廓外接框，仅原生像素整数平移还原，异常保留结果、不重提付费任务。该尺寸公式为六个历史回图及 69:100 UI 样本验证的推导，不保证远端固定遵守；轮廓检查不代表内部变形检测。完整分辨率、QA、GPU/CPU/Worker/shader、作者蒙版、相机/depth、投影/UV/导出、Command/CAS/ownership 不变，无数据库迁移；回滚须保留 v2 读取器及已生成资产。详见 [输入比例适配变更卡](changes/CHG-20260915-GPT-INPUT-PADDING.md)。

2026-09-15 M03/M08：`ALG-VIEW-INPUT-001/1.3.1` 让原生画笔悬停复用 Alt 导航所有权，取消导航中的逐帧模型拾取；三类拖动 600 个事件均零多余拾取，松手恢复，绘制及相机轨迹保持。详见 [Alt 悬停变更卡](changes/CHG-20260915-ALT-BRUSH-HOVER.md)。

2026-09-15 M03，协作 M06/M08：`UV-READBACK-SCHEDULING/1.1.1` 将矩形采集接入完整像素 1 MiB 回读；`CAPTURE-NORMAL-ISOLATION/1.0.0` 用独立场景/骨骼/渲染器采集法线预览和引导，拟合与轮廓检查也离屏，空闲释放额外 GPU 上下文。场景所有权、矩形完整像素、失败清理测试通过；分辨率、QA、GPU/CPU/Worker/shader、投影/UV、持久化与导出语义保持，无迁移。资源开销、验证范围和回滚见 [离屏采集变更卡](changes/CHG-20260915-CAPTURE-OFFSCREEN.md)。

2026-09-15 M12/M04：`GENERATION-RECOVERY-COMPARE/1.0.0` 对相同历史恢复字段直接比较，消除反复序列化内联大图；8 MiB 纯函数 20 次约 546ms→0.21ms，不代表整体 FPS。`GEN-FAILURE-CONTEXT/1.0.0` 保留失败视角和提交/生成阶段；用户新批次左后连接失败、9/10 与上一批全部成功分别记录，不自动重提收费任务。协议/像素保持，无数据迁移，见 [历史比对](changes/CHG-20260915-GENERATION-RECOVERY-COMPARE.md) 与 [失败上下文](changes/CHG-20260915-GENERATION-FRAMING-RECOVERY.md)。

2026-09-15 M04，协作 M03/M08/M12：`GPT-CONTENT-FRAMING/1.0.1` / `GEN-POLL-CLASSIFICATION/1.0.0` / `SINGLE-VIEW-AUTO-PROJECTION/1.2.0` 修复原生输出网格取整被误判为断网的问题；保留全部原生像素、整数平移补透明，不重提付费任务。显式预期回贴的成功多视图通过既有事务恢复；用户本批十视图全部 succeeded 且各自提交图层存在，Saved。GPU/CPU/Worker/shader、QA、投影/UV、Command/CAS/ownership 和导出保持，无 Schema 迁移；详见 [十视图恢复变更卡](changes/CHG-20260915-GENERATION-FRAMING-RECOVERY.md)。

2026-09-15 M12，协作 M01/M14：`GENERATION-ASSET-REFERENCE/1.0.0` 在共同保存入口上传原字节生成 Blob 到所属工程 verified 资产并替换重复内联地址；工程隔离 SHA 小键有界缓存，失败禁止 CAS。实际工程约 59 MB 降至约 3.8 MB，主 resultUrl 无 data URI，历史和十视图提交记录保留。不改变图片/分辨率/QA、GPU/CPU/Worker/shader 或导出，下一次成功保存渐进归一化；详见 [生成资产引用变更卡](changes/CHG-20260915-GENERATION-ASSET-REFERENCE.md)。

2026-09-15 M15：`SHADER-TEMPLATE-FORMAT/1.4.1` 在既有应用 shader 白名单压缩静态模板片段空白，保留插值分隔、未知首行上下文、指令、注释保护、换行及非 shader 字符串；独立 GLSL/运行时/AST 对照通过。原 Three 141 字符串保持；预算不提高，最终已提交 SHA 须正式 prepush。详见 [shader 构建变更卡](changes/CHG-20260915-RELEASE-SHADER-WHITESPACE.md)。

2026-09-15 M06，协作 M07/M15：`UV-QUALITY-SCHEDULING/1.0.0` / `UV-DEVICE-CALIBRATION/1.1.1` 将纯评分表准备、设备校准输入与完整字节 QA 分段让出主线程；共享只读 Float32 表，GPU 纹理所有权独立。旧上下文校验不得批准新上下文，所有消费者等待校验完成。4K 独立实际 Resident 路径未缓存中层切换 264.3ms、最大帧间隔 33.3ms、长任务 0；新组合回读/修正/上传成本保留。算法像素、分辨率、QA、GPU/CPU/Worker/shader、持久化和导出不变，无迁移，详见 [主线程调度变更卡](changes/CHG-20260915-UV-QUALITY-MAINTHREAD.md)。

同卡 `UV-READBACK-SCHEDULING/1.1.0` 将同步驱动读取限制为 1 MiB，独立上下文八条并行/PBO 最多 8 MiB，可见上下文仍保留绘制边界；失败排空在途工作再释放。真实 4K 67,108,864 RGBA 字节零差异。实际工程一轮 S7 已结束，状态/覆盖/材质重建错误均零，但 P95 33.4ms、峰值 283.5ms，卡顿尚未完全消除；用户要求交还手测，停止进一步自动压测，4517 最新构建已加载。

2026-09-15 M07，协作 M06/M08/M09：`UV-DISPLAY-BUFFER/1.4.2` / `UV-UNDERLAY-DECODE/1.0.1` 将连续显隐中已过期的底图合成信号传到 Worker，并中止旧 fetch；相同签名/缓存、最新状态接续、完整像素与发布门禁保持。实际 Worker 队列与独立 4K 阻塞旧请求对照通过，不宣称首次组合实时。GPU/CPU/Worker/shader、QA、保存/CAS 与导出不变，无迁移。详见 [过期底图取消变更卡](changes/CHG-20260915-VISIBILITY-UNDERLAY-CANCEL.md)。

2026-09-15 M04，协作 M08/M12/M14：`PIXEL-EXACT-REFERENCE-UPLOAD/1.1.0` 修复 exact 引导图在前端按 Atlas JSON 预算过早拒绝的问题。原尺寸 PNG 先经无损编码和逐 RGBA 验证；仍超限时尝试原尺寸无损 WebP，包含透明 RGB 的完整字节对照通过才使用。用户工程两张失败视角现已通过实际 Atlas 上传。仍超限时用所属工程 verified 对象资产及短期签名下载上传，原 Atlas 预算保持；未配置对象存储且无损后仍超限明确阻断。完整分辨率、QA、GPU/CPU/Worker/shader、保存/CAS 与导出保持，无 Schema 迁移，前后端成套回滚。详见 [原尺寸引导图上传变更卡](changes/CHG-20260915-PIXEL-EXACT-REFERENCE-UPLOAD.md)。

2026-09-15 M15：`SHADER-TEMPLATE-FORMAT/1.4.0` 仅在构建期压缩实际 Three.js ShaderChunk 注册字符串的空白，保持 GLSL token、指令、行数及其他 JavaScript；Terser ecma 使用 Vite 类型支持的 2020，es2022 target 保持。实际 141 字符串等价回归通过，最终 SHA 必须通过正式产物预算。分辨率、QA、GPU/CPU/Worker 数学、持久化、导出与预算保持，无迁移。详见 [发布 shader 空白变更卡](changes/CHG-20260915-RELEASE-SHADER-WHITESPACE.md)。
>
> 生效日期：`2026-09-15`
>
> 代码盘点基线：`6f26336 + 资产盘点与手动隔离清理 Phase 1（本地未部署）`
>
> 基线仓库：`E:\Liclick 3D Texture Modernization`
>
> 审计口径：`0a2519d + 607e82f + 2568e40`，不包含错误文档提交 `2bde8c6/e03bab2/d1c5f78`

2026-09-14 M07，协作 UI-06/M03/M04/M06/M08/M09/M11：`UV-DISPLAY-BUFFER` v1.4.0 / `PERF-UV-SOURCE-PREPARE-001` v1.12.0。投影数据只作为生成 UV 的输入，PBR/平面视口不再发布 direct 或 texture-array 投影材质；普通显隐、投影橡皮与采样器失败均保留上一张已验证 UV，最新完整分辨率 UV 完成上传后再原子替换。Detached WebGL 的 128K 精确上传保持原条带大小，改为最多 8 条或累计 4ms 后让出任务，仍逐条检查取消/交互并恢复 GL 状态。生成链路继续在 `flat-target-coverage` 截图前等待 Resident UV 屏障，因此下一轮单视图/多视图生图输入包含模型上此前全部已发布效果。真实 4K 工程 S7 共 800 次模式/图层操作：P95 16.8ms、最大 33.4ms、状态/覆盖错误 0、材质重建 0；热缓存 14 层开关 P95/最大 16.8/16.9ms。隔离 WebGL 512/13、4K/6 与 retained-raster 对照 RGBA/coverage 差异 0；首次 4K 派生仍观察到 116.8ms 峰值，不宣称冷启动已消除。完整分辨率、Top-K、QA、接缝/gutter、CPU/Worker/shader 像素公式、Project Command/CAS/ownership、持久化、资产和导出不变，无迁移。详见 [UV-only 显示与 detached 上传变更卡](changes/CHG-20260914-UV-ONLY-DISPLAY-AND-DETACHED-UPLOAD.md)。

2026-09-14 M04/UI-05：`REFERENCE-DELIGHT-PROMPT` v1.2.0 继续收紧第二步保色约束，明确正常中间调保色 > 去高光反射 > 减弱阴影；先消亮带，暗部只做必要局部补偿，不整片填亮，不全局压暗。无法同时保色和彻底去阴影时允许微弱残留明暗，因此不承诺严格 Albedo。只调整提示词，阶段/质量/参考输入/持久化/Schema 不变；新进入第二步生效，已有第二步快照不重写，无迁移，回滚恢复原提示词。尚未运行真实生图验收。

2026-09-14 M04/UI-05：`REFERENCE-DELIGHT-PROMPT` v1.1.0 将六视图第二步去光提示词替换为用户确认的基础色优先版本：以正常中间调锁定色相、饱和度和明度，仅局部去除光照，不整体调色，不确定的色差优先保留。第一步提示词、Sunburst low → medium、两阶段调度及仅返回最终图不变。新进入第二步的任务使用新模板，已持久化的第二步提示词和已生成资产不改写，无 Schema/工程迁移；回滚仅恢复 referenceDelightPrompt 文本。提示词不保证生成模型严格锁色，未额外运行付费生图。

2026-09-14 UI-06/M06/M07：`UV-DISPLAY-DERIVED-CACHE` v1.3.1 修复发布前 4K 浏览器检查发现的合成投影图层显隐停滞：UV atlas 的光照 uniform 更新不再被视为逐层显隐已应用；关闭最后一个投影层时也根据旧可见状态触发精确预览更新。独立投影 uniform 快路径和普通 UV 的灯光更新保留，CPU/Worker/shader 像素公式、完整分辨率、QA、持久化与导出不变，无迁移。恢复这两处判定可回滚，但会重新引入眼睛状态与画面不同步；验证见 [显隐更新补充记录](changes/CHG-20260914-UV-VISIBILITY-HOTPATH-AND-CAPTURE-DEPTH-REUSE.md)。

2026-09-14 M07，协作 UI-06/M06/M08/M09：`PERF-UV-SOURCE-PREPARE-001` v1.11.0 / `UV-DISPLAY-DERIVED-CACHE` v1.3.0。投影转 UV 对已有 `linear-view` 深度且带 16 项捕获对象矩阵的层复用捕获空间可见性；GPU/CPU 原有 `capture * inverse(current)` 变换保证对象后续平移、旋转或缩放后采样点仍严格回到原捕获空间，缺矩阵、旧编码、缺 depth/所需 normal 继续保守重建。图层眼睛按钮删除全可见性 React 重复派生和普通 active-layer 模型订阅，常驻命中只更新 uniform；冷缓存、材质未接收、内容/结构/局部重绘路由变化仍强制完整重建。两组非平凡矩阵与三组点的捕获空间误差 `<=1e-9`，570 个常驻转换、60 次恢复及冷回退通过。完整分辨率、QA、GPU/CPU/Worker/shader 像素公式、Schema、Command/CAS/ownership、持久化与导出不变，无迁移。当前本地工程无真实 projected 层，S4/S5 实机门禁仍需含真实投影栈工程。详见 [图层显隐与深度复用变更卡](changes/CHG-20260914-UV-VISIBILITY-HOTPATH-AND-CAPTURE-DEPTH-REUSE.md)。

2026-09-14 UI-06 → M03（协作 M04）：`VIEWPORT-CLIPPING` v1.0.0。生成取景动画不再将捕获专用的紧 near/far 写回自由预览；预览保留已有较宽范围，near 不大于 0.01、far 不小于 100。用户滚轮/旋转/平移时修复旧捕获视角的裁剪范围，并按目标距离向内扩展近面、向外扩展远面；程序化恢复在导航前仍精确。独立生成相机及深度快照、CPU/Worker/shader/UV/export 公式不变，无资产或 Schema 迁移。修复过大的近面导致的切片，不提供实体碰撞或相机进入模型后的完整显示保证。详见 [预览裁剪变更卡](changes/CHG-20260914-VIEWPORT-CLIPPING.md)。

2026-09-14 UI-06 → M05：暂时移除图层列表的 Blend Mode 按钮、提示、点击回调和专用图标，避免显示当前无实际作用的操作入口。不透明度、显隐、蒙版及图层菜单保留；既有 blendMode 数据、合成算法、持久化和导出不变，无算法或 Schema 修订，无数据迁移。回滚 LayersPanel 的按钮与回调即可恢复原入口。

2026-09-14 UI-05 → M04/M08：`REFERENCE-GROUP-BINDING` v1.1.0。新生成多视图成功后替换来源单视图的旧配对并持久化新选择；恢复只检查同来源最新发起的任务，避免旧图被移除后旧历史再次写回覆盖新图。提交时间优先，完成/轮询顺序不作为新旧依据；新任务失败时保留现有绑定。写回前重查工程、来源与任务新旧关系；Generation.metadata 增加可选 referenceBindingApplied 标志，已写回结果删除后不自动复活。来源分组、参考资产与任务历史保留既有格式，Project Command/CAS/ownership/verified assets 不变，无批量迁移；详见 [最新多视图绑定变更卡](changes/CHG-20260914-REFERENCE-BINDING.md)。

2026-09-14 M08，协作 M03/M06：`ALG-ERASE-001` 调度修订 v1.5.2。普通投影橡皮后台预热不得抢占局部重绘选区 owner、选区绘制/应用或生图准备；直接检查运行时 ref 覆盖 store 尚未更新的窗口，并取消过期 effect 的异步预览发布。正常预热及显式橡皮准备保留，不新增双份 GPU 缓存；绘制/捕获像素、CPU/Worker/shader、完整分辨率、Schema、Command/CAS/ownership、持久化与导出不变，无迁移。已释放的旧会话选区需重画，不能伪造恢复。生产回调专项、类型与 lint 通过；未整包构建、推送或部署，发布前须最终集成验证。详见 [蒙版预热所有权变更卡](changes/CHG-20260914-INPAINT-PREWARM-OWNERSHIP.md)。

2026-09-14 UI-16 → M14，协作 M01/M02/M12/M13/M15：ASSET-LIFECYCLE-GC v0.3.3 增加 Workspace 隔离区主动永久清空。UI 必须输入“永久删除”完成第二次确认；服务端以用户级单飞幂等 purge job 先原子 rename 整个 `storage-quarantine` 到独立 `storage-purge/<jobId>`，立即从可恢复业务路径摘除，再用异步递归删除释放磁盘，不在 HTTP 请求或 React 主线程中遍历百万文件；服务重启继续未完成 purge。Cleanup job 账本记录被 purge job 认领的批次，扫描不再把已完成物理删除的字节计入 trash。真实 4517 验证中，高密度目录快速隔离 156,104 个文件 / 137,976,470,315 B 耗时 8.55s，随后扫描耗时 1.3s；最终物理释放耗时仍由文件系统决定。Cloud 只暴露不可用原因，未伪装执行；正式对象存储永久删除仍须独立生命周期 Worker、分页锁和批量 DeleteObjects。存储管理保持独立懒加载，合并远程 reference-delight/tight-framing 后总 JS 实测增量 20,125 B，新增 18,000 B 独立路由门禁并把总预算精确增加 21,000 B，主壳/Editor/Bake/共享 3D 热路径预算不变。Schema 仅新增 Purge Job/Quarantine Status 契约，不更改 Project/Revision/Asset Transfer；回滚时停止 purge，保留 `storage-purge` 中未完成目录并移除新增路由/UI，绝不能把其误判为空目录直接删除。

2026-09-14 UI-16 → M14，协作 M01/M02/M12/M13/M15：`STORAGE-INVENTORY-001/3` / ASSET-LIFECYCLE-GC v0.3.2 修复百万文件清理的任务风暴与随机元数据 I/O。每用户 cleanup start 采用单飞锁，重复确认和刷新复用同一活动 job；4517 启动时把遗留 running/queued job 明确标记为中断并触发剩余资产重扫，不伪装继续运行。扫描把最近 60 分钟修改的未引用资产归入保护集合，并把 size/mtime 写入候选证明；隔离区容量改由 cleanup job 账本汇总，不再为每次扫描重复 stat 近百万个已隔离文件。Workspace 高密度目录在重新读取引用、路径/mtime/size/符号链接门禁通过后，为少量保护文件创建同卷硬链接快照，再以两次目录 rename 原子交换，最后移除隔离侧保护链接；扫描后新增的引用单独进入保护快照，不再导致整组退化，Windows `EPERM`/`EBUSY` 短暂占用进行有限重试，门禁不满足才回退有界逐文件移动。资产写入与目录交换共享 project/category mutation lock。Cloud 继续使用 PostgreSQL 集合式逻辑隔离，生产物理删除仍要求分页、`SKIP LOCKED`、对象存储批量删除和独立 Worker 门禁，本次未连接生产库或执行 DeleteObject。Schema/Asset Transfer/Revision CAS/ownership/verified assets 不变；旧 /2 快照自动重扫，无数据迁移。回滚 /2 会失去近期保护和快速路径，应先停止 cleanup，再删除孤立 `storage/cleanup-staging`（仅限核对为空或硬链接 staging）并重扫。

2026-09-14 UI-16 → M14，协作 M01/M02/M12/M13/M15：`STORAGE-INVENTORY-001/2` 与 ASSET-LIFECYCLE-GC v0.3.1 Phase 1 已在本地实现但未部署。首页账号菜单按需加载“存储与清理”，统一 `GET /api/storage`、后台 `POST /api/storage/scans`、幂等 cleanup job 与查询协议；未知快照显示扫描中，不伪报 0 B。4517 Workspace 适配器以有界并发流式盘点元数据/资产并报告进度，当前工程、历史/Command 回执与 recoveries 受保护；扫描原子保存 scanId 候选 NDJSON，清理不再重复遍历百万文件，而是刷新引用后逐项核对路径、引用、文件类型和长度，扫描后新增文件不处理、恢复引用或发生变化的候选跳过，其余候选并发原子移入用户隔离区。Cloud 适配器从 PostgreSQL verified transfers 与 current/history/trash Revision 重建引用图，在 `004_asset_storage_v2_shadow.sql` 影子表中保存快照、候选、幂等任务和逻辑隔离，不更改 Asset Transfer v1、Revision CAS、ownership 或 verified asset 下载。当前未执行数据库迁移、未连接正式站、未物理删除对象，也未启用内容去重、配额或图片重编码；这些仍受下一阶段兼容门禁约束。迁移仅使旧本地快照缺少候选清单而要求重扫一次；回滚到 /1 时删除 `storage/inventory-candidates`，移除 UI/路由/服务并保留或删除空影子表即可，已移入 Workspace 隔离区的文件按 manifest 原路径恢复。Node/PGlite 双端契约、漂移保护、类型、lint 与 production build 通过。

2026-09-14 UI-16 → M14，协作 M01/M02/M10/M12/M13/M15：先行设计把资产生命周期扩展为 4517 Workspace 文件与 Cloud PostgreSQL/对象存储的统一端口、双适配器和首页“存储与清理”入口，候选 ASSET-CONTENT-DEDUP、ASSET-LIFECYCLE-GC、ASSET-QUOTA-RESERVATION、ASSET-ROLE-COMPRESSION 升级为 v0.2.0。账号菜单只显示已用/可清理摘要，管理弹窗规划后台扫描、手动隔离清理、恢复和独立图片优化任务；无完整快照时不得显示 0 B 或允许清理。图片 canonical 不按 Accept 静默转换、不原地覆盖；PNG 仅在 Sharp 与真实浏览器 RGBA/ICC/方向兼容门禁通过后无损切换，JPEG 原件不二次有损，Mask/Depth/Normal/PBR 只允许专用无损验证，WebP 先限于显式 UI 预览变体，AVIF 暂不进入生产资产协议。4517 仅为当前浏览器一体服务的开发验收适配，不恢复 4618/安装器/本地凭据或端点切换。详细阶段与回滚门禁见 [资产生命周期设计卡](changes/CHG-20260914-ASSET-LIFECYCLE-COMPRESSION-DESIGN.md)。

2026-09-14 UI-05（M04）：生成区独立状态提示框隐藏“第一步/第二步”的六视图与去光阶段文案，继续显示实际错误与异常提示。按钮进度、两轮模型/质量/提示词、服务端轮询与取消恢复不变；仅展示修订，无算法或 Schema 变更，无数据迁移。回滚 GeneratePanel 的提示过滤即可恢复原展示。

2026-09-14 M04/UI-05：`MULTIVIEW-REFERENCE-PIPELINE` v1.0.0 / `MULTIVIEW-REFERENCE-PROMPT` v2.0.0 按用户实测流程，将单视图派生六视图改为 Sunburst low 生六视图 → Sunburst medium 对整张六视图去光照。两段提示词采用用户原文，第二轮仅引用第一轮结果并沿用尺寸档位；前端统一 3:2 布局，只发布第二轮成功结果。两轮共用服务端任务身份、个人莉刻账号、取消与后台恢复；生成日志增加可选 referenceDelight 阶段记录，第二次付费提交前先持久化意图，响应不确定时不自动重提。历史无标记任务维持单轮，已存在多视图不自动重生成。Project Schema、Command、Revision CAS、ownership、verified assets、投影/UV/GPU/CPU/Worker/shader 与导出不变，无工程迁移。发布前需排空或终止双阶段活动任务才可回滚旧服务，避免旧代码把第一轮结果当作完成。参数与控制流已用隔离夹具验证，未额外运行付费生图，不承诺实际耗时或严格 Albedo。详见 [两阶段参考图变更卡](changes/CHG-20260914-REFERENCE-DELIGHT-PIPELINE.md)。

2026-09-14 主模块 M03，协作 M04/M08/M06：`ALG-CAP-007` v1.1.0。单视图、局部重绘及多视图按实际提交顶点适配相机，目标限制尺寸 92%，保留 4% 边距；256px 轮廓安全检查不替代正式分辨率。各角度独立冻结相机，已有纹理、白模、蒙版、深度和后续投影共用该角度相机，明确快照不再被二次取景覆盖。无有效几何、变形不支持、超出扫描上限或轮廓校验失败时保留原包围盒取景；纵深限制时允许占比低于 92%。共用目标网格筛选，取景代码并入编辑器模块以减少重复模块依赖开销，包体预算不变。GPU/CPU/Worker/shader 投影公式、UV/export、分辨率、QA、Schema、Command/CAS/ownership/资产协议不变，无数据迁移。详见 [紧凑取景变更卡](changes/CHG-20260914-TIGHT-CAPTURE-FRAMING.md)。

2026-09-12 UI-05 → M04：模型入口收起时保留 `GPT-Image 2.5` 前缀，与弹窗共用完整标签，窄栏只省略尾部。仅展示文案变更，算法、请求值、质量、默认设置和 Schema 不变，无迁移；回滚标签即可恢复简称。见 [生成区变更卡](changes/CHG-20260912-GENERATION-ACTION-FAST.md)。

2026-09-12 UI-05 → M04（协作 M08/M12）：生成按钮上方改为左模型、右质量两个入口，点击在上方 Portal 叠加弹窗、选完收起；支持外部/Esc 关闭、互斥、焦点和键盘导航，原局部重绘隐藏参数，移除两行说明。`GPT25-TEXTURE-GENERATION` v1.2.0 支持 Sunburst、Flare、GPT-Image 2，默认 Sunburst/高，保留用户合法选择。依据莉刻实时注册表，2.5 模型五档质量、GPT-Image 2 三档，切换至不支持当前档位的模型时显示并保存高；服务端按模型校验质量并修复 GPT-Image 2 恒传高。弹窗仅展示层变更，无新增算法语义。任务锁、侧栏避让、方图/透明/4K→2K、固定并发、GPU/CPU/Worker/shader、资产持久化与导出不变，无 Schema 迁移。验证与回滚见 [生成区变更卡](changes/CHG-20260912-GENERATION-ACTION-FAST.md)。

2026-09-12 UI-06/UI-10 → M08，协作 M06/M07：`ALG-ERASE-001` v1.5.1 / `UV-DISPLAY-BUFFER` v1.3.1 将当前普通 projected 图层的中性 GPU keep-mask 与 exact direct/texture-array 材质栈提前常驻预热，不再等用户选择橡皮后才开始编译。若用户在异步 GPU 准备完成前已经落笔，完整记录屏幕笔段并在 GPU 接管前按原半径、羽化和顺序补放；当前手势继续保持打开，已完成手势也不会在 Canvas→GPU 交接时回弹或丢失。图层/模型/分辨率变化释放旧会话并重建；完整分辨率、QA、正式提交、Worker/CPU 后处理、持久化、导出、Schema/CAS/ownership/verified assets 不变，无迁移。同步验证 direct fallback 与橡皮 exact stack 的共享预算门禁，修复流水线 #630458 的 web-regression 失败。详见 [常驻预热变更卡](changes/CHG-20260912-ERASER-RESIDENT-PREWARM.md)。

2026-09-12 UI-05 → M04（协作 M08）：`GPT-MULTIVIEW-PAIR-SEQUENCE` v1.4.0 固定采用原加速分组，移除两张稳定模式及切换按钮，旧工程并发枚举仅保留兼容、不参与新任务调度。10/14 视图分别为 2+4+4、2+4+4+4，自定义及不完整配对保持独立；组内并发、固定序回贴、组间材质呈现与失败/取消门禁不变。模型和质量参数移入底部生成按钮区；原局部重绘隐藏参数，GPT 局部重绘保留。侧栏按按钮区实测高度避让。GPU/CPU/Worker/shader、投影/UV/export、分辨率、质量参数、透明 Alpha、持久化和资产协议不变，无数据迁移。见 [生成区布局及固定并发变更卡](changes/CHG-20260912-GENERATION-ACTION-FAST.md)。

2026-09-12 UI-06/UI-10 → M08，协作 M06/M07：`ALG-ERASE-001` v1.5.0 / `UV-DISPLAY-BUFFER` v1.3.0 将普通 projected 橡皮的可见交互改为项目真实 1K/2K/4K/8K 分辨率 GPU keep-mask 增量盖章；每帧只写命中脏瓦片，不再触发 Resident UV 全图重合成、Worker 质量传播、CPU readback 或整图上传。安全的 direct/texture-array 正式图层栈继续负责源纹理、顺序、作者蒙版、深度和颜色，Resident UV 仍负责眼睛/顺序变化及正式提交；采样器或 uniform 预算不安全时 fail-closed 回到原精确路径。修复 mask-only UV 输出和瓦片 scissor 的 V 轴约定，消除上下镜像笔触。512 Canvas 只作为不可见的延迟持久化草稿，不参与显示、最终蒙版或导出；GPU 不可用时回退为完整项目分辨率 Canvas。Schema、Project Command、Revision CAS、ownership 与 verified assets 不变，无迁移。详见 [GPU 跟手蒙版变更卡](changes/CHG-20260912-ERASER-GPU-MASK.md)。

2026-09-12 UI-01 → M03：工具箱 `/tools` 顶部 LI3D Logo 接入页面已有的功能主页导航，与同页“返回功能首页”按钮保持一致；Logo 具备按钮语义、键盘焦点、可访问名称与现有 hover/focus 反馈。工具清单、下载、登录状态、路由结构、算法、Schema、资产、持久化和部署不变，无迁移。详见 [工具箱 Logo 导航变更卡](changes/CHG-20260912-TOOLBOX-LOGO-HOME.md)。

2026-09-12 UI-06/UI-10 → M08，协作 M06/M07：`ALG-ERASE-001` v1.4.1 / `UV-DISPLAY-BUFFER` v1.2.1 仅确认已经成功发布的橡皮草稿 revision，下一轮计算窗口覆盖所有尚未发布的变化；保留累计 Canvas 蒙版和正式提交语义。不可变 UV topology 可复用有界边界种子，动态 coverage 仍逐次过滤，顺序传播不变。不是完整 GPU 橡皮，短距离拖动未证明端到端提速。完整分辨率、QA、GPU/CPU/Worker/shader 像素规则、持久化和导出不变，无迁移。验证和回滚见 [增量确认变更卡](changes/CHG-20260912-ERASER-REVISION-BOUNDS.md)。

2026-09-12 M07，协作 UI-06/M06/M09：`PERF-UV-SOURCE-PREPARE-001` v1.10.0 将同一次 GPU UV bake 的私有来源纹理从“每张上传后各等待两次呈现”改为“全部精确上传并 flush 后统一等待一次双帧发布屏障”。512/13 图层 retain-raster 三轮配对共 6 次均值 1771.3ms→939.6ms，约提升 47.0%；两图层 JPEG/PNG 约提升 45.3%/44.2%。4K/6 图层中位样本在约 0.5% 噪声范围内，未声明稳定提速或退化。全部 PNG、JPEG、重叠源、4K 与 retain-raster 对照像素差为 0，候选路径无 Long Task。条带大小、自适应帧预算、交互静默、取消、GL 状态恢复、每纹理 flush 与整批最终双帧屏障保留；公开缓存纹理及 detached renderer 仍使用原独立发布规则。完整分辨率、QA、GPU/CPU/Worker/shader 像素公式、持久化和导出不变，无迁移。详见 [UV 来源批量发布变更卡](changes/CHG-20260912-UV-SOURCE-BATCH-PRESENTATION.md)。

2026-09-12 M07，协作 UI-06/M06/M09：`PERF-UV-SOURCE-PREPARE-001` v1.9.0 移除可见 WebGL renderer 在健康帧预算内每个 128K 精确上传条带后的强制宏任务等待，改为累计同步 GL 提交达到 4ms、帧拥塞或需要呈现时才等待下一次绘制；后台 detached renderer 仍逐条带让出任务。三轮 4K 冻结前后配对（共 6 次）均值 1032.5ms→998.1ms，约 3.3%；13 图层 retain-raster 路径约 0.6%，视为基本持平。全部对照像素差为 0，当前路径无 Long Task；条带大小、自适应降档、交互静默、取消、GL 状态恢复、flush 与最终双帧发布屏障保持。完整分辨率、QA、GPU/CPU/Worker/shader 像素公式、持久化和导出不变，无迁移。详见 [UV 可见上传批处理变更卡](changes/CHG-20260912-UV-VISIBLE-UPLOAD-BATCHING.md)。

2026-09-12 UI-06 → M06/M09：`UV-DISPLAY-DERIVED-CACHE` v1.2.0 修复图层显隐组合的展示缓存身份与发布门禁。缓存键纳入完整像素影响字段，只有当前请求键的精确完成纹理可登记；精确命中同步复用，未完成的新组合不再显示或缓存另一显隐状态的旧纹理。投影转 UV 的 GPU/CPU/Worker/shader、Top-K、接缝、gutter、完整分辨率、QA、持久化和导出不变，无迁移。详见 [UV 显隐精确缓存变更卡](changes/CHG-20260912-UV-VISIBILITY-EXACT-CACHE.md)。

2026-09-12 UI-05 → M04/M08：`REFERENCE-GROUP-REUSE` v1.0.0 统一单视图与其已生成多视图的提交时解析。用户再次选择单视图时，若同一 `referenceGroupId` 的多视图仍存在则直接复用；用户手动删除该多视图后才沿既有流程重新生成并建立新绑定。显式选择多视图保持直用，不跨组复用，历史任务只在没有当前选择时兜底。沿用 ReferenceImage 可选分组字段、Project Command v1、Revision CAS、ownership 与 verified reference asset；无 Schema、资产或旧工程迁移。GPU/CPU/Worker/shader、投影/UV/重绘 coverage、分辨率、QA 与导出不变。详见 [参考组复用变更卡](changes/CHG-20260912-REFERENCE-GROUP-REUSE.md)。

2026-09-12 M04，协作 M08/M12：用户明确要求界面选 4K 时仍使用 2K 生图参数。`GPT25-TEXTURE-GENERATION/1.1.1` 在单/多视图及 GPT 局部重绘共享请求策略中映射 4K→2K，1K/2K 不变；方图、模型、质量、透明背景与任务数量不变。仅改变新 GPT 任务的 imageSize，不改项目 UV/贴图分辨率、截图、投影、蒙版、GPU/CPU/Worker/shader、持久化/导出公式或 Schema，不回写历史任务。无迁移；回滚该映射即恢复顶部 4K 请求 4K，已生成资产保持可读。见 [GPT 参数变更卡](changes/CHG-20260912-GPT-OPTIONS.md)。

2026-09-12 `CHG-20260912-ERASER-INTERACTIVE-UPLOAD`：UI-06/UI-10 → M08，协作 M06/M07；候选 `ALG-ERASE-001` v1.3.10 / `UV-DISPLAY-BUFFER` v1.1.2。用户批准新版优化，本次仅落实上传与调度阶段：当前普通投影层的交互草稿显式允许源纹理和结果纹理在交互期间分条上传；默认后台/正式合并仍等待交互静默。交互结果直接转移 straight RGBA 给既有 Worker，按原方向分条，不再创建全图 ImageBitmap；静态缓存/正式结果保留旧路径及所有权。Top-3、CPU 舍入修正、接缝/gutter、shader、分辨率、QA、Schema、历史/资产持久化及导出不变，无迁移。123 项回归、1K/2K-14 层/4K 隔离持续拖动通过；强制恢复旧上传门禁的 1K 反证超时。4K 曾在并行回归负载下超时，重跑通过但反馈约 1.3 秒，尚非逐帧 GPU 增量更新，也未完成复杂工程/长期稳定验收。本次未推送或部署；回滚及详细验证见 [变更卡](changes/CHG-20260912-ERASER-INTERACTIVE-UPLOAD.md)。

2026-09-12 M07，协作 M05/M06/M08：`LOCAL-BOUNDARY-REPAIR` v1.2.0 将内容识别补缝的生产检测/拓扑/修补上限由 2K 提升到 4K，使用户选择 4K 时细缝、小 UV 岛和覆盖边界不再先缩到 2K 判定；8K 仍使用明确的 4K 修补上限。Worker 启动同时取消 UI 线程对完整 topology/region/seam/source-exclusion 只读数组的显式预复制，保留 resident 源，并由浏览器结构化克隆直接创建 Worker 所有副本；短生命周期 RGBA/write mask 继续安全转移。4096² 浏览器夹具修补 524,288 texel，中心边界颜色、4K PNG、无跨区域/全局填色均通过，Worker 单次约 2965ms；2K Worker/主线程逐字节差为 0。没有改变颜色传播、Alpha、来源阈值、接缝、GPU/shader、投影层顺序、持久化或导出公式，不把 4K 总耗时冒充提速。无 Schema、Command、Revision CAS、ownership 或资产迁移。详见 [4K 内容识别补缝变更卡](changes/CHG-20260912-CONTENT-AWARE-4K.md)。

2026-09-12 UI-06 → 主模块 M05，协作 M06/M07：`LAYER-MULTISELECT-VISIBILITY` v1.0.0 在批量关闭所选图层导致 LayerStore 自动切换 active layer 时保留原多选集合，因此任一仍被选中的隐藏图层眼睛可原集合批量打开；所选行增加持续可见的洋红内描边，active 蓝色底边语义不变。该修改不改变单选、Shift/Ctrl 选择、图层顺序、可见性值、投影转 UV 像素、完整分辨率、QA、持久化或导出。无 Schema、资产或工程迁移；回滚只恢复 active layer 驱动的单选收敛与原背景高亮。详见 [图层多选显隐变更卡](changes/CHG-20260912-LAYER-MULTISELECT-VISIBILITY.md)。

2026-09-12 M07，协作 M06/M08/M09：`PERF-UV-SOURCE-PREPARE-001` v1.8.0 将“普通投影底层 + 单个连续局部重绘 literal overlay”也纳入既有颜色直合成路径。该路径不再为最终只按颜色覆盖的 overlay 创建、栅格化和读回未被消费的质量缓冲；RGBA、coverage、rendered-color mask、层序、接缝、gutter、完整分辨率与发布屏障保持原公式。4K 冻结夹具的 5→4 层状态单次样本由 1122.4ms 降至 892.5ms，GPU/读回阶段由 619.0ms 降至 412.9ms，完整 bake 由 991.1ms 降至 765.1ms；17 个显隐状态重复结果逐像素一致，该隔离样本不作为所有模型的固定提速承诺。CPU/Worker/shader、持久化、导出、Schema、Revision CAS、ownership 与 verified assets 不变，无迁移。详见 [单覆盖层 UV 直合成变更卡](changes/CHG-20260912-UV-SINGLE-OVERLAY.md)。

2026-09-12 UI-05 → 主模块 M05，协作 M03/M12：旧版单图参考选择器删除参考图后立即进入既有 Project Save Coordinator，以当前 ReferenceStore 快照执行 Revision CAS 保存，不再依赖可能晚于路由切换/刷新的延迟 autosave。新版分组参考选择器原有即时保存保持；只移除工程中的引用关系，不删除已验证对象资产，不改变生成输入、图片字节、ownership、Project Schema 或 Command 幂等语义，无数据迁移。回滚可移除旧入口的即时事件，工程数据无需改写。详见 [参考图删除持久化变更卡](changes/CHG-20260912-REFERENCE-DELETE-PERSISTENCE.md)。

2026-09-12 M07，协作 UI-06/M06/M09：`PERF-UV-SOURCE-PREPARE-001` v1.7.0 将 Resident Top-K 的两个既有 ping-pong 候选目标都登记为已完成精确前缀。关闭最高优先级可见投影层时，直接选择仍驻留的前一候选目标并从该精确层数继续，不再重新投影其下全部可见层；重新打开时只追加尾层。租用即撤销完成身份，只有同一请求完整读回、补缝、gutter 与发布成功才重新提交；取消、异常、中间层显隐、顺序/内容/几何/context 变化仍完整重算。没有增加显存预算，不降低分辨率，不跳过 QA，GPU/CPU/Worker/shader 像素公式、持久化与导出不变。详见 [UV 聚合前缀变更卡](changes/CHG-20260912-UV-AGGREGATE-PREFIX.md)。

变更卡 `CHG-20260912-GPT-MULTIVIEW-CONCURRENCY`：UI-05 → 主模块 M04，`GPT-MULTIVIEW-PAIR-SEQUENCE` v1.3.0（Multiview concurrency selection / 多视图并发切换）；稳定路径 production，加速路径为非默认可选能力，真实远端速度与美术一致性待验收。实施 Codex、体验验收维护者。新增小按钮切换稳定/加速，按项目保存可选 `settings.imageGeneration.textureMultiviewMode=stable|fast`；缺失或未知值读取为 stable。稳定每组最多 2 张；加速保留首组，后续仅合并相邻完整预设对为最多 4 张，预设 10 视图为 2+4+4，14 视图为 2+4+4+4；自定义新增相机和缺失一半的预设对仍独立执行，不猜测朝向，不重排原有提交顺序。输入为既有视角列表/预设和模式，输出为有序分组，不涉及像素、单位或矩阵换算。生成准备和执行期间锁定按钮，批次使用启动时的策略；同组全部输入先准备并持久化再提交远端，组内并发等待、按固定顺序串行回贴，真实材质驻留与呈现屏障后才捕获下一组。同组结果不互相参考，四图并发不保证美术一致性或固定提速；失败保留本组成功结果并停止后续组，取消沿用原任务身份检查，整批成功后仍仅一次内容修补。不改变单视图、局部重绘、提示词、分辨率、质量、透明 Alpha、GPU/CPU/Worker/shader 投影、UV/export、捕获空间、Layer/Generation/Capture Schema、Command v1、Revision CAS、ownership 或 verified assets。Project 设置新增可选枚举，不需批量迁移；回退按钮/策略后忽略该字段，保留历史图层和资产，稳定模式可立即恢复原分组。回归执行实际调度器与面板适配器，覆盖 10/14 视图、默认/未知值、自定义相机、四任务乱序、组间呈现屏障、本组失败保留、输入快照及按钮双向切换/锁定。未进行付费生图，不把模拟并发等同线上耗时收益。

2026-09-12 UI-06/UI-10 → 主模块 M08，协作 M06/M07，候选 `ALG-ERASE-001` v1.3.9 / `UV-DISPLAY-BUFFER` v1.1.1：普通投影橡皮恢复有界密集表面采样，并在用户批准后接入当前层独立、完整分辨率的 UV 蒙版草稿。拖动中单任务合成最新快照；复用正式 GPU/CPU/Worker/接缝/gutter/QA 管线，不擦最终整栈 Alpha，不降低分辨率。草稿不写入 LayerStore、持久缓存或历史，正式蒙版按 URL/revision 实际呈现后交接。当前候选仍为完整 UV 重合成，不是脏区 GPU 增量核；4K 隔离反馈约 929ms，未达到逐帧跟手，包体门禁也待解决，不具备发布结论。原生 UV/局部重绘橡皮显示路径、投影/UV/export 像素、Schema、CAS/ownership/资产协议不变，无迁移。Modddif 录屏仅用于确认交互目标，不作为其内部算法或性能证据。见 [变更卡](changes/CHG-20260912-ERASER-CONTINUITY.md)。
2026-09-12 M07，协作 M06/M09/M15：`UV-DISPLAY-MASK-WORKER/1.3.0` 将普通 BaseColor 投影栈的全零 rendered-color mask 规范化为空数组。Quality Blend Worker 不再为每次 4K 普通合成分配并传输 16 MiB 全零 R8，Resident GPU 聚合缓存不再复制/计入该冗余数组，CPU fallback 也只在存在 rendered-color 图层时分配；显示端对空数组绑定原 1×1 零值 RedFormat 纹理。包含 rendered-color 局部重绘的栈仍生成、衰减、缓存并上传完整逐 texel mask；RGBA、coverage、层序、shader 采样、完整分辨率、QA、持久化和导出语义不变，无迁移。详见 [Resident UV 全零蒙版省略变更卡](changes/CHG-20260912-UV-ZERO-MASK-ELISION.md)。

2026-09-12 M07，协作 M06/M09/M15：`UV-RASTER-MRT/1.0.0` 在偶数分辨率 WebGL2 Resident 普通投影路径用一个双附件 draw 同时写 RGBA 颜色与 R8 质量，替代对同一高面数几何执行颜色、质量两个完整 pass；生产 1K/2K/4K 均覆盖，非 Resident、overlay、WebGL1 与奇数诊断尺寸仍保留原双 pass。颜色附件继续使用非预乘 NormalBlending；质量附件以 RGB=1、Alpha=quality 表达原 premultiplied source-over，缓存对两个附件只释放一次 owner。16 组 shader 对照和 512/4096 整链冻结对照均为 0 字节差异；约 26 万三角形夹具的 6 层提交由 12 draw/3,133,440 三角降为 6 draw/1,566,720 三角。直接 4K 六层基线端到端受来源上传主导，约 942–1054ms 对 1000–1051ms，不能宣称该样本已有稳定整体提速。完整分辨率、QA、Worker/CPU、接缝、持久化和导出不变，无迁移。详见 [Resident UV MRT 变更卡](changes/CHG-20260912-UV-RASTER-MRT.md)。

2026-09-12 `CHG-20260912-ERASER-UV-REGION`：UI-06/UI-10 → 主模块 M08，协作 M06/M07；`ALG-ERASE-001` v1.4.0 / `UV-DISPLAY-BUFFER` v1.2.0。用户反馈第一阶段仍迟滞并批准继续优化。1K/2K 普通投影橡皮保留完整密度的 pre-postprocess RGBA/coverage/rendered-color 原始合成；脏区以 512/1024 方块局部光栅、Top-3 解析、CPU 舍入修正、overlay 合成并贴回原始合成，再完整执行原接缝/gutter/Alpha 后处理。保持原 framebuffer 大小和 viewport，以 scissor 限定范围、GPU 精确拷贝到小目标，避免移动 viewport 引入插值舍入差异。全图/区域缓存共用原 256 MiB 上限，候选尺寸变化重建整数目标、使旧前缀失效；区域缓存可直接裁取既有同签名 GPU 栅格。4K、过大笔画、无原始缓存均用原完整路径，不降采样。正式合并、导出、持久化、撤销/重做及 Schema 不变，无资产迁移；显示端扫描后处理后的实际像素差异，在新目标中 GPU 复制旧图、只上传变化区域并原子发布；源蒙版/R8 上传及完整后处理仍有开销，不宣称逐帧 GPU 显示。验证和回滚见 [区域重算变更卡](changes/CHG-20260912-ERASER-UV-REGION.md)。


2026-09-12 M07，协作 M06/M08/M09/M15：`UV-DISPLAY-MASK-WORKER/1.2.0` 将 Resident UV 的 rendered-color mask 从 Worker resident source、翻转条带到 WebGL2 纹理全程保持 R8 单通道；shader 继续只采 `.r`，不再为每个条带创建 RGBA `ImageData/ImageBitmap`。4K 单 mask GPU 名义容量由 64 MiB 降为 16 MiB，上传字节与条带瞬时数组减少 75%；`UNPACK_ALIGNMENT` 显式设为 1 并恢复原 GL 状态。`SHADER-TEMPLATE-FORMAT/1.3.0` 同时将已验证只含 shader 模板的 ViewportCanvas 纳入构建去缩进，最终提交 `5504d49` 的 release 总 JavaScript 为 `3,219,108 / 3,222,000`，余量 `2,892` 字节。完整分辨率、QA、UV 颜色、图层/眼睛、持久化和导出不变，无迁移。详见 [Resident UV R8 变更卡](changes/CHG-20260912-UV-DISPLAY-R8.md)。

2026-09-12 M15，协作 M04/M07/M08：`WEB-BUNDLE-BUDGET/1.0.0` / `SHADER-TEMPLATE-FORMAT/1.2.0` 修复本次功能分支 rebase 后正式 Web 总 JavaScript 从 `3,223,880` 字节超过 `3,222,000` 门禁的问题。Preview Bitmap 请求/纹理发布与 Worker resident source 去重，局部重绘结果移除无效动态导入，缓存热路径使用等价紧凑结构；构建期 GLSL 去缩进显式扩展到 7 个实际生产 shader 模块，AST 逐 token 验证且拒绝普通 UI 模板。最终 release 环境正式产物 `3,221,157` 字节，保留 `843` 字节余量；预算、分辨率、QA、像素、Schema、持久化及导出语义不变，无迁移。详见 [Web 包体门禁变更卡](changes/CHG-20260912-WEB-BUNDLE-BUDGET.md)。

2026-09-12 M15，协作 M06/M07：`SHADER-TEMPLATE-FORMAT/1.1.0` 将已有生产构建模板去缩进扩展至实际打包的 gpuUvBakeRenderer 的 GLSL 常量，仅删除换行后的缩进，保留 GLSL token、预处理行、插值间隔和像素算法。合并 GPT 参数与后台生命周期优化后总包超出预算 1651 字节；该文件可去除 2344 字节源码空白，不提高预算、不降低分辨率或 QA，最终产物仍需通过正式预算检查。新增实际模块逐 token 等价与仅 Shader 变量受影响断言；无持久化迁移，回滚可移除新增文件白名单。未采用对非打包 PreviewCompositor 的格式化，因为不减少生产产物。

2026-09-12 M04：`GPT25-TEXTURE-GENERATION/1.1.0` 将单/多视图和 GPT 局部重绘输出统一为 1:1 方图，分辨率绑定顶部 1K/2K/4K；新增项目级五档质量 low/medium/high/xhigh/max，默认 high，两种 GPT 模型均可切换。透明背景固定，原远端局部重绘不变。协作 M08/M12，详见 [变更卡](changes/CHG-20260912-GPT-OPTIONS.md)。

2026-09-12 M04/M06：`GPT-TRANSPARENT-TEXTURE/1.0.0` 接通 GPT2/Sunburst/Flare 纹理及 GPT 局部任务 background=transparent；通过持久化 extraParams.background 选择源 Alpha 分支，不根据模型名迁移旧任务。新单/多视图保留源 RGBA 和完整画布，跳过重复抠图；capture mask、深度、角度及笔刷约束保留。规范图层恢复尊重显式 ignoreSourceAlpha=false，旧无标记流程不变。协作 M07/M08/M12，详见 [变更卡](changes/CHG-20260912-GPT-TRANSPARENT.md)。

2026-09-12 M04/M08：`GPT25-TEXTURE-GENERATION/1.0.0` 接入莉刻 Sunburst/Flare 并保留两视角并发、分组串行；`GPT-REPAINT-GUIDE/1.0.0` 新增独立 GPT 局部重绘入口，只有无纹理处与笔刷选区使用白模，其余纹理保留。GPT 仅接收组合图和材质参考，原始 UV 选区仍是唯一回贴授权。使用现有单视图提示词、原局部重绘保持不变。`GPT-REPAINT-ALPHA/1.0.0` 按用户确认让新 GPT 局部返图跳过 ALG-LR-013 内缩/强制不透明，前台与恢复原样保留源 RGBA；原远端 ModelView/Klein 保留内缩。协作 M06/M07/M12：回贴显式使用源 alpha，原笔刷/深度约束、合并与导出透传逻辑不变；既有已裁任务不重算。详见 [变更卡](changes/CHG-20260912-GPT25-REPAINT.md)。

2026-09-12 UI-06 → M03/M08：`ALG-VIEW-INPUT-001` v1.2.1 在一次活动笔画内复用 pointer-down 冻结的 canvas/光标 overlay 几何，命中帧不再在 BVH 射线后重复执行两次 DOM 布局读取；未命中帧立即隐藏画笔光标，并避免重复写入相同 CSS cursor。模型边缘的命中判定、每显示帧一次射线、笔画断开规则、右键模型擦除/背景旋转及所有画笔像素不变。GPU/CPU/Worker/shader、分辨率、QA、持久化和导出不变，无迁移。专项表面输入、投影层、鼠标按钮及 TypeScript 回归通过；详见 [鼠标输入变更卡](changes/CHG-20260912-VIEWPORT-MOUSE-BUTTONS.md)。

2026-09-12 M08：`ALG-LR-UV-PAINT` v1.1.4 将 UV 画笔瓦片的精确屏幕包围盒绑定到相机、视口、模型矩阵和可见性签名；同一静止视角连续绘制时复用结果，只做矩形相交，不再为每个命中帧重复投影全部瓦片表面及创建临时矩阵/向量。相机、视口、模型或可见性变化立即完整重算；近裁剪面保守命中、GPU 可见性/遮挡、共享 UV、羽化、擦除、像素和瓦片历史不变。CPU/Worker/shader、完整分辨率、QA、持久化及导出协议不变，无迁移。真实 Edge/WebGL 的 DPR、曲面、透视、旋转、遮挡、撤销/重做/擦除逐像素回归通过；4K 32 万面合成夹具 CPU 提交中位样本约 0.9→0.5ms，最大值受 GPU/调度噪声影响，不作为原工程 FPS 承诺。详见 [UV 笔刷变更卡](changes/CHG-20260911-UV-BRUSH-RASTER-BATCH.md)。

2026-09-12 UI-06 → M03/M08：`ALG-VIEW-INPUT-001` v1.2.0 明确右键的命中优先级：三维视口从可绘制模型上起笔时由蒙版、普通画笔、局部重绘或橡皮路径独占并执行擦除；从背景起笔时不消费事件，交给轨道旋转，避免同一手势同时擦除和转相机。独立局部重绘二维画布无三维轨道，保留左键绘制、右键擦除；压感笔尾擦继续保留。画笔/橡皮像素、相机数学、GPU/CPU/Worker/shader、分辨率、QA、持久化及导出不变，无迁移。详见 [鼠标输入变更卡](changes/CHG-20260912-VIEWPORT-MOUSE-BUTTONS.md)。

2026-09-12 UI-06/M08：`LOCAL-REPAINT-GPU-OWNER-LIFECYCLE` v1.1.0 在视口 effect 建立时固定捕获本生命周期的 dirty texture、发布请求与 revision 容器，卸载时只清理该批 owner；补齐 resident mask 提升回调依赖，避免闭包跨生命周期读取新 ref。同步删除 7 处明确未使用的导入、变量和帮助函数，lint 警告由 14 降至 2。局部重绘像素、生成、投影、UV、分辨率、持久化与导出不变，无迁移。详见 [视口 owner 清理变更卡](changes/CHG-20260912-VIEWPORT-CLEANUP-OWNERS.md)。

2026-09-12 M07，协作 M06/M09：`UV-SEAM-REPAIR-PLAN` v1.4.0 将 4K 接缝冷计划最内层采样由短生命周期坐标对象改为等价标量计算；完整浮点插值、floor 包含 texel、边界钳制、重复地址、donor/写入顺序和 coverage 更新均不变。冻结旧核 500 组修补、40 组变换网格、重复/非流形与冷/热缓存逐字节回归通过；不降低分辨率、不跳过接缝或 QA。无 Schema、资产、持久缓存或导出迁移。详见 [接缝标量热路径变更卡](changes/CHG-20260912-UV-SEAM-SCALAR-HOTPATH.md)。

2026-09-12 UI-05 → M04：多视图底部主按钮在“提交任务 / 等待本组回贴显示 / 等待视口渲染恢复”阶段只显示 `第 n/m 组 · xx%`，避免窄栏内长文案换行；左侧普通状态、错误、其他进度标题以及严格回贴/Resident UV 屏障保持不变。无算法、Schema、资产或迁移变更。详见 [渲染衔接变更卡](changes/CHG-20260912-GENERATION-RENDER-LIFECYCLE.md)。

2026-09-12 M07，协作 UI-06/M06/M09：`PERF-UV-SOURCE-PREPARE-001` v1.6.0 将同一 renderer/几何 scope 下的精确 UV 聚合结果由单状态改为硬预算内最多两个状态的 LRU，覆盖图层眼睛最常见的 A/B 开关往返；第三状态、预算不足、内容/顺序/几何/context 变化按原规则淘汰或全部失效。缓存存储与读取仍复制完整 RGBA/coverage/rendered-color mask，不降低分辨率或跳过 QA。详见 [UV 聚合前缀变更卡](changes/CHG-20260912-UV-AGGREGATE-PREFIX.md)。

2026-09-12 UI-10 → M08：`LOCAL-REPAINT-BRUSH-DEFAULT` v1.0.0 将局部重绘的视口蒙版画笔和独立画布画笔初始大小统一为 15；只影响新建运行时/对话框的初始设置，用户随后调整仍按原范围与压感公式生效。画笔像素公式、羽化、GPU/CPU/Worker、分辨率、保存、历史和导出不变，无 Schema 或资产迁移。详见 [局部重绘画笔默认值变更卡](changes/CHG-20260912-LOCAL-REPAINT-BRUSH-DEFAULT.md)。

2026-09-12 M07，协作 M06/M09：`UV-DISPLAY-MASK-WORKER` v1.1.0 将常驻 UV 的单通道 rendered-color mask 保存在既有 Preview Bitmap Worker，并仅按当前 GPU 上传条带即时展开 RGBA。UI 线程不再执行 4K 的 16,777,216 次 JS 像素循环或持有约 64 MiB RGBA 临时数组，Worker 也不再创建整张 RGBA 位图；GPU 仍使用原 RGBA texture 和分条上传，红通道、opaque alpha、Y 翻转、shader、完整分辨率、QA、持久化与导出字节语义不变。详见 [常驻 UV 蒙版 Worker 变更卡](changes/CHG-20260912-UV-DISPLAY-MASK-WORKER.md)。

2026-09-12 UI-05 → M03/M04：仅隐藏左侧“本组回贴后再生成下一组 / 等待回贴与合成渲染完成”长文本状态卡，其他普通状态、警告和错误正常显示。此变更仅影响 UI 呈现，不删除回贴/Resident UV/下一组屏障，不改写生图成功或失败判定，无 Schema、资产或迁移变更。详见 [渲染衔接变更卡](changes/CHG-20260912-GENERATION-RENDER-LIFECYCLE.md)。

2026-09-12 UI-05/UI-06 → M03/M04/M06/M07：`TEXTURE-RUNTIME-RESIDENCY` v1.5.0 将 Resident UV 合成从 `useFrame` 解耦：图层签名变更即由后台安全任务主动启动计算，不再等 Chromium 为 hidden 标签页或任务栏预览分配下一个 rAF。暂时失败只在当前精确签名上重试，前台交互仍让帧；不降低分辨率、不跳过 GPU 上传/材质提交/真实 Resident 屏障，像素、QA、持久化与导出不变。详见 [渲染衔接变更卡](changes/CHG-20260912-GENERATION-RENDER-LIFECYCLE.md)。

2026-09-12 UI-05/UI-06 → M03/M04/M06：`TEXTURE-RUNTIME-RESIDENCY` v1.4.0 将 LI3D 窗口失焦/被其他窗口遮挡也纳入后台渲染 lease，不再只依赖 `document.hidden`。生成持锁期间的 blur/focus/visibilitychange 会立即重评估，失焦时由 R3F `advance` 继续材质提交、Resident UV 和下一组快照屏障；获得焦点后停止额外定时帧。像素、分辨率、QA、持久化和导出语义不变。详见 [渲染衔接变更卡](changes/CHG-20260912-GENERATION-RENDER-LIFECYCLE.md)。

2026-09-12 UI-05/UI-06 → M03/M04：`GENERATION-AUTO-PROJECTION-NOTICE` v1.1.0 将自动投影恢复改为静默后台流程，不再弹出“图片已生成，正在重试自动投影”。五秒恢复轮询、原因去重、严格回贴屏障、投影/UV 像素、分辨率、QA、持久化和导出语义不变。详见 [自动投影提示去重变更卡](changes/CHG-20260912-AUTO-PROJECTION-NOTICE.md)。

2026-09-12 UI-05/UI-06 → M03/M04/M06/M07：`TEXTURE-RUNTIME-RESIDENCY` v1.3.0 将投影纹理数组预编译、GPU fence 轮询、UV 合成与 Runtime visibility 的裸 `requestAnimationFrame` 等待统一替换为后台安全 paint 调度；标签隐藏时解除仅用于保护前台交互的等待，不降低预编译、GPU 完成或像素正确性要求。修复帧 lease 已运行但材质构建内部仍可能停在 rAF 的第二层卡点。详见 [渲染衔接变更卡](changes/CHG-20260912-GENERATION-RENDER-LIFECYCLE.md)。

2026-09-12 UI-05/UI-06 → M03/M04/M06：`TEXTURE-RUNTIME-RESIDENCY` v1.2.0 修正浏览器标签页隐藏但仍停留在贴图路由时的渲染 lease 漏判：只要生成链路持锁，`document.hidden` 即由 R3F `advance` 驱动 WebGL/useFrame，站内隐藏路由继续使用 demand invalidate，前台贴图页不增加额外定时帧。解决后台保持白模、真实材质未呈现导致下一组等待的问题；严格回贴屏障、像素、分辨率、QA、持久化和导出不变。详见 [渲染衔接变更卡](changes/CHG-20260912-GENERATION-RENDER-LIFECYCLE.md)。

2026-09-12 UI-05/UI-06 → M03/M04：`GENERATION-AUTO-PROJECTION-NOTICE` v1.0.0 将已完成图片的自动投影恢复告警按“任务 ID + 原因”在当前运行时内只提示一次；五秒恢复轮询继续运行，错误原因改变可再次提示，投影成功后清理告警状态。修复缺少历史相机捕获时同一提示被周期性延长或反复弹出，不改变生成、投影、UV、分辨率、QA、持久化和导出语义。详见 [自动投影提示去重变更卡](changes/CHG-20260912-AUTO-PROJECTION-NOTICE.md)。

2026-09-12 M03/M04/M12：`LICLICK-ASSET-UPLOAD-RETRY` v1.0.0 对远端生图任务创建前的参考图 `upload_asset` 增加仅限瞬时网关、限流和传输故障的五次指数退避重试；认证、参数等永久错误立即失败，`generate_image` 不做盲重试，避免重复远端任务与费用。真实多视图后台链路已验证完成两组回贴、UV 合成并自动提交下一组，第三组原故障定位为 Atlas 上传 502，而非页面切换后的渲染屏障停摆。分辨率、QA、投影/UV 像素、持久化与导出语义不变。详见 [参考图上传重试变更卡](changes/CHG-20260912-LICLICK-ASSET-UPLOAD-RETRY.md)。

2026-09-12 UI-05/UI-06 → M03/M04/M06：`GPT-MULTIVIEW-PAIR-SEQUENCE` v1.2.1 / `TEXTURE-RUNTIME-RESIDENCY` v1.1.0 为隐藏且有生成任务的纹理运行时增加低频渲染 lease；同页模块切换唤醒 demand 帧，浏览器隐藏时由 R3F advance 推进 useFrame/Resident UV，且新合成请求显式唤醒首帧。修复“切回贴图界面才完成渲染并提交下一批”的遗漏；严格回贴屏障、像素、分辨率、QA、持久化及导出语义不变。详见 [渲染衔接变更卡](changes/CHG-20260912-GENERATION-RENDER-LIFECYCLE.md)。

2026-09-12 M05/M07/M11：`UV-LAYER-OBJECT-APPLICABILITY` v1.0.0 统一无 objectId 历史/global UV 在常驻显示、FBX、GLB/GLTF/OBJ 的对象适用规则，移除标准导出的二次严格筛选。层序、像素、分辨率、QA、GPU/CPU/Worker/shader、持久化不变，无迁移。详见 [global UV 导出变更卡](changes/CHG-20260912-GLOBAL-UV-EXPORT-PARITY.md)。

2026-09-12 UI-06/UI-10 → M05/M07/M08/M11：`LAYER-VISIBILITY-AUTHORITY` v1.0.0 将局部重绘投影行与实现 UV destination 的显隐关联迁入 `engine/layers`，眼睛、拖拽和快捷键统一原子切换；重复同值保持数组引用，避免无意义常驻 UV 重合成。图层 Schema/顺序、像素、分辨率、GPU/CPU/Worker/shader、QA、持久化及导出协议不变，无迁移。详见 [图层显隐变更卡](changes/CHG-20260912-LAYER-VISIBILITY-AUTHORITY.md)。

2026-09-12 UI-05/UI-06 → M03/M04/M06：`GPT-MULTIVIEW-PAIR-SEQUENCE` v1.2.0 / `TEXTURE-RUNTIME-RESIDENCY` v1.0.0 保留“远端生成 → 保存 → 回贴/合成实际渲染 → 下一组截图”的严格顺序。进入同项目 UV、重拓扑或烘焙时保持 Engine Session、Editor、GeneratePanel、场景与 WebGL 常驻；前台 always、后台任务 demand、后台空闲 never。浏览器标签页隐藏时由非 rAF 调度回退继续 Runtime depth/normal、投影与合成屏障；已成功结果不会因页面切换、材质驻留延迟或暂时网络错误被改写为生图失败。只有服务端明确失败、任务不存在、工程/模型切换或用户终止才失败/停止。GPU/CPU/Worker/shader、分辨率、QA、持久化和导出语义不变，无 Schema/资产迁移。详见 [渲染衔接变更卡](changes/CHG-20260912-GENERATION-RENDER-LIFECYCLE.md)。

2026-09-12 UI-06 → M03/M08：`ALG-VIEW-INPUT-001` v1.0.0 将鼠标输入固定为左键仅交给当前绘制/橡皮工具、中键平移、右键旋转、滚轮缩放；Ctrl/Cmd 不再把中键变为缩放，压感笔尾擦仍保留。未改相机数学、画笔/橡皮像素、GPU/CPU/Worker/shader、分辨率、QA、持久化或导出，无资产/Schema 迁移。测试与回滚见 [鼠标输入变更卡](changes/CHG-20260912-VIEWPORT-MOUSE-BUTTONS.md)。

2026-09-12 M07，协作 M06/M09：`PERF-UV-SOURCE-PREPARE-001` v1.5.0 在全静态、普通混合的常驻 GPU Top-K 栈追加图层时租用已完成的精确有序前缀，仅计算新增尾层；取消、失败、非前缀、overlay、live 或 context/scope 变化全部清空并完整重算。4K 真实 WebGL 冻结对照 RGBA/coverage/coveredPixels 差异 0，五层前缀命中时 source prepare 29.3→16.3ms；端到端样本 635.1→606.0ms，不能外推为所有工程。分辨率、QA、shader/Top-K、持久化及导出不变，无迁移。详见 [UV 聚合前缀变更卡](changes/CHG-20260912-UV-AGGREGATE-PREFIX.md)。

2026-09-12 M01/M02/M12/M15：`CLOUD-RUNTIME-BOUNDARY` v1.1.0 删除生产清单的 desktop/local-agent 合法值与非 Cloud CAS 旁路，并将 Cloud 边界扫描扩展到 Server/Contracts；依赖审计修复 7 high / 3 moderate。不恢复本地组件、4618、安装器、端点切换或本地凭据。Project Command、Revision CAS、ownership 与 verified assets 语义收紧但 Schema 不变，无资产迁移；外部发布能力未伪造为完成。审计、回滚及限制见 [Cloud 审计修复变更卡](changes/CHG-20260912-CLOUD-AUDIT-HARDENING.md)。

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


## 18. 修订历史

| 版本 | 日期 | 基线 | 变更 |
| --- | --- | --- | --- |
| `2.20.210` | 2026-09-20 | `c41882dc + 多层 UV 重绘显隐修复` | M06/M07/M08：UV-REPAINT-PREVIEW-BINDING v1.0.1 统一顶层/下层划分、显隐刷新和异步发布归属；像素、分辨率、QA 与保存/导出协议不变，无迁移。 |
| `2.20.209` | 2026-09-20 | `c0aa7595 + GPT 局部重绘轮廓来源修复` | M04/M03/M08/M12：取景改用冻结深度模型轮廓，避免不透明法线背景误判；严格返图 QA 保留，无历史迁移。 |
| `2.20.208` | 2026-09-20 | `后台生图结果交互安全发布` | M04/M03/M08/M15：大 JSON 和 Blob 编码移入 Worker，并在视口静默后发布；结果字节、完整分辨率、QA 与持久化不变，无迁移。 |
| `2.20.207` | 2026-09-20 | `4K 投影转 UV 交互帧调度` | M07/M06/M09/M15：收紧 detached 上传并将派生缓存验证移入 Worker，后处理及缓存写入跨真实 paint；精确 RGBA、拓扑、QA 与持久化不变，无迁移。 |
| `2.20.206` | 2026-09-20 | `Resident UV underlay 归属更新移出主线程` | M07/M06/M09/M15：UV-UNDERLAY-ATTRIBUTION/1.0.0 复用既有 WebGPU/CPU Worker 更新 R8 attribution，移除主线程双遍历和 4K alpha 临时数组；逐字节输出、完整分辨率、QA 与持久化不变，无迁移，未部署。 |
| `2.20.205` | 2026-09-20 | `实时 UV 主线程位图失败清理` | M07：UV-COMPOSITE-BITMAP-LIFETIME/1.0.2，失败收敛与迟到位图释放；成功并行、全尺寸像素和所有权保持，无数据迁移，未部署。 |
| `2.20.204` | 2026-09-20 | `后台监控与 UV 异常路径修复` | M10/M13、M07：四个独立故障边界修复及回归；像素/尺寸/QA/持久格式不变，无数据迁移，未部署。 |
| `2.20.203` | 2026-09-20 | `412dc066 + 单视图完成保存去重` | UI-05/M04：SINGLE-VIEW-COMPLETION v1.0.0，复用本次回贴保存确认，去掉单视图收尾重复保存与时间改写；失败/删除/多视图保留 checkpoint，无数据迁移，未部署。 |
| `2.20.202` | 2026-09-20 | `3eb751af + Resident UV R8 archive` | M07（协作 M06/M09/M15）：`UV-CONTRIBUTION-ARCHIVE` v1.1.0 将会话逐层贡献的 quality 由冗余 RGBA 改为四值 GPU 打包、R8 恢复，原始 payload 由每像素 8→5 字节；兼容旧 RGBA 记录。65–4096 WebGL 显隐/重排/archive restore 逐字节一致；完整分辨率、Top-K、QA、Project/Revision/CAS/ownership/verified assets 与导出不变，无迁移。 |
| `2.20.201` | 2026-09-20 | `7ab72ebf + ModelView 回贴屏障` | M04/M03/M06/M07：MODELVIEW-PRESENTATION-BARRIER v1.0.0，按对象与新图层实际材质绑定确认回贴，修复原位材质更新漏事件导致串行停滞；无像素/Schema 迁移，未部署。 |
| `2.20.200` | 2026-09-20 | `90eb9ab8 + 高模导入合并顶点` | M02/M10/M13：IMPORT-DECIMATE v1.1.0，超过 150 万面导入经确认后先逐对象按距离合并，再按合并后面数执行原减面；保留面积与回读 QA，无历史迁移，未部署。 |
| `2.20.199` | 2026-09-20 | `46df32c6 + 单视图返图混合` | M04/M13：SINGLE-VIEW-RESULT-BLEND v1.0.0，原远端蒙版不变，冻结视角的 N·V 渐变仅在返图后混合；保存最终/原图/底图/权重，旧请求兼容，无历史迁移，未部署。 |
| `2.20.197` | 2026-09-20 | `橡皮擦 GPU 会话复用与数组调度` | M08（协作 M06/M07/UI-06/UI-10）：`ALG-ERASE-001` v1.5.7 / `UV-DISPLAY-BUFFER` v1.5.5 / `ALG-PROJ-007` v2.1.14 将同模型+分辨率的已编译 `UvRepaint` 在安全交接后转移至下一投影层，并将空闲 texture-array 条带从 rAF 改为 task 让步。13 层数组构建约降 87%，26 次切层 0 重建，4K 首笔提交 5.8ms；分辨率、像素、QA、持久化/export 不变，无迁移。 |
| `2.20.196` | 2026-09-18 | `Resident UV 恢复缓存稳定化` | M06/M07/M09：`UV-DISPLAY-DERIVED-CACHE` v1.2.0 将派生磁盘窗口从固定两条改为最多四条并增加 256MiB 压缩总预算，固定当前显示/新写状态，消除 A/B/C 工程恢复循环 miss；缓存键、像素、QA、作者资产与 export 不变。 |
| `2.20.195` | 2026-09-18 | `Resident UV 派生键并行准备` | M06/M07/M09：`UV-PERSISTENT-MERGE-KEY` v1.1.0 将实际几何字节 SHA 改为 2 路有界队列，并与既有 3 路来源资产校验重叠；键值、像素、质量、持久化/export 与失败回退不变，无迁移。 |
| `2.20.194` | 2026-09-18 | `多层橡皮一次驻留快速切层` | M08（协作 M06/M07/UI-06/UI-10）：`ALG-ERASE-001` v1.5.6 / `UV-DISPLAY-BUFFER` v1.5.4 将 WebGL2 多视图作者 texture-array 在完整恢复后一次性后台驻留，并为每层预留 keep-mask slice；实时 multiplier 在 GPU 内原位乘入/替换 slice，中性状态、mask URL 与 live Canvas revision 均不再重打包整组作者数组。六层 18 次切层、30 次落笔、4 次撤销+4 次重做通过，Resident revision 不变；无 Schema/资产迁移。 |
| `2.20.193` | 2026-09-18 | `多视图橡皮 texture-array 快速路径` | M08（协作 M06/M07/UI-06/UI-10）：`ALG-ERASE-001` v1.5.5 / `UV-DISPLAY-BUFFER` v1.5.3 提前武装完整分辨率 live keep-mask，并在预算安全时复用 texture-array 作者栈；交互禁止 Resident UV。无 Schema/资产迁移。 |
| `2.20.192` | 2026-09-18 | `橡皮交互禁用 Resident UV` | M08（协作 M06/M07/UI-06/UI-10）：projected-mask 橡皮拖动仅更新 GPU live keep-mask；Resident UV draft 不再逐输入 revision 重算，新笔迹会取消尚未发布的最终收敛。多图层不改变快速路径；无 Schema/资产迁移。 |
| `2.20.191` | 2026-09-18 | `投影橡皮实时快速显示恢复` | M08（协作 M06/M07/UI-06/UI-10）：空闲保持 verified UV-only；活动普通投影橡皮或提交交接临时恢复预算安全的 exact direct 栈，实时采样完整分辨率 GPU keep-mask。预热不夺取显示，预算失败保持 Resident UV；无 Schema/资产迁移。 |
| `2.20.190` | 2026-09-18 | `手动上传单文件 100MB 上限` | USER-FILE-UPLOAD/1.0.0：浏览器入口在读取与上传前拦截超限文件，内部资产/自动保存不改，无迁移。 |
| `2.20.189` | 2026-09-18 | `原局部重绘轮廓内缩 3px` | M08：ALG-LR-013 v1.2.0，3px@2K，保留历史 v1 与新 v2 alpha；GPT 不变，无迁移。 |
| `2.20.188` | 2026-09-18 | `生图完成后蒙版按钮压力回归` | M08（协作 M03/M04/M06）：`INPAINT-TOOL-SESSION/1.0.1` 在内置浏览器完成普通 30 轮及单/多视图完成态 20 轮生产视口压力验证；累计 56 图层仍可逐轮落笔且坐标稳定，无迁移。 |
| `2.20.187` | 2026-09-18 | `GPT 回图比例 QA 与续跑` | M04（协作 M03/M06/M08/M12/M13）：`GPT-CONTENT-FRAMING/2.2.1` 只按真实比例拒绝回图；`GPT-MULTIVIEW-PAIR-SEQUENCE/1.4.1` 仅对已识别 QA 缺失继续后续组，其他失败仍停止；不关闭轮廓 QA、不改原生像素，无迁移。 |
| `2.20.186` | 2026-09-18 | `容器依赖引导重试` | M15：`CI-CONTAINER-DEPENDENCY-RETRY/1.0.0` 为 Docker 固定 pnpm 准备和冻结安装增加最多 3 次的有限重试；连续失败仍阻断，无运行时或数据迁移。 |
| `2.20.185` | 2026-09-18 | `Bake 下载异步 metadata` | M10/M13（协作 M15）：`BAKE-DOWNLOAD-METADATA/1.0.0` 移除单图/ZIP HTTP 热路径同步 exists/stat，保持 owner、成功终态、通道、普通文件和归档字节门禁；无迁移。 |
| `2.20.184` | 2026-09-18 | `Bake Job 异步原子持久化` | M10/M13（协作 M15）：`BAKE-JOB-PERSISTENCE/1.0.0` 以同 Job 串行、不同 Job 并行的异步原子替换保存 `job.json`，终态显式等待；故障注入验证失败保留上一完整快照且队列可恢复。状态/JSON/资产/Schema 不变，无迁移，未推送部署。 |
| `2.20.174` | 2026-09-17 | `GPT 轮廓漂移有界重试` | M04（协作 M03/M06/M08/M12/M13）：`GPT-RETURN-SILHOUETTE-QA/1.2.0` / `GPT-SILHOUETTE-RETRY/1.0.0` / `ALG-GEN-001/002` v1.3.1 保留轮廓门禁，仅对确认的远端构图漂移使用同冻结视角和确定性 ID 替代 1 次，再失败即停止；无数据迁移。 |
| `2.20.173` | 2026-09-17 | `导入智能 UV 投射` | M02/M10/M13：IMPORT-UV-REPAIR v1.2.0，临时工作网格投射后仅回写 UV；无数据迁移。 |
| `2.20.172` | 2026-09-17 | `多视图光照处理` | M04/M12/M13：REFERENCE-LIGHTING v1.0.0 一次去光照，REFERENCE-GROUP-BINDING v1.2.0 原位保留绑定；无数据迁移，未推送部署。 |
| `2.20.171` | 2026-09-17 | `移除导入自动减面` | M02/M10/M13：IMPORT-DECIMATE retired，IMPORT-UV-REPAIR v1.1.0 保留明确确认的 UV 修复；恢复处理前 200 万面门禁，浏览器边界/UV 回归、Server UV 测试及 Web 类型检查通过，无迁移，未推送部署。 |
| `2.20.170` | 2026-09-17 | `d745d066 + Asset 历史并发稳定性` | M13（协作 M10/M15）：`ASSET-HISTORY-REFRESH/1.0.0` 为 UV/拓扑非终态远端刷新增加进程级全局 8、单用户 4 的并发上限、同用户/Job in-flight 合并与 2.75 秒 HTTP 等待预算；严格 TLS 并发冒烟通过。持久记录、ownership、Asset API/TLS、Schema 与产物语义不变，无迁移。 |
| `2.20.166` | 2026-09-17 | `32ad28ce + 多用户并发稳定性续优化` | M13/M10/M15：`BAKE-HISTORY-LIST/1.1.0` 合并同时到达的目录扫描，按 owner 建批次索引，异步读取输出 metadata 并逐任务限制 I/O 扇出；10 身份、34 任务、40 并发请求隔离冒烟通过。保留 `IMPORT-UV-REPAIR/1.0.0`。无 Schema、资产或数据迁移。 |
| `2.20.165` | 2026-09-17 | `32ad28ce + Bake 产物续优化` | M10/M13/M15：`BAKE-ARTIFACT-IO/1.1.0` 异步化远端 Bake 缓存检查、Base Color access 与 PNG 文件头验收；输出字节、SHA、尺寸、失败门禁和持久化格式不变，无迁移。 |
| `2.20.164` | 2026-09-17 | `32ad28ce + 历史稳定性补丁` | M13/M15（协作 M10）：`BAKE-HISTORY-LIST/1.0.0` 将 Bake 历史目录与 Job JSON 改为最多 8 路异步有界读取；`ASSET-TRANSFER-TEST-PORT/1.0.0` 避开 Fetch 禁止端口造成的随机测试失败。同步当前分辨率、投影/输入版本和提供方文档。无算法像素、Schema、资产或数据迁移。 |
| `2.20.83` | 2026-09-14 | `6f26336 + 本次六视图模板更新` | M04/UI-05、`MULTIVIEW-REFERENCE-PROMPT` v1.1.0：使用用户确认的 Base Color / Albedo 模板去除参考光影，保留材质纹理、六视图布局、补充要求和旧结果复用。无数据迁移；实际生图效果另行验收。 |
| `2.20.81` | 2026-09-12 | `c1b948f + 本地待提交` | `ALG-ERASE-001` v1.5.1 / `UV-DISPLAY-BUFFER` v1.3.1：当前 projected 层常驻预热中性 GPU mask 与 exact stack；异步准备期间的首笔屏幕段在接管前完整补放，活动手势无缝继续，已完成手势不回弹。图层/模型/分辨率变化释放重建；Schema/资产不变，无迁移。同步验证 #630458 对应的 projection-performance 共享预算门禁。见 CHG-20260912-ERASER-RESIDENT-PREWARM。 |
| `2.20.80` | 2026-09-12 | `251700e + 0c0ff44` | `GPT-MULTIVIEW-PAIR-SEQUENCE` v1.4.0：固定 2+4 分组并发并整合生成区布局；同时保留 `ALG-ERASE-001` v1.5.0 的全分辨率 GPU 跟手蒙版。投影/UV/export、分辨率、质量与资产协议不变，无迁移。见 CHG-20260912-GENERATION-ACTION-FAST。 |
| `2.20.79` | 2026-09-12 | `ec629a7 + 本地待提交` | UI-06/UI-10 → M08，协作 M06/M07，`ALG-ERASE-001` v1.5.0 / `UV-DISPLAY-BUFFER` v1.3.0：projected 橡皮以项目完整分辨率 GPU keep-mask 增量盖章并接入安全 exact stack，交互期不再执行 Resident 全图重合成/readback/Worker/整图上传；修复 V 轴镜像。512 仅为不可见持久化草稿，GPU 失败回退完整分辨率 Canvas。Schema/资产不变，无迁移。见 CHG-20260912-ERASER-GPU-MASK。 |
| `2.20.78` | 2026-09-12 | `0a6835e + 本地待提交` | UI-01 → M03：工具箱顶部 LI3D Logo 复用已有 `openHome` 导航，点击或键盘激活均返回功能主页；工具下载、登录、算法、Schema 与资产不变，无迁移。见 CHG-20260912-TOOLBOX-LOGO-HOME。 |
| `2.20.76` | 2026-09-12 | `ac7cccb + 本地待提交` | M07，协作 UI-06/M06/M09，`PERF-UV-SOURCE-PREPARE-001` v1.10.0：同次 bake 私有纹理共享一次最终双帧发布屏障，不再每张重复等待；512/13 图层三轮配对约提升 47%，所有冻结对照零像素差，4K 样本基本持平。公开缓存、detached、交互和发布门禁不变，无迁移。见 CHG-20260912-UV-SOURCE-BATCH-PRESENTATION。 |
| `2.20.75` | 2026-09-12 | `b52561a + 本地待提交` | M07，协作 UI-06/M06/M09，`PERF-UV-SOURCE-PREPARE-001` v1.9.0：可见 renderer 在健康 4ms 累计预算内连续提交精确条带，不再逐条带强制宏任务等待；交互/拥塞/呈现门禁、detached 让步与像素协议不变。4K 三轮配对均值约提升 3.3%，逐像素差为 0。无 Schema/资产迁移。见 CHG-20260912-UV-VISIBLE-UPLOAD-BATCHING。 |
| `2.20.74` | 2026-09-12 | `本地待提交` | UI-06 → M06/M09，`UV-DISPLAY-DERIVED-CACHE` v1.2.0：完整像素签名作为显隐缓存身份，精确命中同步复用，只允许当前请求的完成纹理入缓存，禁止跨显隐状态展示旧 UV。无 Schema/资产迁移。见 CHG-20260912-UV-VISIBILITY-EXACT-CACHE。 |
| `2.20.73` | 2026-09-12 | `本地待提交` | UI-05 → M04/M08，`REFERENCE-GROUP-REUSE` v1.0.0：再次选择单视图时复用同 `referenceGroupId` 的现有多视图；多视图被手动删除后才重新生成并重建绑定。Project Command、Revision CAS、ownership、verified assets 与 Schema 不变，无迁移。见 CHG-20260912-REFERENCE-GROUP-REUSE。 |
| `2.20.63` | 2026-09-12 | `7d449d7 + 本次并发切换` | 多视图稳定/加速按钮，默认 2 张，加速首组 2 张后续最多 4 张；保留输入冻结、定序回贴、失败和驻留屏障，设置可选字段兼容旧工程。集成远端常驻 UV、图层交互、画笔性能及包体优化；最终提交须通过 verify:prepush 后方可推送部署，未进行付费生图或实际速度验收。 |
| `2.20.53` | 2026-09-12 | `本地待提交` | 仅收短多视图主按钮的提交/回贴等待长标题为组数与百分比；普通文本、错误和内部屏障不变。见 CHG-20260912-GENERATION-RENDER-LIFECYCLE |
| `2.20.52` | 2026-09-12 | `本地待提交` | 精确 UV 聚合结果在原硬内存预算内保留最多两个 LRU 状态，减少图层眼睛 A/B 往返的重复 GPU 合成与读回；第三状态及所有失效边界保持严格。见 CHG-20260912-UV-AGGREGATE-PREFIX |
| `2.20.51` | 2026-09-12 | `本地待提交` | 局部重绘视口蒙版画笔与独立画布画笔默认大小统一为 15，用户调整范围、压感、羽化、保存与输出公式不变。见 CHG-20260912-LOCAL-REPAINT-BRUSH-DEFAULT |
| `2.20.50` | 2026-09-12 | `本地待提交` | Preview Bitmap Worker 仅按 GPU 上传条带展开 rendered-color mask，不再持有整张约 64 MiB RGBA 临时位图；逐条带 Y 翻转和像素格式保持。见 CHG-20260912-UV-DISPLAY-MASK-WORKER |
| `2.20.49` | 2026-09-12 | `本地待提交` | 常驻 UV rendered-color mask 的 RGBA 展开和位图创建迁入 Preview Bitmap Worker，移除 UI 主线程 4K 像素循环与约 64 MiB 临时 RGBA 数组；GPU/shader/像素和分条上传格式不变。见 CHG-20260912-UV-DISPLAY-MASK-WORKER |
| `2.20.44` | 2026-09-12 | `本地待提交` | 投影数组预编译、GPU fence、UV 合成和 Runtime visibility 的裸 rAF 等待改为后台安全调度；hidden 时不再被前台交互保护锁阻塞。见 CHG-20260912-GENERATION-RENDER-LIFECYCLE |
| `2.20.43` | 2026-09-12 | `本地待提交` | 修正贴图路由仍 active 但浏览器标签页 hidden 时未启用 WebGL/R3F 帧 lease 的漏判；前台无额外帧开销。见 CHG-20260912-GENERATION-RENDER-LIFECYCLE |
| `2.20.42` | 2026-09-12 | `本地待提交` | 自动投影恢复告警按任务和原因只提示一次，后台恢复轮询保持运行，成功后清理提示状态。见 CHG-20260912-AUTO-PROJECTION-NOTICE |
| `2.20.41` | 2026-09-12 | `本地待提交` | 生图任务创建前的参考图上传对 408/429/5xx 与瞬时传输故障执行有限退避重试；永久错误立即失败，禁止盲重试 generate_image。见 CHG-20260912-LICLICK-ASSET-UPLOAD-RETRY |
| `2.20.40` | 2026-09-12 | `本地待提交` | 后台生成渲染 lease 修复切回贴图才推进下一批；global UV 跨导出对象适用规则统一。见 CHG-20260912-GENERATION-RENDER-LIFECYCLE、CHG-20260912-GLOBAL-UV-EXPORT-PARITY |
| `2.20.39` | 2026-09-12 | `本地待提交` | 局部重绘展示层/实现 UV 层显隐权限统一到领域层，快捷键与眼睛原子一致，同值 no-op 避免常驻 UV 重算。见 CHG-20260912-LAYER-VISIBILITY-AUTHORITY |
| `2.20.38` | 2026-09-12 | `本地待提交` | 同项目纹理生成/投影/合成运行时跨 UV、重拓扑、烘焙与后台标签页常驻；前台 always、后台任务 demand、空闲 never；严格呈现屏障不降级。见 CHG-20260912-GENERATION-RENDER-LIFECYCLE |
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


## Master records retained during migration (2026-09-22)

Source: `c2ef76672a28e494fcf8322042d2cb96996b50fe`. The records below are preserved verbatim; their local/published status describes the original recording time. Current contracts are summarized in the corresponding standard sections.

2026-09-22 M04/M13/M12：`MODELVIEW-REFERENCE-ROUTING/2.0.0` 与 `REFERENCE-LIGHTING/2.0.0`，单视角/多视角贴图及局部重绘按参考角色统一使用 inpaint API，显式 1/6；导入参考后台去光照、隐式绑定、生成等待、恢复去重及离开中断确认。无像素算法迁移；可选处理标记和私有索引保持旧项目兼容。验证、预算、迁移与回滚见 [变更记录](changes/CHG-20260922-MODELVIEW-REFERENCE-LIGHTING.md)。本地修改，未部署。


2026-09-22 M04/M08：`GPT-RETURN-BACKGROUND-CLEANUP` v1 仅在 v2 返图透明边界 QA 失败后尝试 alpha 八连通分量清理。主体占全部非零 alpha 至少 80% 且主体独立通过原严格边界容差；仅移除触及画布边缘、至少 90% 像素位于预期包围盒外 2px 的独立分量，删除总量不得超过主体 10%。弱 alpha 桥接也视为相连；不按 RGB 删除，不裁原蒙版，不移动缩放返图；清理后原 QA 再验。超过 4096² 或 4096 分量不自动修复；协作取消、失败不改原远端资产。清理像素用于恢复画布，随后 GPU/CPU/Worker 投影及保存导出沿用同一结果；无 Schema/资产迁移。回滚移除恢复入口的清理重试即可。此保守方案不保证修复贴近主体/连通黑边或不透明白底。未拿到用户原始异常 PNG，验证采用合成透明返图。

2026-09-22 UI-05 / M04：`GENERATION-SERVER-DISPLAY` v1.1.0 按用户要求移除生图进度中的服务器来源行及其展示组件，不再因进度展示发起服务器标签查询。保留进度文案、计时、任务请求与路由；无图像算法、Schema 或资产变化，无迁移。回滚恢复展示组件及挂载即可。本地修改，未部署。

2026-09-22 M15 发布集成：`BUILD-STRING-POOL` v1 仅在构建 chunk 内复用重复的长字符串值（至少 64 字符），AST 限定值位置，不修改文本内容、属性名、模块路径、指令或业务公式，无运行时解压/跨包依赖。服务器来源显示抽为同包组件，生命周期不变；旧并行准备源码断言同步。保留现有压缩参数/预算，实测总 JS 3,258,492/3,262,000，编辑器 497,785/499,624 bytes。等价性测试覆盖 Unicode/转义/属性及生产压缩；无数据迁移，回滚移除构建插件并恢复组件内联。

2026-09-22 M08/M04：`LOCAL-REPAINT-SAMPLING-MASK` v2 取消原局部重绘提交蒙版的额外外扩及向外模糊，dilationRadius/featherRadius 均为 0，元数据同步；有效选区并集、白色填充、可见面裁切及历史兼容的核心选区处理不变。仅 local Worker 分支改变，单/多视图补全保留原半径公式，GPT 原本不额外外扩，画笔/橡皮羽化、回贴 GPU/CPU/Worker、保存导出不变。无资产迁移，旧请求不重写；回滚恢复 local 半径公式。测试检查 local 半径为零及选区外提交像素为零。本地修改，未部署。

2026-09-22 M08（协作 M03/M04）：`REPAINT-INPUT-PREPARE` v1.0.0 在原局部重绘提交前，将已冻结输入的 CPU Worker 融合/PNG 编码与唯一 GPU 法线捕获并行；效果图/深度捕获仍顺序，GPT 原流程不变。两分支全部结算后才返回，失败/取消清理成功分支生成的临时 URL，不提前释放提交锁。保留 2K、冻结相机、黑/蓝背景、蒙版并集/外扩/羽化/纯白填充、GPU/CPU/Worker 像素算法及保存导出协议；新增 Worker 各阶段耗时诊断。无资产/Schema 迁移，回滚恢复融合后采法线。测试验证并行启动、原结果身份、失败等待及取消清理；未宣称真实项目端到端提速幅度。本地修改，未部署。

2026-09-22 M15（审计 M06/M08）：`SHADER-TEMPLATE-FORMAT` v1.4.2 将既有构建期 GLSL 空白压缩白名单扩展至 ProjectedLayerPreviewCompositor、projectedSelectionDisplay、projectedSelectionPreview。逐模块比较 JS 叶节点及 GLSL token/预处理指令，保留插值分隔、注释和换行保护规则，不修改公式、分辨率、QA、UI、CPU/Worker、持久化或导出协议；不提高包体预算。无数据迁移，回滚移除三个白名单入口及对应测试即可。

2026-09-22 M06（协作 M07/M09）：`PROJECTION-RELIABLE-FOOTPRINT` v1.1.0 按用户确认将综合几何覆盖门槛从 0.98 放宽至 0.90，保留 minimumProjectionFacing、深度遮挡、背面保护及 surface-locked 重绘分支。单层/多层/compact array/预览合成/GPU UV 与 CPU loose fallback 共用阈值，作者 alpha/蒙版不变，Worker 沿用栅格结果。UV bake 协议 10、UV merge 13、内容修补投影缓存 v3 排除旧派生结果；既有合并 PNG 不重写，无 Project/Layer Schema 或资产迁移。回滚恢复阈值及缓存版本；刷新后普通投影重新计算，已合并贴图需从原投影图层重新合并才能体现新范围。本地修改，未推送或部署。

2026-09-22 M04/M15 发布集成：合并 master e04c3f38 后 JS 实测 3,260,798、编辑器 499,080 bytes；有界增加总预算 5,500、编辑器 600 bytes，保留 256-byte 余量及其他质量门禁。两处测试全局引用修正；无业务/Schema 变化。详见 [可见缺口合并发布记录](changes/CHG-20260922-LOCAL-REPAINT-VISIBLE-GAPS.md)。

2026-09-22 M04 / M08 / M15：GENERATION-SERVER-DISPLAY/1.0.0 在生图进度中显示服务来源，ModelView 三入口分别查询已有鉴权 status 接口，仅展示配置 URL 的 host；个人任务显示实例标识，莉刻任务注明算力节点未公开，失败显示信息不可用。查询不阻断生图，切换任务取消旧查询；无图像算法、Schema、Command/CAS/export 变化，无迁移，回滚展示组件及查询函数即可。
2026-09-22 M04（协作 M03/M06/M07/M08/M09/M12）：`LOCAL-REPAINT-VISIBLE-GAPS/1.0.0` 将 ModelView 局部重绘手绘选区与同冻结视角可见未贴图区域合并。复用覆盖 alpha 和 packed depth，不按 RGB 判空，排除背景/孔洞；白色输入、采样蒙版和未外扩回贴选区一致绑定，保留 live 手绘选区。深度前移并复用，Worker 合成，GPU/shader、分辨率、QA、Schema/Command/CAS/ownership 与历史像素不变，无迁移；回滚恢复手绘输入。151 项回归、2K 实际浏览器 PNG 像素检查、类型/构建/包体通过；详情与对等审计见 [可见缺口合并](changes/CHG-20260922-LOCAL-REPAINT-VISIBLE-GAPS.md)。本地修改，未推送或部署。

2026-09-22 CHG-20260922-UV-REPAINT-ERASER-LIVE：M08/M06/M07/M09，ALG-ERASE-001 显示生命周期 UV-ERASER-LIVE/1.0.0。完整 UV 源就绪后启用局部重绘图层实时橡皮擦预览，保留占位图保护，修正预览撤销/重做与连续笔迹初始化。1K/4K 真实浏览器回归通过；像素公式、Worker、导出、Schema 与持久化版本不变，无迁移；测试限制与回滚见对应变更卡。

2026-09-22 CHG-20260922-REPAINT-FRINGE-ERASER：M06/M08/M07/M09，ALG-ERASE-001 显示生命周期 UV-ERASER-LIVE/1.1.0；修正半透明 UV 的白膜底色泄漏，排除 native 重绘重复普通擦除预热，恢复 UV 实时刷新使用完整分辨率脏区上传。持久化版本/Schema 不变，无迁移；验证、现有测试失败与回滚见对应变更卡。

## 2026-09-23 origin/release 合并补录

2026-09-23 master/release 集成（M15，`CLOUD-DEPLOYMENT` v1.0.0）：将已通过 master 流水线 #636940 的 `673e93ff` 合入 `release`，保留线上 `ca092b08` 的 Ceph SHA-256 验证、数据库、对象存储、K8s/Nginx、IDaaS 与资源配置。资产传输回归保留 release 的完整性检查及 master 的 Fetch 禁止端口规避；维护记录保留双方历史。本次集成不新增算法语义、Schema 或资产迁移，业务版本与缓存失效规则沿用 master 各变更卡，完整分辨率、QA、Command/CAS/ownership/verified assets 不放宽。最终合并提交必须通过完整 verify:prepush 后以 `[deploy]` 推送；server/web/db-push 使用相同不可变 SHA，部署后核对流水线及正式站 release/health/ready。失败时整组回滚到 `ca092b08` 镜像，保留数据库、对象资产和 PVC；此条不预先宣称部署成功。

2026-09-16 master/release 集成（M15，`CLOUD-DEPLOYMENT` v1.0.0）：将 `master` 提交 `0bb0e6ec` 合入 `release`，保留 release 现有 K8s、Nginx、数据库、对象存储、Ceph 完整性、IDaaS 与资源配置。业务源码采用 master 的视口输入、投影选区显示、局部重绘、生成稳定性和 UV 性能修复；完整分辨率、QA、Project Command、Revision CAS、ownership、verified assets、持久化与导出约束不放宽，无 Schema 或资产迁移。最终 release 合并提交以 `[deploy]` 触发 server/web 同一不可变 SHA 镜像与串行部署；失败时 server/web/db-push 一同回滚到 `35db5bc4` 对应镜像，保留数据库、工程、对象资产和 PVC。线上结果以 release 流水线及 `/api/release`、health、ready 核验为准。

2026-09-14 master/release 集成（M15，`CLOUD-DEPLOYMENT` v1.0.0）：master 流水线 #631284 对提交 `ba5954d8` 的 verify、build、containerize 全部通过后，将该提交正常合入 release；保留 release `ad569f3` 的生产 K8s、Nginx、Ceph 完整性、对象存储、数据库、IDaaS 和部署资源配置。投影仍只作为生成 UV 的输入，视口仅发布已验证 UV；完整分辨率、Top-K、QA、Project Command、Revision CAS、ownership、verified assets、持久化与导出不放宽。release 合并提交以 `[deploy]` 触发同一不可变 SHA 镜像和串行部署；失败时回滚至 `ad569f3` 对应镜像，保留数据库、工程、对象资产和 PVC，无 Schema 或资产迁移。

2026-09-12 master/release 集成（M15，`CLOUD-DEPLOYMENT` v1.0.0）：在 master 流水线 #630472 对提交 `6f263364` 的 8 项 verify/build/container 检查全部通过后，将 `origin/master` 合入 release；保留 release `b8b3644` 的生产 K8s、Nginx、Ceph 完整性、对象存储、数据库和部署配置。业务源码与算法版本采用 master 变更卡，Project Command、Revision CAS、ownership、verified assets、完整分辨率和 QA 不放宽，无新增 Schema 或资产迁移。release 提交以 `[deploy]` 触发 server/web 同一不可变 SHA 镜像和 K8s 串行发布；失败时 server/web/db-push 一同回滚至 `b8b3644` 对应镜像，保留数据库、工程、对象资产和 PVC。线上结果以 release 流水线及 `/api/release`、health、ready 核验为准。

2026-09-11 master/release 集成（M15，CLOUD-DEPLOYMENT v1.0.0）：本次发布合入 master c0bef7f，保留 release d58e414 的生产资源、Nginx、Ceph 完整性校验及对象存储配置。仅维护文档发生冲突，双方记录均保留；业务算法和缓存版本沿用对应变更卡，无新增 Schema 或资产迁移。最终 release 提交须通过正式包体检查及 CI，部署结果以上线 SHA 与健康检查为准。失败时将 server/web/db-push 一同恢复至 d58e414 镜像，保留数据库、工程、对象资产和 PVC。

2026-09-10 master/release 集成（M15）：合入已通过 CI #629195 的 master 71216521；保留 release b226dfb 的 Ceph 校验、生产对象存储、数据库与部署配置。仅维护文档存在合并冲突，两侧记录均保留。算法版本与缓存版本沿用 master 各变更卡，无新增 Schema 或资产迁移；发布失败可恢复 b226dfb 对应镜像，保留现有工程与资产。实际发布结果以本次 release 流水线及线上版本核验为准。

2026-09-08 master/release 集成（M15）：合入 master a112655，包括 b374a9f/a0093a3 橡皮材质驻留交接、a7fa3b9 GPT2 提示词和 a112655 远端多视图逐视角生成；完整保留 release f3870f3 的 Ceph 流式 SHA-256 校验、内网 RGW 配置和生产部署基础设施。仅维护文档产生合并冲突，业务代码保持各分支已提交实现。算法版本沿用各变更卡，无新增 Schema 或数据迁移；回退整批镜像时保留 Ceph 修复与生产配置，已有工程/资产不删除。集成本地验证：88 项 Web/14 项 Server 回归、全仓 typecheck、lint（0 errors，15 条既有 warnings）、6 项部署策略、contracts/边界检查与完整 Cloud 构建通过；80 chunks / 3,133,800 bytes，通过原包体门禁，OAuth/资产/重启部署模拟通过。Ceph 前一批 f3870f3 的 CI #627368（含 deploy）已全部成功；本次新增功能的生产部署和真实项目验收以新流水线与维护者实测为准。

变更卡 `CHG-20260908-CEPH-SHA256-READBACK`：M14，协作 M02/M15，`ALG-ASSET-VERIFY-001` v1.1.0。基于 release de1507c 保留效率组内网 RGW/公开浏览器地址分离。缺少附加 checksum 时流式读回验证实际 SHA-256；每进程最多 4 项执行、16 项等待，60 秒预算含排队/HEAD/GET，同用户同资产完成请求合并；前端完成接口等待上限 75 秒，校验完立即返回。完整性失败仍保持 pending，不放宽 verified、ownership、Revision CAS 或 Command 幂等性。线协议 v1/Schema 不变，无迁移；回退会恢复旧 Ceph 拒绝，但保留资产数据。真实 Ceph 与生产体验待验收，详见对应变更卡。

| `2.20.99` | 2026-09-14 | `ad569f3 + ba5954d8` | M15 release 集成：master 流水线 #631284 的 verify/build/containerize 全部通过后正常合入 release，保留生产部署、对象存储、数据库、IDaaS 和资源配置；以 `[deploy]` 触发不可变 SHA 发布。算法、完整分辨率、QA、Schema、CAS、ownership、verified assets 与导出不放宽，无迁移；失败回滚至 `ad569f3`。 |

| `2.20.83` | 2026-09-12 | `b8b3644 + 6f263364` | M15 release 集成：master 流水线 #630472 全绿后合入 release，保留既有生产 K8s/Nginx/Ceph/对象存储/数据库部署链；以 `[deploy]` 发布 server/web 同一不可变 SHA。算法语义、完整分辨率、QA、Schema、CAS、ownership 与 verified assets 不变，无迁移；失败时整组回滚至 `b8b3644`，保留数据库、工程资产和 PVC。 |

2026-09-09 release 集成（M15）：合入 master 942417c，保留 release dff6ba6 的 Ceph 完整性验证、生产配置及部署策略。算法版本沿用各变更卡，不新增 Schema 或数据迁移。UV 90% 等待和复杂图层交互峰值仍列为下次优化，未宣称零卡顿。回滚使用上一 release dff6ba6 的前后端同版本镜像，保留生产数据与资产。发布结果以本次 release 流水线及部署核验为准。

2026-09-09 release 增量发布（M15/M04）：同步 master 405f7f51 的 MODELVIEW-CONNECTION-LIFECYCLE v1.0.1 修复，保留 release 8a6d0e21 的生产配置及 Ceph 验证。无新增算法语义或数据迁移；回退前后端至 8a6d0e21 同版本镜像，保留工程和资产。
