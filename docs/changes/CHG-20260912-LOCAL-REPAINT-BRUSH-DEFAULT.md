# CHG-20260912-LOCAL-REPAINT-BRUSH-DEFAULT

## 范围

- UI：UI-10 局部重绘工具。
- 主模块：M08 局部重绘。
- 设置版本：`LOCAL-REPAINT-BRUSH-DEFAULT` v1.0.0。

## 修改

局部重绘视口蒙版画笔和独立画布画笔的初始大小统一为 `15`。视口偏好持久化当前不保存局部重绘画笔大小，因此刷新后的新运行时会采用该值；同一运行时内用户手动调整继续保留，不被后台任务覆盖。

## 不变项与迁移

- 不改变画笔半径换算、压感、羽化、加选/减选、GPU/CPU/Worker 像素公式。
- 不改变输出分辨率、历史、保存、Project/Layer Schema、Revision CAS、ownership、verified assets 或导出。
- 无项目或资产迁移。回滚时恢复两个默认常量，不处理用户数据。
