# 普通投影可靠区域硬裁切及生成覆盖遮罩

主模块 M06，协作 M03/M04/M07/M08/M09；维护版本 2.20.0，PROJECTION-RELIABLE-FOOTPRINT v1.0.0。用户明确要求从条纹过渡开始处裁掉、不传递给 GPT。实施 Codex，原复杂模型体验由维护者验收。

## 原因及语义

普通投影原 coverage 连续混合几何朝向、可见性、image-edge 支撑与作者 alpha，未覆盖底色是屏幕斜线。部分投影与斜线相混后，单视图补全 Worker 的纯斜线 RGB 检测不能完整识别混色区域，造成交错的白模/纹理条纹。此次不扩大 RGB 色差容忍度，不将黑色艺术内容当成缺口。

- 几何支撑 G = angleCoverage × visibilityCoverage × projectionFacingCoverage × (0.35 + 0.65 × coverageEdge)。普通投影采用 step(0.98, G)：低于阈值整段撤出，达到阈值后仍乘 layerOpacity × sourceAlpha（含作者 mask）。0.98 是可调算法常量，不是逐像素颜色阈值，也不是模型法线角度。代价是覆盖面积保守收缩，由下一视角补全。
- 现有 frustum/backface/depth/normal 限制及 inside/alpha gate 保留；surface-locked 局部重绘继续使用原锁面/羽化/橡皮规则。quality 权重与多层颜色排序不变。
- 常规单层、多层、UV-only 未覆盖显示干净白模。已有显式诊断模式 1 保留；普通可见性同步固定模式 0，不因存在 UV 恢复斜线。UV-only 旧诊断底色也改为白模。
- flat-target-coverage 使用运行时模式 2，将当前实际合成覆盖是否达到 0.98 写入 PNG alpha。按 source-over 计算底图、普通 Top-K 混合、underlay、显式/动态 overlay、上下 UV 的累计覆盖，不以单层最大 alpha 代替总合成。RGB 仍是原 BaseColor；模型之外仍由原完整 silhouette 排除。
- 输入 Worker 仅在原模型 mask 内将 alpha < 255（含 MSAA 边界）替换为同相机 shaded clay。黑/白/有纹理 RGB 都不参与判定，输出合成恢复不透明白模。无需新增 GPU pass/读回/网络图片；GPT 仍只接收模型引导图和用户材质参考。

## 对应实现审计

- GLSL：ProjectedLayerMaterial 单层、直接候选/overlay、compact array 共用可靠度 helper；ProjectedLayerPreviewCompositor 与 gpuUvBakeRenderer 同步。GPU readback、颜色空间、PNG/Worker 分辨率、投影相机和内外轮廓裁切均保持。
- CPU：uvRasterizer 的 loose fallback 对其原有 angle/image-edge 支撑采用相同硬准入；既有不支持的深度/锁面路径不伪造 parity，也不扩展生产 fallback 权限。作者 mask/source alpha 不硬化。
- Worker：single 模式改用投影覆盖 alpha；local 模式继续按作者局部蒙版，不改变局部重绘范围/扩张/羽化。旧 inferProjectionGapMask 保留给旧兼容/测试，但不再用于新生成输入。
- 合成/导出：质量混合 Worker 接收裁切后的 raster，公式保持；UV merge 版本 5→6、UV bake cache 协议 7→8、持久 projection bake cache 名称 v1→v2，旧羽化派生结果不被视作本版本的新合成。历史 merged UV 当作作者底图保持，不静默重烘焙，不删除用户资产。
- 持久化：无 Project/Layer/Capture 字段变化，Command 幂等、Revision CAS、ownership 和 verified asset 不变。覆盖 PNG 仅为输入准备中间结果；原 capture.mask/depth 仍保留。新版本不承诺清除已被 GPT 画进图片或已烘焙进历史 UV 的条纹。

## 验证

- test:projection-reliability：阈值上下界，0..255 作者 alpha 保持、透明/MSAA/镂空范围、黑色 RGB 不影响 gap，所有 shader 分支接线。
- verify-projection-reliability-webgl.mjs：真实 Edge WebGL2/MSAA，调用生产单层/直接多层/texture array/UV-only 工厂及 GPU UV raster。正面 alpha 255，侧向支撑过渡 alpha 0，普通视口同处 alpha 255 且显示中性白模；两个半透明候选累计覆盖正确；可靠 UV 底图不被弱投影抹除。生产 Worker 合成 64² 黑色纹理/空白各半：2048 个缺口全部补灰白，黑色半边不变。Shader 编译无错误。
- 完整 Web 回归 108 项通过；TypeScript、变更代码及测试 ESLint、git diff --check 均通过；Cloud 生产构建通过。包体检查 84 chunks / 3,157,283 bytes，通过既有预算；Cloud 产物检查 196 files / 24.96 MiB，无宿主组件或 loopback bridge。
- 浏览器验证不调用收费生成或修改远端项目；该合成模型测试不能代替用户原工程验收。

浏览器验证运行：安装/可用的 playwright 通过 LICLICK_TEST_PLAYWRIGHT_MODULE 指定，LICLICK_TEST_BROWSER_CHANNEL 默认 msedge；执行 node apps/web/scripts/verify-projection-reliability-webgl.mjs。测试仅启动临时 Vite/无头浏览器，finally 关闭。

## 回滚

恢复原几何支撑乘积、捕获 RGB 缺口推断及旧显示模式；shader 与捕获/Worker 必须成套回退，不能只退其中一端。缓存命名可保持新版避免交叉复用，回退时使用独立版本最安全。保留所有工程和资产；历史结果不批量修改。用户已授权推送 master 并部署 A100；发布使用同一提交的不可变构建，部署前备份旧产物，保留运行数据及非版本配置，并核对 release/ready。
