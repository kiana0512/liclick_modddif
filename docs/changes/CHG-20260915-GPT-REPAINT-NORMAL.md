# GPT 局部重绘：法线引导与可选材质参考

## 范围与版本

- UI-05 → 主模块 M08；协作 M03（捕获）、M04/M12（请求）。`GPT-REPAINT-NORMAL` v1.0.0，任务元数据 `gptRepaintInputPolicy=geometry-normal-v1`。
- 仅新建 GPT 局部重绘任务；单/多视图纹理、六视图参考生成、原 ModelView/Qwen 局部重绘保持原流程。
- GPT 页签新增“使用材质参考图”开关，默认关闭；开启展示既有参考选择区，关闭仅隐藏、不删参考资产或选择。准备/生成锁定时禁用，使用 button + role=switch，保留键盘、焦点与 aria-checked。

## 输入与语义

1. 关闭：结合图、几何法线图，共两张。根据同一部件周围的可靠纹理修复。
2. 开启：上述两张之后追加当前显式选择的材质参考，共三张。无选择或选择已删除时先提示，不从历史任务回退，不自动替换为配对多视图或触发参考生图。
3. 独立懒加载提示词说明图一颜色/修复范围、图二几何和图三可选材质职责，抑制凭常识补件、跨孔洞连接与复制法线颜色；保留真实平面印花/文字，不将“法线无细节”等同“材质无细节”。补充要求追加一次，空输入使用通用修复说明。
4. 每次提交冻结开关、所选图快照、提示词与相机；后续 UI 切换只影响下一次请求。

## 捕获与资源

- GPT 使用现有 `LOCAL_REPAINT_INPUT_RESOLUTION` 2048²；结合图、作者选区、clay、深度、法线共用冻结相机，不重新取景。新增正式 `captureCurrentNormalGuide` 不走 1K 预览上限；原 `captureCurrentNormalPreview` 仍为最多 1K 世界空间，既有调用行为不变。
- 正式引导使用 MeshNormalMaterial 的视空间几何法线，独立材质不读取原 normalMap/bumpMap；仅目标网格可见，隐藏 grid/其他物体，清空场景背景、透明 clear，数据纹理编码不套颜色显示变换。每次同步提交后恢复原材质/可见性；成功和失败均释放临时法线材质。
- 正常 GPU render/readback → Worker PNG 编码不变。新增一个完整法线 pass 有真实成本，未宣称零开销或提速。
- 前两张引导图经过真实 client 预处理时保持原始 PNG 数据及尺寸；超过现有 Atlas 上传预算明确报错，不自动 WebP 重编码或降尺寸。第三张普通参考保留原处理策略，单/多视图处理不变。

## 持久化、恢复与兼容审计

- ProjectSettings.imageGeneration 增加可选布尔 `gptRepaintUseMaterialReference`，仅严格 true 启用，缺失/未知按 false；通过既有设置保存，不新增本地凭据或端点。无需批量迁移。
- normalUrl 使用既有 Capture 字段，经 critical save 的 verified asset 持久化；作者 mask 与 depth 仍在 GPT 提交前保存。请求元数据记录模式，历史任务文本和结果保持原样，不因缺少法线重新提交旧任务。
- 原生成 ID、Command 幂等、Revision CAS、ownership 与 verified assets 校验不变。图片准备前后检查取消；信号传到同源请求，取消不触发自动付费重试。
- 法线只是提交给 GPT 的有序视觉输入，不伪造 ControlNet/专用法线参数。最终原图 Alpha、作者选区写入授权、深度、UV 合成、CPU/Worker/shader 像素公式、撤销重做、层序和 PNG/FBX 导出不改。
- 关闭开关不删除文件。回滚 GPT 专用构建器/提示词/面板，忽略新增设置，保留 Capture 法线资产与历史任务；旧完成结果不迁移或重算。

## 验证与限制

- `test-gpt-repaint-normal.mjs` 由现有 `test:gpt25-repaint` 加载：执行真实参考解析、提示词、请求构建、预处理和 client JSON 序列化，覆盖关/开/关、无选择/失效选择、显式单图不替换配对图、图片顺序、私有 mask 不发远端、精确尺寸、过大失败与取消零提交。
- 实际 capture wrappers 的 1K/2K/4K 尺寸、冻结相机与旧预览行为通过；真实 Three 材质/可见性替换及异常释放通过。GPU draw/readback 此专项使用夹具，不冒充真实模型像素验收。
- 执行生产开关 JSX，验证开/关、禁用、aria、点击回调和服务端渲染；面板源码门禁验证仅 GPT 展示与参考选择区条件。
- GPT 模型/质量/透明策略、self-lock、单视图补全、renderer 状态隔离回归通过；Web typecheck/build 通过。当前构建总 JS 3,244,896 / 3,247,500 bytes，未提高任何预算。
- 未运行付费生图、未推送或部署；提示词与普通法线参考不能保证模型严格遵守几何，真实美术效果仍需同一输入对比验收。
- 扩展回归：入口、原重绘输入/材质参考、OAuth 继续、冲突门禁、透明边缘、flat capture 隔离、重绘导航和参考绑定通过。原工作区另一个任务的画笔默认值 30 与旧断言 15 冲突；本次使用基于 master 的独立发布工作区，排除该任务的画笔/视口改动，保留线上默认值与原测试，不放宽门禁。
- 改动文件 ESLint 无错误，GeneratePanel 保留两条原有未使用变量告警；尚未在登录后的真实工程完成浏览器端生图验收。
