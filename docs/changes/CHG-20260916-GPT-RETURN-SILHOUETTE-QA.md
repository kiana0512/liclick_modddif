# 返图轮廓与采集蒙版协作校验

- 日期：2026-09-16
- 主模块：M04
- 协作模块：M03 / M06 / M08
- 算法：`GPT-RETURN-SILHOUETTE-QA/1.1.0`

## 问题

texture-map 返图的透明边缘会因服务端羽化产生少量像素差异。原校验将返图 alpha 边界与采集轮廓逐边严格比较，即使后续投影会用冻结采集蒙版精确裁切，也会中断整批任务。

## 变更

- texture-map 使用 capture-mask 策略：保留空轮廓、返图尺寸/比例、明显缩放、重叠和中心偏移校验。
- 通过粗粒度校验后，仍由已有的冻结采集蒙版在投影前执行精确几何裁切。
- local-repaint 及未标记 workflow 仍使用原严格 alpha 边界校验。
- 同步与立即返回路径显式传递 workflow，防止两类策略混用。

## 不变项与审计

- 返图原像素、输出尺寸和完整分辨率不变，不缩图、不重提付费任务。
- GPU / CPU / Worker / shader、冻结相机、深度/法线、UV 权重和投影公式不变。
- 持久化、导出、Project Command 幂等、Revision CAS、ownership 和 verified assets 不变。
- 无 Schema 或数据迁移。

## 验证

- 严格策略仍拒绝轻微边界改变。
- capture-mask 策略允许 6%--8% 羽化/内缩，仍拒绝 50% 宽度缩放及空图。
- framing 逆变换、取消、历史任务防重复恢复回归通过。

## 回滚

恢复 `validateFramedSilhouette` 的单一严格策略，并移除 workflow 到 framing 恢复函数的策略传递。已保存资产无需迁移或删除。
