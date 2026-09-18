# ModelView 局部重绘原始法线四图输入

- 变更单：CHG-20260918-MODELVIEW-NORMAL-INPUT；负责人：Codex（按用户授权迭代）。状态：implemented，尚未生产部署。
- UI / 模块：局部重绘生图 → M08（控制面代理适配），不改变单视图生图、单视图补全与 GPT 请求契约。
- 算法：MODELVIEW-NORMAL-INPUT/1.0.0，ALG-LR-002 新远端适配；workflow `2026.09.18-refcontrol-normal-4step-r1`。
- 输入：现有纯白选区效果 image、材质 material_image、外扩 RGB mask，新增 normal_image。前三者含义不变；默认不发 prompt，显式智能润色仍可覆盖。
- 捕获：使用同一冻结 cameraSnapshot 与画布比例，2048 原生渲染，复用 captureCurrentNormalGuide。完整目标几何法线，不按 mask 裁切、不填白、不降采样、不滤波、不换色。
- GPU / shader：复用现有 view-space MeshNormalMaterial 和 geometryGuide 数据捕获；单位无量纲，编码 n×0.5+0.5。保留现有 dataTexture、无场景背景、透明背景与 samples=0 约定；没有新增灯光、曝光、tone mapping、通道翻转或背景改色。CPU 仅校验尺寸和可解码性，转发原始字节；Worker/UV/export 算法不变。
- 资产 / 持久化：使用已有 Capture.normalUrl 保存原法线，沿用 verified asset 保存路径、Project Command/Revision CAS/ownership，不新增 schema。Layer 输出与 direct-v1 回贴、原始作者蒙版权限不变。
- 校验：前端核对尺寸并响应取消；控制面缺法线、无法解码、尺寸不一致均 422，失败不进入远端队列。mask 仍检查红通道非空。
- 幂等：新后缀 `inpaint:refcontrol-normal-4step-r1` 隔离旧三图请求；相同任务与四图重放保持相同键与 multipart 字节。改变图像应新建任务，不会自动以新键重试未知结果。
- 超时与 TLS：继续使用控制面 2700 秒、浏览器 2760 秒默认值和已有 CA 校验。
- 迁移 / 回退：旧工程与已完成结果不迁移；旧客户端缺少第四图会明确 422，更新需前后端一起发布。回退需协调远端旧工作流和前后端适配，不能仅回退前端而继续调用新四图远端。
- 验证：新增四图代理 smoke 检查法线原始字节、缺图/损坏/尺寸错误、稳定重试及旧单视图两/三图契约；新增前端冻结相机/尺寸/取消/请求序列化回归。既有法线材质、GPT 法线、局部重绘参考/输入/图层保留/有序合成/交叉淡化/烘焙批次/接缝回归通过。全工作区 typecheck 与 Web/Server 构建已执行，最终体积门禁通过：Editor 498902/499024 字节，总 JS 3248321/3256500 字节；ESLint 无错误（两条原有未使用变量 warning）。共享捕获 helper 同时复用 GPT 原有捕获位置与输入语义，并补充取消检查。
- 真实远端效果尚未验证；本轮无付费生图请求、未部署生产。

发布准备：ModelView HTTP 客户端改为使用时动态加载，保留发布元数据 256 字节余量；无接口与输出语义变化。按用户指令发布 master 与 A100，实际发布版本和验证另记交付报告。
