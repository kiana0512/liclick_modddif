# CHG-20260912-LAYER-VISIBILITY-AUTHORITY

- 主界面/模块：UI-06/UI-10 → M05、M07、M08、M11
- 状态算法：`LAYER-VISIBILITY-AUTHORITY` v1.0.0
- 目标：局部重绘的可见投影行与实现用 UV destination 始终作为一个作者图层原子显隐。

## 根因与修复

眼睛按钮在 React 面板内私有扩展关联图层 ID，而快捷键直接调用 store 的单层切换，导致 UI 行已隐藏但关联 UV 仍可参与常驻显示、合成或导出。关联解析现迁入 `engine/layers`；store 的用户 toggle 原子更新全部表示，面板复用同一领域函数。显式内部切换仍可使用精确 ID，不破坏局部重绘准备阶段的表示交接。

重复设置已经相同的显隐值现在保持 layer 对象和 layers 数组引用，不触发无意义 SceneRoot 签名变化、常驻 UV 重合成或保存。

## 兼容、验证与回滚

图层 Schema、ID、顺序、像素、分辨率、GPU/CPU/Worker/shader、QA、Project Command/CAS 与资产均不变，无迁移。回归覆盖成组隐藏、恢复往返、活动图层/橡皮退出、相同状态 no-op、Resident subset/visibility 生命周期、缩略图和颜色导出。回滚为恢复面板私有扩展和单层 toggle；无数据回滚。
