# 远端覆盖后本地保留修改总结（2026-08-26）

## 1. 基线与范围

- 仓库：`git@gitlab.lilithgame.com:rd_center/ai_art/li3d.git`
- 上一次按要求覆盖本地的提交：`1635d95e4ce68d5cc98a6d8c40619170f167060c`
- 随后合入并对齐的远端提交：`0f150df6b8539b31cb4a30945e65c33a7f49a255`
- 本文记录的是在保留上述远端代码基础上，本地继续完成、准备提交到 `main` 的增量修改。
- 不包含 `.env`、密钥、`workspace/`、运行日志、缓存或用户项目数据。

## 2. 功能修改

### 2.1 单视图增加 GPT2 / 远端双通道

- 单视图界面增加 `GPT2 / 远端` 切换，默认仍为 GPT2。
- GPT2 原有提示词、任务提交、轮询、取消和投影逻辑保持不变。
- 远端模式调用 ModelView `modelview-single-view`，提交：
  - 当前视角 clay 白模；
  - 当前选择的多视图材质参考图；
  - 最长 4096 字符的可选提示词。
- 远端单视图使用独立服务地址、CA、API Key、超时、任务前缀、幂等键和工作流版本，不与局部重绘任务混用。
- 返回 PNG 先持久化到当前项目，再沿用现有 `single-view-priority-v1` 投影和图层处理逻辑。
- 远端失败不会静默切换到 GPT2，避免重复计费或产生语义不同的任务。

### 2.2 ModelView 服务端代理复用

- 将原先只服务局部重绘的 ModelView 请求代码抽象为 `inpaint / single-view` 两类服务定义。
- 新增：
  - `GET /api/modelview/single-view/status`
  - `POST /api/modelview/single-view`
- 浏览器继续只访问同源 Node API，不接触远端 API Key。
- 两条 ModelView 链路共同保留：HTTPS/局域网 CA 校验、连接与总超时、取消传播、响应大小限制、错误透传、结果哈希和项目资产持久化。

### 2.3 局部生图点击后的即时准备态

- 点击局部生图后立即切换到重绘预览区并显示准备进度，不再等待 2–3 秒才出现反馈。
- 准备过程细分为当前视角、多视图材质参考、项目状态、蒙版、白模、材质预览等阶段。
- 准备态和已提交生成态统一为不透明深色背景，只显示状态文字与计时。
- 移除进度背景中的旧结果图、模糊效果和旋转图标，避免画面杂乱和额外图像解码。
- 保留同步提交锁与按钮运行态，防止准备阶段重复点击创建任务。

### 2.4 旧局部重绘图层预览修正

- 局部重绘缩略图和大图预览优先使用 `localRepaintMaskUrl`，展示用户实际涂绘区域。
- 兼容历史图层：没有独立涂绘蒙版时才回退到旧 `maskUrl`。
- 极老图层若完全缺少蒙版，缩略图不再显示整张远端效果图；大图明确提示无法显示区域预览。
- 新创建的局部重绘图层继续沿用相同的正确裁切规则。

### 2.5 选择框显示范围

- 橙色模型选择框只在“场景”工作区显示。
- “贴图”工作区隐藏选择框，避免干扰材质和投影视图。
- 此修改只影响辅助显示，不改变模型选择状态、加载状态或投影计算。

## 3. 配置新增

远端单视图支持以下服务端环境变量：

- `LICLICK_MODELVIEW_SINGLE_VIEW_URL`
- `LICLICK_MODELVIEW_SINGLE_VIEW_CA_PATH`
- `LICLICK_MODELVIEW_SINGLE_VIEW_API_KEY`
- `LICLICK_MODELVIEW_SINGLE_VIEW_TIMEOUT_MS`

未单独配置 CA 或 API Key 时，复用已有 ModelView 局部重绘配置；密钥仍只保存在服务端环境文件中。

## 4. 主要文件

| 文件 | 修改内容 |
| --- | --- |
| `apps/web/src/components/panels/GeneratePanel.tsx` | GPT2/远端切换、远端提交分流、局部生图即时准备态、统一进度界面 |
| `apps/web/src/services/modelviewApiClient.ts` | ModelView 远端单视图客户端适配与 Generation 元数据 |
| `apps/server/src/routes/modelview.ts` | 远端单视图状态和生成路由 |
| `apps/server/src/services/modelviewInpaintService.ts` | inpaint/single-view 共用安全代理与独立工作流定义 |
| `apps/server/src/config.ts` | 远端单视图 URL、CA、Key、超时配置 |
| `apps/web/src/components/panels/LayersPanel.tsx` | 旧局部重绘缩略图和大图按涂绘蒙版裁切 |
| `apps/web/src/engine/viewport/SceneRoot.tsx` | 选择框仅在场景界面显示 |
| `apps/web/scripts/test-*.mjs` | 单视图分流、准备态、选择框、旧图层预览回归断言 |
| `scripts/smoke-modelview-inpaint.mjs` | 同时覆盖 ModelView 局部重绘和远端单视图代理 |
| `docs/00_SYSTEM_MODULES_AND_CHANGE_STANDARD.md` | 登记 `ALG-GEN-004` 及双提供方契约 |
| `scripts/docs/build_maintenance_manual.py` | 修复动态目录展开后的空白页规则 |
| `output/docx/`、`output/pdf/` | 重新生成 v2.2.0 维护手册 |

## 5. 明确未包含的修改

- 未加入中文提示词自动翻译；相关尝试已取消，工作区无翻译代码或配置。
- 未改变 GPT2 原生成逻辑。
- 未修改局部重绘的投影、接缝融合、校色或蒙版回贴算法版本。
- 未提交任何用户项目、模型、贴图、任务产物、登录会话或服务器密钥。
