# 蒙版捕获保留未选中前景遮挡

UI-10 → M08/M03；INPAINT-CAPTURE-OCCLUSION v1.1.0，production；负责人 Codex。用户反馈发送远端的蒙版穿透屋顶与边框。

证据：capturePaintMask 隐藏 accumulatedMaskMeshes 之外的目标网格；createInpaintMaskCaptureMaterial 丢弃 coverage<=0.01 的片元。两者使未选中前景不写深度，后方选区出现在蒙版内。

修复：冻结相机下，目标对象未选中网格保持可见并使用不透明黑色深度写入材质；选中网格输出 vec4(coverage,coverage,coverage,1)，零覆盖同样写黑色与深度。coverage<=0.01 仍量化为零。目标对象隔离、双面规则、UV 作者选区和远端外扩/羽化保持原样。捕获结束恢复原材质、释放临时材质。

GPU/shader：仅捕获 pass 改变颜色与深度写入；CPU 编排保留全部目标遮挡网格。Worker 输入准备消费修正后的二维蒙版，无独立可见性重投影；实时预览、实际回贴、UV/export 门控不变。输出为既有黑白蒙版 PNG，Schema 无变化，历史图片不重写。回退恢复原片元丢弃与网格隐藏分支。

验证：typecheck；inpaint-prewarm-ownership 执行真实捕获回调，验证未选中前景保持可见、黑色不透明深度写入、恢复原材质；result-composite 与 selection-display 回归通过。尚未使用截图同一模型执行真实 WebGL 重现，不能把结构验证视为现场验收。
