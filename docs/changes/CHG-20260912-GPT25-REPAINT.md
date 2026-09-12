# GPT 2.5 纹理生成与局部重绘

后续配套：透明背景参数与单/多视图源 Alpha 已由 [CHG-20260912-GPT-TRANSPARENT](CHG-20260912-GPT-TRANSPARENT.md) 接通；下文“待单独接通”属于此前阶段的验证记录。

输出参数后续调整：按 [CHG-20260912-GPT-OPTIONS](CHG-20260912-GPT-OPTIONS.md)，三个 GPT 入口均跟随顶部 1K/2K/4K，并开放五档质量；下文局部输出固定 2K 的描述属于此前版本，不再是当前规则。

- 状态：本地实现与验证，未部署；负责人：Li3D 维护者 / 本次 Codex 实施。
- 主模块：M04 生成、M08 局部重绘；协作：M03 截图、M12 持久化、M13 账号身份。
- 算法：`GPT25-TEXTURE-GENERATION/1.0.0`、`GPT-REPAINT-GUIDE/1.0.0`。
- 授权：用户明确要求接入两个模型并增加 GPT 局部重绘页，确认「未贴图处及笔刷选区为白模，其余保留纹理」。必要的跨模块修改不扩展至投影/UV 核心算法。

## UI 与任务行为

单/多视图使用 Sunburst / Flare 小型切换；默认 Sunburst，当前任务闭包固定模型，批次中不切换。局部重绘新增「原局部重绘 / GPT 局部重绘」二级入口，原 ModelView/Klein 路径及提示词分析保留。GPT 路径不调用 Qwen 润色，也不自动生成另一张多视图参考。

项目 `settings.imageGeneration` 增加可选 `textureGptModel` 和 `localRepaintProvider`。旧项目缺省分别为 Sunburst 和原局部重绘；已有生成记录、模型、图层不做破坏性迁移。新任务 metadata 使用 `sourceComposition=gpt-clay-selection-coverage-v1` 和 `workflow=local-repaint`，服务端任务磁盘恢复亦保留 workflow。

## 输入、空间与常量

冻结同一相机，2K 正方形生成引导图；沿用现有捕获管线，不降低已有分辨率。GPU 平面颜色截图 coverage alpha 表示真实纹理覆盖，不能按 RGB 白色判缺口。未纹理普通材质在 coverage 捕获中保留遮挡深度但写零覆盖。Worker 中未完整覆盖像素（alpha < 255）或笔刷选区（任意可见非零强度）替换为对齐白模像素；其余 RGBA 原样保留。保留白模几何明暗，不采用纯白剪影，不做额外扩张或全图补洞。

发送模型的输入只有组合图和当前选中材质参考图，两张图片按此顺序上传。使用 `textureMapPrompts.ts` 的单视图补全提示词。莉刻模型名与 `extra_params.model` 均为 `gpt-image-2.5-sunburst` 或 `gpt-image-2.5-flare`；局部生成固定 `1:1 / 2K / n=1 / quality=high`。自动尺寸/比例必须成对；参数在服务端校验。

组合图不是写入蒙版：内部保留原始 authored mask，GPT 不接收 mask。按用户追加确认，`GPT-REPAINT-ALPHA/1.0.0` 对新 GPT 局部返图跳过轮廓内缩及强制不透明，原 URL/RGBA/完整画布不变；原远端 ModelView/Klein 保留 ALG-LR-013。遮挡和 UV 笔刷回贴保持，未选中的无纹理区域即使远端补全也不会自动写回。新 GPT metadata.repaintResultPolicy=gpt-source-alpha-v1，两个 source 入口显式 ignoreSourceAlpha=false，并跳过旧颜色合成。此追加不修改单/多视图 Alpha 策略或服务端背景参数。

## 对应链路、安全与恢复

- GPU/Shader：只新增 coverage 捕获选择及无贴图基础材质 alpha，交互材质立即恢复；UV 权重/投射/橡皮擦算法不改。
- Worker/CPU：独立纯像素组合函数运行在现有输入 Worker；旧 local/single 分支保留。
- 持久化：GPT 提交前通过原 Project Command / Revision CAS 队列保存原始选区、捕获相机和深度；保存或深度失败不提交付费任务。
- 云端：继续使用当前用户的 server-owned Atlas home；无浏览器密钥或直连第三方绕过。
- 恢复：前台与恢复轮询使用同一结果策略；新 GPT 原样保留，已完成旧裁切记录不重算。前台仍在处理时轮询不提前发布原图。缺少原始捕获/选区时失败关闭，不自动重发收费任务。取消沿用云端 job ID；并发重复的局部任务返回冲突，不关联到别人的选区。
- 合并/导出：结果仍为既有局部 UV 图层，走原图层持久化、合并、颜色/FBX 导出链路；无需新增格式。

## 测试与限制

新增 `test:gpt25-repaint`：像素级白模/现有白色纹理/透明覆盖/弱笔刷/背景、原始 mask 不变、两个模型、严格双图请求、复用单视图提示词、恢复失败关闭及裁切幂等。新增服务端 `test:gpt25-params`：注册参数、自动尺寸组合、旧 GPT2 兼容。

验证结果（2026-09-12）：完整前端回归 123 项通过，包含局部输入、单视图优先、多视图成对并发、轮询、材质隔离、轮廓裁切、UV 合并与持久化。服务端 `test:gpt25-params`、`test:liclick-personal-account` 通过；前后端 TypeScript 编译及修改源文件 ESLint 通过。Web 生产构建通过，93 个 JS 块共 3,217,772 字节，小于现有 3,222,000 字节预算；未放宽预算。更新旧测试中的固定分支断言以明确区分 ModelView 与 GPT，保留原路径检查并增加未纹理基础材质覆盖测试。不调用真实收费生图，两个模型实际生成质量仍需用户试用；未推送 master 或部署 A100。

## 回滚

Alpha 分支追加验证（2026-09-12）：完整 123 项前端回归通过；GPT/原远端分流及轮廓算法专项通过；TypeScript 与 Web 生产构建通过，93 块合计 3,218,068 字节，未超现有预算。ESLint 无错误，EditorPage 保留三处未涉及的原有警告。未进行真实收费生图或部署，透明背景请求参数及单/多视图源 alpha 仍待单独接通。

Alpha 分支追加：GPU/CPU/Worker/常驻预览/UV 合并/模型导出均已具备 ignoreSourceAlpha 透传，复用原公式而非新增裁剪。新增断言覆盖 GPT 不调用裁剪、原远端仍调用裁剪、取消、恢复幂等、旧版本保留及两处回贴入口一致。旧任务不批量迁移，schema/Project Command/CAS 不改；回滚该追加需保留新 policy 的源 alpha 读取支持，或先固化对应 UV 图层，否则旧构建可能按无版本任务忽略源 alpha。

先确保无运行中 GPT 局部任务并保存项目。回滚本次代码、Worker、API workflow 与设置入口；新设置为可选项，旧版本忽略即可。已完成局部图层仍沿用原格式可读取。不要删除项目资产、原始 mask 或捕获；不要把新云端局部任务强制标成 texture-map，以免误自动投影。
