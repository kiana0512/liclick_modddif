# 截图完成后的蒙版落点偏移

- UI-05/UI-06 → M03/M08；`ALG-CAP-006` v1.0.1、`INPAINT-PROJECTION-TEXTURE-SIZE` v1.0.0，production。
- 触发：单/多视图或蒙版离屏截图等待 idle、GPU fence、异步读回期间，浏览器视口发生 resize/缩放。旧实现跨 await 重放开始时的 viewport/scissor；CPU 射线和 SVG 光标使用新 DOM 尺寸，GPU 仍按旧区域绘制，导致蒙版偏离光标。
- 修复：每个同步 GPU 提交段分别保存当前 renderer/背景，提交后立即归还；恢复函数幂等，异步完成或失败清理不再覆盖后来更新的视口状态。逐 tile、累积 pass、最终读回均遵循同一规则。
- 第二根因：CanvasTexture 首次上传后 WebGL2 以不可变尺寸分配，直接更改源 canvas 尺寸再 needsUpdate 不会重建存储；缩小后蒙版被旧纹理坐标压偏，放大可能上传失败。resize 与历史恢复遇到尺寸变化时 dispose 旧 GPU allocation，后续原上传路径按新尺寸重建；纹理对象/材质引用保持有效。同尺寸连续笔画不重建。
- 输入/输出与单位：沿用 CapturePassRequest、CSS viewport 与 Three renderer 坐标；PNG 尺寸、RGBA、颜色空间、相机矩阵、深度和所有阈值不变。
- 对应实现审计：CPU 输入/SVG、M08 蒙版 GPU shader、CPU/Worker 编码、投影/UV 合成、历史、持久化和 export 均无需改变像素公式；只修正共享 renderer 的同步所有权。无 Schema、Command/CAS、ownership 或作者资产迁移；旧工程照常读取。
- 回退：恢复 renderTargetUtils.ts 原快照逻辑；保留所有工程/资产，旧偏移风险会恢复。
- 自动验证：生产函数回归在 idle/fence/readback 间更新 viewport/scissor，覆盖 tile、display transform、非分块、累积 pass 和异常清理；旧实现失败，修复通过，原完整像素断言保留。
- 真实 Edge / RTX 4070 Ti：生产 ViewportCanvas 与蒙版工具，截图等待期间实际 resize。旧实现保留旧 viewport 并造成约 82 CSS px 向下偏移；仅修复捕获后，DPR 1.65 连续缩放仍复现约 51px 偏移，纹理尺寸修复后 tiles/passes/readback 三路径误差均小于 1px。30 轮工具激活/落笔、撤销/重做、反选/清空、多视角与 UV 独立显示通过。未发起付费生图，真实用户工程仍须发布后复核。
- 测试入口：`node apps/web/scripts/test-capture-renderer-isolation.mjs`；`node apps/web/scripts/run-projected-selection-editor.mjs --capture-resize`。提交修复前可加 `--capture-baseline` 加载 HEAD 原捕获实现作冻结对照。
- 负责人：Codex；变更单：CHG-20260921-CAPTURE-RESIZE-MASK-ALIGNMENT。
