# 视口未覆盖区域恢复深灰斜线

版本 2.20.2；M06，协作 M03/M08；PROJECTION-EMPTY-DISPLAY v1.0.0。

用户要求不要视口白模，恢复深灰斜线并直接部署 A100。仅改变诊断显示，不撤回可靠投影裁切或多视图/单视图参数一致性。不存在贴图或投影全部隐藏时仍保留原白模状态。

## 边界

- 单层/多层材质初值及显示同步：可见投影设 hatch=1，全部隐藏=0；UV-only 缺口显示同一深灰斜线。
- 所有 flat 捕获逐 tile 强制 hatch=0；flat-target-coverage 强制 2，RGB 无斜线、alpha 仍为真实覆盖。异常/完成/替换拒绝后恢复原视口值，复用驻留 shader，不跨异步帧占用临时状态。
- GPU 裁切/深度/背面、CPU fallback、Worker alpha 补白模、UV/export 烘焙公式均不变。输出分辨率与 QA 不变，无额外读回；斜线仅用于视口，不写进生成输入或用户纹理。
- 无 Schema、持久化或数据迁移；不修改作者 mask、图层/历史、Command 幂等/CAS/ownership/verified assets。

## 验证与回滚

真实 Edge WebGL 已验证 single/stack/array/UV-only 的深灰缺口，与 coverage 模式的干净 clay RGB/alpha 隔离；六组同输入单/多视图像素一致，Worker 与 GPU UV 检查通过，无 shader 编译错误。截图测试覆盖初值 1 → 临时 0/2 → 恢复 1，以及异常与多 tile。

回滚恢复 2.20.1 的视口初值及 UV 空白颜色即可，保留截图隔离仍安全；不回滚几何裁切/回贴契约。部署先备份 A100 产物及版本配置，保留运行目录及非版本配置；本次本地提交仅用于不可变构建溯源，不推送 master。
