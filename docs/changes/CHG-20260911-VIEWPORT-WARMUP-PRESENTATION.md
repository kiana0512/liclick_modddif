# 后台投影预热不再占用视口后续帧

- 主模块 M06，协作 M03/M13，ALG-PROJ-007 v2.1.13，渲染目标生命周期修复。
- 用户反馈：视口交互偶尔有断续、撕裂感，平均 FPS 稳定不代表实际显示连续。检查发现 early texture-array warmup 在绑定 1×1 离屏目标后跨 rAF 等待 GPU fence，后续视口绘制可能仍写入该目标。
- 修复：仅在同步 warmup draw 期间切换 framebuffer；提交后立即恢复原 target、cube face、mip level 与 autoClear，再等待 GPU。另补齐离屏输出程序变体的异步编译，避免只预编译屏幕变体、首次离屏 draw 又同步链接。保留原采样、fence、取消和异常清理，不提前释放在途资源，不降低分辨率或关闭验证。
- 回归执行 SceneRoot 的实际预热回调，以 GPU 延迟完成模拟三个刷新周期；旧代码在首个等待帧断言失败，新代码三帧均恢复目标。覆盖正常完成、取消、编译失败、渲染失败、等待失败与无 fence，验证目标状态和 sync 清理。
- 审计：CPU 调度只缩短共享 renderer 状态持有期；GPU shader/颜色/深度/遮罩/纹理输入和计算结果不变。Worker、UV raster、持久化与导出路径不变，Project Command/Revision CAS/ownership/verified assets、Schema 均不变，无数据迁移。
- 原项目修复前手动观测：RTX 4070 Ti SUPER，4K，14 投影+6重绘层，旋转/缩放短录制 59.7 FPS、P95 16.8ms、最大 33.4ms、错失 2 帧；此录制未重现预热目标占用，不能作为该修复收益对照，也不能证明显示器级撕裂根因。该补丁修复确定的后台预热显示阻塞，不宣称所有交互已零卡顿。
- 回滚恢复旧预热绑定范围即可，无资产迁移或项目改写。
- 验证结果：117 项 Web 回归、类型/构建、原 bundle budget（88 chunks / 3,220,729 bytes）、云/持久化边界通过；目标 lint 0 error，仅 SceneRoot 既有 unused warning。新构建原项目旋转/缩放短录制 58.6 FPS、P95 16.8ms、峰值约 34ms、错失 8 帧；两次短录制时长/交互采样窗口不完全相同，且未触发 early-array 路径，不用于宣称总体帧率提升。浏览器日志有换页前旧构建 projectPipeline-D4NTx0TF 的 compileAsync/isReady 错误，最新构建为 projectPipeline-BN45wVJ_，需区分日志归属，不能把页面刷新当作无错误性能对照。
