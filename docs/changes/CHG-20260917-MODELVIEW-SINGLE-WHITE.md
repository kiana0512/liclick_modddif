# ModelView 单/多视图纯白输入

主模块 M04；协作 M08/M12/M13；算法 `MODELVIEW-SINGLE-WHITE/1.0.0`。
基线 `0aee5ee1`。依据用户提供的两份 2026-09-17 单视图/单视图局部重绘接口文档，且用户明确确认所有视角改为 ModelView。

## 行为与接口

- 单视图沿用原远端分流：无已有贴图走 `modelview-single-view` 两图；有贴图且有缺口走 `modelview-single-view-inpaint` 三图；完全覆盖时不重复生成。
- 多视图逐个按预览顺序执行，相邻角度、顶/底、自定义角度统一走上述接口，不再切 GPT；每次返回、落图层并等待 GPU resident 后才抓取下一视角当前效果。完全覆盖的角度跳过；取消/错误停止后续请求并恢复相机，已经提交的成功图层保留。
- 两图接口图一为黑底纯白物体；三图接口图一保留已有表面、缺口纯白，图二均为用户参考，图三仅三图接口使用原外扩/羽化 RGB 蒙版。只替换输入颜色图，不将局部补全 mask 误用作整物体回贴 silhouette。
- Worker 显式 `whiteFill` / `fullObject` 策略，不再为远端解码灰模；旧 GPT 模式仍保留灰模合成。缺口判定继续依赖渲染器 alpha，不按 RGB 颜色猜选区。
- 三图蒙版的 24–64px 外扩、4–10px 羽化（2K 比例）和所有 core 规则不变。黑背景只写物体轮廓外，已有轮廓内保护像素不变。
- 新工作流分别为 `2026.09.17-li3d4500-single-view-4step-r1` 与 `2026.09.17-li3d4500-single-view-inpaint-2step-r1`。默认仅图片字段；服务端忽略旧客户端保存的 prompt，不发送 parameters/seed/viewport_reference。独立原局部重绘显式智能润色开关不受影响。
- 新任务幂等后缀区分新工作流，同一次重试仍固定 key/bytes。单/多视图请求端等待 46 分钟，代理默认 45 分钟；不因此自动重提生成。CA、服务端 API Key 和会话鉴权不变。
- 前端单/多视图隐藏无效 GPT 模型/质量与提示词输入，明确显示 ModelView 和内置提示词；不删除已保存草稿或 GPT 历史。

## 安全与对等链路

算法在原 Worker 中执行；CPU coverage/morphology 与 Worker 共用既有实现，GPU/shader 不改。相机、画布、对象/材质 reference ID、结果 matte/投影、图层、UV 合并与导出、分辨率和 QA 均沿用原路径。
保存仍经 verified assets、Command 幂等、Revision CAS、ownership；无 Schema/数据库/资产迁移，不删除或重新生成历史结果。
回滚前后端到基线须同步确认远端是否兼容旧灰模输入和提示词；纯白工作流下不能只回退前端颜色策略。

## 验证

- 执行生产 Worker：整物体纯白黑底、部分覆盖纯白缺口、轮廓内已有表面逐像素不变；远端与旧补全 RGB 外扩蒙版逐字节一致；全覆盖不生成；远端两个/旧 GPT 三个位图释放。
- 执行生产路由与串行 orchestrator：普通/顶/底全 ModelView，回贴 resident 屏障、完全覆盖跳过、取消/失败不再请求下一角度、相机恢复和已成功图层保留。
- 真实本地代理 multipart smoke：严格两/三字段、旧提示词被忽略、新版本/幂等、重试字节稳定与 PNG 持久化。
- 不调用真实付费或生产生成；发布需后续明确执行。
- 验证结果：完整前端回归 147 项通过；Web 类型检查、Web/Server lint（仅两条既有 unused warning）、Server 构建与代理 smoke 通过；Web 生产构建、云/持久化边界与 256B bundle 余量检查通过。Editor 496508/499024 B，总 JS 3229382/3256500 B（108 chunks）。
