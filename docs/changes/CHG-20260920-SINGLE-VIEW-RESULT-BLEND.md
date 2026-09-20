# 远端单视图补全返图渐变合成

- UI-05 → 主模块 M04，协作 M03/M13/M14；实施 Codex，视觉验收用户。
- 算法：`SINGLE-VIEW-RESULT-BLEND/1.0.0` / Single-view angular result blend。状态：本地实现，未部署。
- 用户授权：先以提供的当前图、灰度蒙版、返图验证 `final = returned × mask + current × (1-mask)`，随后明确要求修改代码。当前实现按用户最初提出的当前视角 N·V 公式构造权重，不宣称复刻 Modddif 的内部投射质量算法。

## 输入与公式

仅单视图已有纹理补全 `/api/modelview/single-view-inpaint` 的新浏览器请求附带可选 `resultBlend.version=1`。冻结已有 flat-target-coverage 图、完整模型 mask、同一 Capture 的 view-space normal 和序列化相机。使用生成前已有纹理图，不能用已填白的 remote image 作为混合底图，不能在返图时重新截图。

模型外权重为 0；模型内 coverage alpha <255（与 projectionGapMaskFromAlpha 相同）为缺口，权重 1；其余为 clamp(dot(normalize(N), normalize(V)),0,1)。captureCurrentView 的法线 RT 是 sRGB，故 N=2×sRGBToLinear(RGB/255)−1，须先解码 RT 自动应用的传递函数；这不是修改发送给模型的原法线图。正交 V=(0,0,1)，透视 V 由冻结投影矩阵及像素中心恢复，PNG 顶部对应 NDC +Y。不得根据 RGB 是否黑色判断缺纹理。权重量化为 0–255，不加 smoothstep、曝光或额外 gamma。

按用户认可的预览在 sRGB 编码字节上取整混合。它是两张彩色图的插值，不是将返图乘灰度变暗。输出同画布不透明 PNG，符合现有普通单视图 source alpha 忽略规则；capture mask/depth 仍限定实际模型轮廓与孔洞。所有输入与返回必须同尺寸，不能缩放凑齐；无效输入提交前 422，错误尺寸返图不发布合成结果。

## 远端、持久化与消费者

Li3D 控制面生成渐变权重并在远端返回后合成。远端 multipart 仍只有原 image/material_image/mask/normal_image，原 RGB 黑白 mask 的既有外扩和边缘羽化字节不变；不把 resultBlend、当前图或渐变图发送给模型。远端工作流/幂等键不变，每个用户新任务继续独立 ID。

原始返图先保存为 verified generation asset；混合后结果写 Generation.resultUrl，metadata 保存 `resultComposition=single-view-ndv-v1`、rawResultUrl、resultBlendMaskUrl、resultBlendBaseUrl。输出 SHA256/bytes 对应混合 PNG。浏览器只是提交与映射，不新增像素循环。预览、回贴、刷新后的自动投影及导出均消费已保存 resultUrl，不在恢复时再次混合。

CPU：独立 server service，每32行让出 event loop并响应取消；GPU/Worker/shader：沿用已有同相机捕获与投影，无权重内核改动。UV/导出：继续原 capture mask、depth、Top-K 与源图消费；不降低分辨率，不取消 QA，不改变投影几何。Project Schema/Command 幂等、Revision CAS、ownership 和 verified assets 机制不变。

## 兼容与回滚

未携带 resultBlend 的旧客户端继续原始返图；已有 Generation/Layer 不重算，无历史资产迁移。普通手绘局部重绘 `/inpaint`、GPT、无纹理 `/single-view` 和多视图串行入口保持原行为。回滚浏览器接线和控制面可选处理即可；已合成的 PNG 仍可读取，原图保留，不删除数据。

## 验证

- 像素回归：白/黑/灰、黑材质、透明/部分覆盖缺口、背景/孔洞、透视边角、尺寸不一致、无效相机/图片、取消、重复执行。
- HTTP 模拟完整代理：原四图与蒙版字节不变，额外合成输入不外发；验证输入拒绝、raw/base/mask/final 资产可读及最终 SHA256/字节数，旧请求保持原 PNG。
- 前端真实提交函数：冻结 current/object mask/camera 与原远端 mask 分离，无纹理端点不附加合成；既有 normal、自动回贴、统一投影、输入 Worker 回归。
- 真实 Edge WebGL 验证同版本 Three MeshNormalMaterial：正对相机平面写入 sRGB RT 得 [188,188,255]，NoColorSpace RT 得 [128,128,255]，据此选择正确法线解码，防止渐变发白。
- 未调用付费远端生成；本地测试不代表用户项目上的视觉验收或线上发布。

本地验证结果：新增像素测试、完整 HTTP 代理冒烟及五项相关 Web 回归通过；Web/Server 类型检查、Cloud 正式参数构建、Cloud artifact/两项边界与包体检查通过。编辑器 498855/499024 bytes，总 JS 3251740/3256500 bytes，未提高预算；修改文件 lint 无错误，GeneratePanel 两条既有 unused 警告保留。构建身份为 local-gradient-check，只用于本地验收，不代表发布。
