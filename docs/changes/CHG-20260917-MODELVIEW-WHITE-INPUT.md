# ModelView 局部重绘三图与可选润色

- 主模块 M08；协作 M04/M12/M13。算法 `MODELVIEW-WHITE-INPUT/1.0.0`。
- 工作流 `2026.09.17-li3d4500-defaultprompt-steps2-r1`；实现基线 master `7c911ee6`，发布前同步 `6c70e286`，保留其导入减面及 UV 按距离合并优化。
- 依据用户提供《局部重绘-三图输入-前端对接-20260917.md》，仅修改原局部重绘，不修改 GPT 或单视图补全。

## 行为

1. 冻结视角和 2K 画布，Worker 沿用原选区 core 清理；图一 core 内填不透明纯白，core 外 RGBA 不变。不再合成白模，也不再捕获/解码多余白模图。
2. 图二保持选中的材质参考；图三沿用原 core、24–64px（2K）外扩、4–10px 羽化计算。画布、坐标、原作者蒙版与回贴授权不变，蒙版为 RGB 黑白且 Alpha 不承载选区。
3. 项目 imageGeneration 增加可选 `localRepaintSmartPolish`，缺失/false 即关闭。关闭时文本框明确提示并禁用，保留原文字但不提交，不读旧润色缓存，不调用 Qwen。
4. 开启才执行既有视觉润色并传 prompt，属于文档保留的提示词覆盖兼容接口；非严格三图默认模式。Qwen 仍看原效果图/原蒙版以辨认部件。
5. 代理仅在显式 `promptPolishEnabled === true` 时接受重绘提示词；关闭忽略旧 prompt，远端 multipart 仅 image/material_image/mask。不开 parameters/seed/viewport_reference，TLS/鉴权保持。
6. 新工作流使用新幂等后缀，复用同一任务 ID 时字节/key 稳定；新点击保留既有独立 generation ID。默认代理上限 45 分钟，浏览器 46 分钟（部署时需检查已有环境变量/外部代理覆盖）。不自动重复提交任务。

## 对等链路、迁移与回滚

- Worker 执行纯白合成，CPU morphology 原样；GPU/shader、蒙版绘制、深度、投影/UV、结果处理、图层目标、合并/export 均不改。
- 持久化仍经原 Project Command、Revision CAS、ownership 和 verified assets；不改变 Schema 版本、已有模型/图层/生成资产。新增可选设置向后兼容；历史任务不重新生成。
- 元数据记录 white 输入策略及开关；润色 fingerprint 增加新版策略和开关，旧缓存不能被误复用。
- 回滚须同时恢复前后端输入与远端兼容工作流；新设置可忽略，已生成 PNG 无需迁移。不能只恢复灰色白模前端却继续用只认纯白标记的远端工作流。

## 验证

- 逐像素 Worker 回归：纯白 core、保护区不变、外扩/羽化 RGB 蒙版不变；空蒙版拒绝、位图释放。
- 默认关闭解析实际面板 prompt 分支：旧提示词/缓存不得触发视觉准备或 Qwen。
- 代理 smoke：默认精确三字段、显式润色才带 prompt、空润色拒绝、重试同 key/同 bytes、返回 PNG 持久化；单视图和 GPT 回归。
- Edge headless 原生 Worker/PNG 2K 实测：25 万个选区像素纯白，保护区差异 0；对照 `7c911ee6` 旧 Worker，提交蒙版 RGBA 差异 0。本机输入准备 308ms（Worker 255ms），不含捕获、网络与生成。测试服务器误扫描了仓库既有旧 content-framing 夹具并输出其失效 import 警告，独立本次 Worker 实测完成，无生产请求。
- Web 类型检查、lint（0 error，2 条既有 unused warning）、生产构建与 bundle budget 通过，Editor 495991/499024B，总 JS 3228124/3256500B。
- 完整 Web regression 147 项通过；Server build/lint、ModelView HTTP/HTTPS 连接生命周期 16 项及代理 smoke 通过，Cloud/persistence boundary 与 256B bundle 余量门禁通过。旧测试中的默认“永远可编辑提示词”、旧输入文件名/幂等后缀断言已随新契约更新，并增加开关真假值矩阵检查。
- 本轮仅本地修改；未触发付费/生产生成，未部署。
