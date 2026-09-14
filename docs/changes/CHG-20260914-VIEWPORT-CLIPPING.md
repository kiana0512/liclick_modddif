# 预览靠近时异常裁切

- 主模块：UI-06 → M03，协作 M04；算法 `VIEWPORT-CLIPPING/1.0.0`。
- 原因：紧凑生成取景的 near/far 适用于固定捕获位置，动画结束却把它们留给自由预览。滚轮只移动相机，旧的大 near 会切掉前方表面，旧的小 far 也可能在拉远时丢失模型。
- 修改：动画只拓宽预览裁剪区间，不收窄；near 至多 0.01，far 至少 100，保留更宽的原有范围。导航时 near 取现值、0.01、max(目标距离×0.01, 1e-6) 中最小值，far 取现值、100、目标距离×4 中最大值。仅值变化时更新投影矩阵，不扫描网格或射线拾取。
- 兼容：旧快照在用户开始滚轮、平移或旋转时修复。普通 controls.update 不改裁剪参数，以保留程序化视角恢复的精确性。独立 fitted camera 与其深度快照保持原有参数。
- 边界：这是裁剪范围修复，不是相机碰撞系统；实际进入模型、观察相机背后的几何仍受正常投影限制。
- 对应路径审计：generationFraming 返回独立拟合相机；captureCurrentView、captureDepth 与 ProjectionCamera 继续使用其冻结参数。CPU/Worker/shader 投影、UV、材质、蒙版、导出、分辨率及 QA 不改；不重写历史快照、资产、Project Command/CAS/ownership，无 Schema 或数据迁移。
- 验证：扩展既有 generation-framing 与 viewport-wheel-events，旧实现分别复现动画放大近面和导航时近处点落在 NDC 深度范围外；修复后验证 72 个取景组合、透视/正交的滚轮/旋转/平移、拉近全程及拉远后目标深度、捕获参数独立性。全部 125 项 Web 回归、视角立方体、类型检查、lint（0 错误、2 条既有警告）与正式 Cloud 参数构建通过；包体 3,225,997 / 3,226,500 字节、Cloud artifact 检查通过。
- 回滚：恢复 animateCaptureCamera 与 BlenderOrbitControls 本次差异即可，无需更改工程数据；回滚会重新引入捕获裁剪范围污染预览的问题。
- 状态：本地修复，尚未推送部署；未在截图对应的实际自行车工程中验收，不把矩阵回归当作该工程的视觉验收。
