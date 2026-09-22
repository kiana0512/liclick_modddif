# 局部重绘 UV 图层橡皮擦实时反馈

- 日期：2026-09-22；主模块 M08，协作 M06/M07/M09。
- 算法：ALG-ERASE-001；显示生命周期版本 UV-ERASER-LIVE/1.0.0。持久化 eraserAlgorithmVersion 仍为 1，擦除像素语义不变。

## 问题与处理

恢复后的局部重绘 UV 图层走普通 uv-image 橡皮擦，beginLiveEraserPreview 原来直接拒绝此类型，以规避异步解码时把 1×1 占位图发布为完整贴图造成闪白。因此笔画只能在松开后的提交阶段显示。

现在等原图就绪、完整 backing canvas 初始化后，按源图原尺寸复制到实时预览，复用实时 registry 和 destination-out 笔迹刷新；不发布未就绪或 1×1 占位画布。保留同一预览中的连续笔迹，退出后重新初始化；撤销/重做恢复 RGBA 图像而非投射 keep-mask 的白色。UV 画布不再积累永远不会由投射 GPU 接管的 stamp backlog。

## 对等审计

- GPU/shader：既有 UV 采样器直接消费更新中的 CanvasTexture。投射图层的 GPU keep-mask 与 native UV repaint 活跃会话不变。
- CPU：源图只在预览初始化复制，不逐点重新合成完整图层栈；沿用既有 UV 笔迹坐标、羽化、提交与历史逻辑，不改分辨率。
- Worker/烘焙/导出：无新增算法或消息。正式提交仍写入原完整 UV canvas，预览不成为新持久化资产；保存和导出消费既有正式 URL。
- Command/CAS/ownership/verified assets/Schema 不变，无数据迁移。回滚本次 ViewportCanvas 预览生命周期分支即可，已保存擦除结果兼容。

## 验证

- 新增 verify-uv-repaint-eraser-browser.mjs，真实 Edge/WebGL + ViewportCanvas：鼠标尚未松开，橙色顶层像素 [208,82,4,255] 已变为下层蓝色 [4,26,152,255]；移动、正式画布 alpha 提交、撤销、重做、工具切换和连续笔画通过。
- 1K 和 4K 源图通过；UV 下层及投射下层场景通过。测试用恢复后的完整 PNG UV 图层，无活跃生成会话。
- Web TypeScript、修改文件 ESLint、eraser target policy、Web 生产构建与包体门禁（256-byte 总量余量）通过；未提高预算。
- 旧 verify-eraser-live-uv-browser.mjs 的 CPU draft.drawing 断言超时，实际捕获到擦除后蓝色像素且无页面异常；该脚本仍要求旧 CPU 草稿修订递增，不能当作本次 GPU 投射路径完整回归通过。
- 未操作用户线上工程、未调用远端生成；未提交、推送或部署。用户录屏对应的真实工程尚未现场复测。
