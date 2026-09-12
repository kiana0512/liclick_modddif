# CHG-20260912-VIEWPORT-MOUSE-BUTTONS

- 主界面/模块：UI-06 → M03、M08
- 输入算法：`ALG-VIEW-INPUT-001` v1.2.1
- 目标：左键执行当前画笔、局部重绘或橡皮工具；中键平移；右键命中模型时擦除、从背景起拖时旋转；滚轮缩放。

## 变更与边界

`BlenderOrbitControls` 不再认领左键，且不再用 Ctrl/Cmd+中键缩放；中键始终平移。三维绘制入口先做一次模型命中测试：右键在可绘制模型上起笔时由蒙版/画笔/局部重绘路径独占并执行擦除，右键在背景上起笔时不被绘制层消费并交给轨道旋转；因此同一次手势不会同时擦除和旋转。左键执行显式当前工具，压感笔尾擦保留。独立局部重绘二维画布没有三维轨道，继续保持左键绘制、右键擦除并抑制浏览器菜单。

v1.2.1 将 pointer-down 时已经冻结并用于射线的 canvas 几何与光标 overlay 几何保留到同一笔画结束。后续命中帧直接复用，不在 BVH 射线后再次触发两个 `getBoundingClientRect`；未命中帧立即隐藏光标，不保留边缘外的旧命中圆圈。相同 cursor 值不重复写 DOM。窗口布局仍可在下一笔重新取样，活动笔画期间与原有 pointer-capture 几何冻结策略一致。

相机旋转/平移数学、绘制与橡皮 GPU/CPU/Worker/shader 像素、分辨率、QA、保存、Revision CAS、ownership、verified assets 和导出均未改变。无 Schema、资产或项目迁移。

## 验证

- `pnpm --filter @liclick/web test:viewport-wheel-events`：真实控件事件验证左键不导航、中键（含 Ctrl）平移、右键旋转、上下文菜单抑制及滚轮缩放；同时保留 R3F 选择/空白点击和原生画笔事件所有权回归。
- `pnpm --filter @liclick/web test:projection-layers`：验证三维视口仅在模型命中后消费右键擦除、背景右键仍可到达轨道；独立二维局部重绘画布保留右键擦除，压感笔尾擦不退化。
- `pnpm --filter @liclick/web test:surface-stroke-latency-policy`：验证原始输入继续按显示帧合并，命中/未命中不会恢复同帧多次射线。
- Web TypeScript 检查及全量回归随本次审计一起执行。

## 回滚

v1.2.1 可独立回滚光标几何快照；继续回滚 `BlenderOrbitControls.getPointerAction`、`ViewportCanvas` 的鼠标按钮分派和 `LocalRepaintDialog` 的 pointer gate 才恢复旧按键。无需迁移数据；完整回滚会重新引入左键旋转及右键隐式擦除。
