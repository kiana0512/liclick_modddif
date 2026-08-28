# Changelog

本文件记录维护者和用户可感知的仓库变化。详细问题证据、范围、测试和回退见 `docs/changes/`。

## Unreleased

### 单视图生成与投影

- `ALG-PROJ-002` v3.0.0 / `ALG-PROJ-003` v3.0.0：带捕获深度的 `surface-locked-v1` 投影改以捕获 mask/depth 作为覆盖权威，不再被扫描模型不稳定的插值法线二次削弱；实时常驻材质、渐进预览和 GPU UV bake 保持同一 coverage/quality 语义。
- `ALG-PROJ-005` v2.0.0 / `ALG-UV-004` v3.0.0：新单视图叠加到可见多视图或 UV 底层时，在轮廓约 3.5% 画幅宽度内使用 12%→100% 的距离场 Alpha 平滑过渡，核心区域继续由单视图优先覆盖；没有底层时保持原不透明覆盖。
- GPT2 与远端单视图统一使用完整捕获画幅、捕获相机、mask 与 linear-view depth 创建投影层；供应方 PNG Alpha 默认仍被忽略，只有编辑器明确生成的 `distance-field-v1` Alpha 才参与合成。
- 生成结果预览使用捕获几何覆盖，并从主体内部回拉轮廓 RGB，减少透明棋盘上的黑边；投影源保持原始捕获尺寸，清理轮廓污染并向 mask 外扩散 RGB，避免线性采样和 mipmap 把深色背景带上模型。
- 单视图投影专用距离场复用同一组全帧队列/距离缓冲，避免 4K 处理额外分配约 100 MB；旧图层和旧工程不批量迁移，新效果在重新生成单视图后生效。

### CI/CD

- 修复 GitLab Runner 冷缓存安装期间 Prisma engine 下载遇到瞬时 `ECONNRESET` 即使整条 Pipeline 失败：pnpm store 与 Prisma engine cache 统一落入项目级缓存目录，依赖安装最多重试 3 次并采用 5/10 秒退避；不跳过 lifecycle、不关闭校验，也不改变生产运行时或数据库契约。

### 贴图橡皮

- `ALG-ERASE-001` v1.0.0：恢复底部工具条当前图层橡皮和贴图工作区 `E` 快捷键。普通/合并 UV 擦 alpha，投影图层编辑 UV keep mask，局部重绘编辑作者覆盖；内容识别底图保持只读，可从图层右键菜单创建独立可编辑 UV 副本。
- 投影橡皮的交互预览继续使用轻量代理，持久遮罩和延迟补缝改为跟随项目 1K/2K/4K/8K；高分辨率写入失败时阻断并提示，不静默降级。
- 修复普通生成投影层的 UV keep mask 在临时橡皮预览卸载后被深度可见性策略忽略的问题；预览开关、切换图层和进入局部重绘不再恢复已擦除区域。
- 修复连续点击投影层眼睛时，晚到的纹理/灯光材质 effect 使用结构缓存中的旧可见性、把已关闭图层重新显示的问题；所有延迟材质发布现在执行时重新读取 LayerStore 权威状态。
- 图层右键/三点菜单新增“清理蒙版”：仅对普通投影层、且确有当前版本 UV 橡皮 keep mask 时可用；执行后恢复该层原始投影覆盖，并取消未完成的延迟补缝，避免旧蒙版被异步任务重新发布。

### 性能调试

- `PERF-LAB-ENTRY/2.0.0`：`perfLab=1` 只打开当前真实项目的只读性能 HUD；删除会替换 Project/Scene/Layer Store 的合成场景加载器及 `perfScenario` 导航契约。性能调试入口不得创建、替换或持久化模型与图层。
- `PERF-LAB-ENTRY/1.1.1`：投影预览失败保留上一份有效材质并对相同签名熔断；错误仅进入 console，不再弹出或反复刷新用户 Toast。

### 局部重绘

- `ALG-LR-002` 升级到 `2026.08.26-740115a-truev3-gguf-3input-rseed-r1`：界面新增最长 4096 字符的可选补充提示词，ModelView 请求只发送 `prompt`、白模 `image` 和材质多视图 `material_image`，不再发送 `viewport_reference`、`seed` 或 `noise_seed`。
- 修复局部生图提交准备态不同步：同步提交锁建立后，左侧生成按钮与底部工具条同时显示转圈和“生成中...”，无需等到后台 Generation 行创建。
- `ALG-LR-007` v2.0.1 / `ALG-LR-008` v2.1.0：复用同一 source revision 的 GPU overlay、linear-view depth 和 shader program；第二次及后续按钮 3 保持单击激活，停笔后两帧内立即发布完整图层行，3000ms idle 仅用于后台 latest-wins 保存合并。
- 修复本地集成工作区重复上传同一 image/depth，以及 ordered projected stack 已接管显示时 renderer overlay 仍重复投影到底面；历史局部重绘层选择继续拥有显示权。云端发布将稳定 Zod vendor 独立缓存分包，保持既有单 chunk 与总 bundle budget，不改变 Project Command、Revision CAS、输出分辨率、投影/UV/颜色公式或旧工程资产格式。

### Documentation and governance

- 建立 `docs/00_SYSTEM_MODULES_AND_CHANGE_STANDARD.md`，统一当前模块、算法真值、版本、变更分级和验收规则。
- 按编辑器全界面增加 UI 模块调用表，并补齐图层差别、投影 Top-3、UV 合并、局部重绘与 Ctrl/Cmd+S 保存的代码级审计。
- 为 23 个投影、UV 合成和局部重绘算法建立稳定 ID、中英文基础名、规范版本、真实运行标记与兼容性规则。
- 生成 `1.2.0` DOCX/PDF 正式维护手册；PDF 51 页逐页验收，DOCX 更新目录与分页并通过结构和无障碍检查。
- 合并 `gitlab/main@2568e40` 后保留维护规范；固定手册第 22 节为每次迭代的版本记录位置，并增加 `pnpm docs:maintenance` 按需生成 DOCX/PDF。
- 增加仓库级 `AGENTS.md`，限制 Codex 默认修改范围并保护他人未提交工作。
- 增加 CHG 与 ADR 模板，后续变更使用稳定模块 ID 追踪。

## Baseline before 2026-08-26

此前功能演进保留在 Git 提交和既有日期型 audit/merge/optimization 文档中，不追溯伪造发布版本。当前功能基线见根 `README.md`，当前维护规范见唯一准则。
