# 局部 UV 重绘切层后的黑色细缝

主模块 M06，协作 M08/M07/M09；ALG-PROJ-007 v2.1.14。原生绘制算法 ALG-LR-UV-PAINT 仍为 v1.1.5。

## 复现与根因

用户报告：刚画完的车身重绘正常，添加其他图层后出现黑色细缝，删除新层后仍保留。当前用户页面使用旧构建，读取到目标层已由 CanvasTexture 显示。

隔离 Edge/WebGL 使用真实 UvRepaint、live registry、生产材质及 Worker 复现同类问题：

1. 绘制输出的 render target 创建时为 Nearest；材质虽然把 Three 纹理属性改成 Linear，已分配的 GL render target 仍使用 Nearest。GPU owner 释放后，registry 保留原画布，其 CanvasTexture 实际为 Linear。保存重开和多层合成也使用 Linear。删除新层不会重新创建旧层的绘制 GPU owner。
2. 旧 shader 对 straight RGBA 直接做线性采样，透明像素的黑 RGB 混入边界颜色；随后再乘 alpha，形成暗边。灰色圆形重绘覆盖同色底图：刚画完无暗边，Canvas/PNG 边缘最多比基准暗 31 个线性 RGBA8 级。
3. 普通 UV 预览把 overlayAlpha 用于颜色混合后，又用它在已照明底色与叠加结果间混合；下方 UV 层的有效 alpha 变成平方。透明度 0.4 的不透明输入也会被额外减弱。六种材质入口的独立数值对照定位到此差异。

## 修复

三个生产 shader 共用 sampleUvOverlay：从原尺寸纹理读取四个邻近 texel，在**线性颜色、预乘 alpha**空间双线性插值，再恢复 straight RGBA 交给现有叠加公式。显式 clamp 到纹理边界，零 alpha 的 RGB 不参与颜色；不依赖 GPU owner 的旧 sampler。覆盖普通 UV 下层/live 层、单投影和投影栈的 UV/top UV 入口。

普通 UV 预览先计算底色/空白预览的照明，再执行一次 overlay source-over；保留 rendered-color、色调、live 顶层和空白预览的规则。

## 对应路径审计

- GPU/shader：只改 UV 颜色采样和重复 alpha 混合，不改投影相机、深度、法线、质量权重和采样预算。每次 UV 采样由一个硬件线性读取改为四个 texel 读取；没有新渲染 pass、纹理副本或 CPU 像素扫描，不宣称整体耗时下降。
- M08：不改源图、可见性、笔画写入、擦除、脏瓦片读回、历史或共享 UV 规则。测试确认作者 canvas RGBA 前后完全一致。
- CPU/Worker：SceneRoot fallback 与 compositeUvLayers.worker 的 Canvas2D source-over 保持；测试包含两种合成输出，Worker 使用生产 createWorkerBackedPreviewTexture / 条带上传，显式保留 straight alpha 解码。
- 持久化：PNG 编码与读取屏障、图层 ID、contentRevision、资产、Project Command 幂等、Revision CAS、ownership 和 verified assets 不变。没有改写用户工程。
- 合并/导出：原生 UV 仍传递同一 RGBA；原合并、PNG/FBX 测试验证资产输出。调用这些生产材质的视口/截图会使用新采样；外部软件采样独立 PNG 的行为不由本修复控制。已有烘焙进像素的黑缝不自动重绘。

## 验证

- 新增 `check:uv-repaint-alpha-edge`：真实绘制 → live GPU → 释放 GPU → Canvas → PNG → 加上层/Worker 合成 → 删除上层 → CPU 合成。硬边和 0.7 羽化的 12 项输出暗化均为 0；作者像素不变。
- 六种材质入口 × 不透明/混合 alpha × 图层 opacity 1/0.4，非方形彩色纹理与独立 CPU 数学基准逐像素比较，最大误差 1/255。覆盖零 alpha 隐藏颜色、纹理边界、方向和全不透明颜色插值。
- 原生 UV/合并/重绘顺序与 shader 格式化回归、类型检查、相关文件 lint 通过。
- 最终 `run-uv-repaint-browser --viewport` 通过：DPR 1/1.25/1.5/2、曲面/透视/遮挡、4K、擦除/撤销/重做、PNG/FBX/重开、两层/三层显隐及合成。
- `run-resident-uv-browser` 通过：无浏览器错误，显隐恢复像素差为 0，UV 岛边界对照差为 0；合并底层和几何显示模式往返验证通过。
- 正常生产构建通过；干净产物 99 个 JS 共 3,172,746 字节，原 3,256,500 字节总预算及各块/256 字节余量检查通过。4517 已提供 `index-R41B6Fo9.js`，保留旧静态资源以支持尚未刷新的页面；未替用户刷新、保存或改写工程，未提交/推送。

## 迁移、范围与回滚

无 Schema 或资产迁移，不降分辨率，不关闭 QA。重新加载新构建即可使用修正后的采样；原始 UV 图层不需要重画。用户原工程在新构建上的同视角人工验收仍待进行，不以夹具通过替代该结论。

回滚 ProjectedLayerMaterial 的 UV 采样函数/六处调用及下层混合顺序即可恢复旧显示行为；保存数据保持兼容，但细缝可能再次出现。
