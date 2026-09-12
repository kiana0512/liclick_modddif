# GPT 方图、顶部输出分辨率与质量选择

- 主模块 M04，协作 M08/M12；算法 `GPT25-TEXTURE-GENERATION/1.1.0`。
- 授权：单/多视图固定方图，分辨率绑定顶部选择，开放两个模型和五档质量，背景固定透明；随后明确 GPT 局部重绘也一样。
- 状态：本地实现与验证，未部署；负责人：Li3D 维护者 / Codex 实施。

## 行为与参数

三个 GPT 入口共用 `getGptTextureRequestParameters`：aspectRatio=1:1，imageSize=顶部 resolution（1K/2K/4K），quality=用户选择，count=1。不是统一固定 2K，也不再读取普通参考图生成页的 auto 比例/尺寸。遇到旧 8K 设置明确报错，不静默降档。

Sunburst/Flare 模型选择保留，新增低/中/高/超高/最高，对应莉刻 registry 的 low/medium/high/xhigh/max。默认 high，不擅自提升费用档位。质量存入可选 ProjectSettings.imageGeneration.textureGptQuality；老项目缺省高，其他参考图与原远端 ModelView/Klein 不改。

顶部选择绑定的是生图输出分辨率。原模型引导截图仍按已有捕获管线处理（单/多视图最高 2048；局部引导/蒙版 2048）；不在本次扩大 GPU 截图负载，也不把截图拉伸成假 4K。返图通过现有归一化相机坐标回贴；GPT 已跳过要求返图与深度像素同尺寸的内缩算法。笔刷授权与深度相机不变。

模型/质量在任务执行中禁用；正在运行的单视图或整个多视图批次闭包固定当次 resolution/quality，后续顶部设置变动不改已启动批次。任务 quality 字段经客户端、服务器 input 原样存储和请求，extraParams.quality 记录实际参数；job list params 同步回传。服务端对 GPT2.5 五档质量白名单校验，非法值拒绝；background=transparent 不允许界面修改。

## 对应链路与验证

纯参数策略置于 engine，不在 React/Zustand 放算法；UI 只选择并提交。未更改 GPU/CPU/Worker/shader、UV 合并/导出算法。Project Command/CAS、对象权限和云端账号边界不变；新增可选设置与任务参数不升级项目 Schema。

测试矩阵：两个模型 × 三个分辨率 × 五档质量，包含 GPT 局部与 texture-map 的服务端提交参数、透明背景、缺省和非法质量、旧 8K 拒绝、原始笔刷不变与 UI 禁用态。

## 迁移与回滚

验证（2026-09-12）：前后端构建、修改文件 ESLint、GPT 请求矩阵通过。前端 123 项回归分段全部通过：全套在旧测试夹具缺失新参数 helper 时停止，补齐实际 helper 加载并加入顶部 4K/最高质量断言后，从该项重跑余下 15 项全部通过。Web 包 93 块共 3,219,472 字节，低于原 3,222,000 预算；未放宽预算。未做真实收费生图/交互式视觉验收，未推送 master 或部署 A100。

不重写历史任务/图层/图像资产。回滚设置 UI 和参数传递即可，旧版本忽略可选质量设置；既有任务应继续使用当时 extraParams，不重复发起收费任务。透明 Alpha 的回退约束继续遵守 CHG-20260912-GPT-TRANSPARENT。
