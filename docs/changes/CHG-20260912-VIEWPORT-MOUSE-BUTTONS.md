# CHG-20260912-VIEWPORT-MOUSE-BUTTONS

- 主界面/模块：UI-06 → M03、M08
- 输入算法：`ALG-VIEW-INPUT-001` v1.0.0
- 目标：左键只执行当前画笔、局部重绘或橡皮工具；中键平移；右键旋转；滚轮缩放。

## 变更与边界

`BlenderOrbitControls` 不再认领左键，且不再用 Ctrl/Cmd+中键缩放；中键始终平移，右键始终旋转并禁止浏览器上下文菜单。绘制入口取消鼠标右键隐式减选/擦除，显式选择减选或橡皮工具后仍由左键执行；压感笔尾擦保留。

相机旋转/平移数学、绘制与橡皮 GPU/CPU/Worker/shader 像素、分辨率、QA、保存、Revision CAS、ownership、verified assets 和导出均未改变。无 Schema、资产或项目迁移。

## 验证

- `pnpm --filter @liclick/web test:viewport-wheel-events`：真实控件事件验证左键不导航、中键（含 Ctrl）平移、右键旋转、上下文菜单抑制及滚轮缩放；同时保留 R3F 选择/空白点击和原生画笔事件所有权回归。
- Web TypeScript 检查及全量回归随本次审计一起执行。

## 回滚

仅恢复 `BlenderOrbitControls.getPointerAction` 和 `ViewportCanvas` 的鼠标按钮分派。无需迁移数据；回滚会重新引入左键旋转及右键隐式擦除。
