# 单投影贴图刷新恢复发布修复

- 日期：2026-09-08
- 范围：UI-04 / UI-06 / M03 / M05 / M06 / M12 / M15
- 契约：`PROJECT-TEXTURED-ATOMIC-REVEAL` v1.0.1

## 问题与根因

只有一个可见投影贴图的项目刷新或重新进入时，完整模型可能已经持有结构键一致的驻留投影材质。SceneRoot 的快速复用分支直接返回，未把当前 Group 发布给模型级原子显示门禁，造成材质已就绪但模型仍被加载动画隐藏。开关图层眼睛会触发后续材质流程，因此表现为手动切换后突然恢复。

## 修改与验证

- 驻留投影材质快速返回前调用统一的 `revealInitialMaterialPresentation()`，发布当前 Group。
- 不启动第二次 4K 纹理数组构建或上传；已有显隐、透明度、光照和显示模式仍由同步 uniform 路径处理。
- 投影显隐回归新增单投影驻留快速路径必须先发布、后返回的断言，并保留白模、多模型和渐进恢复约束。
- Cloud Web 总 JavaScript 实测 3,134,406 bytes，总量门禁按约 8 KiB 余量重定标为 3,142,400 bytes；应用壳、编辑器、烘焙与共享 3D 管线独立硬门禁不变。

## 边界与回退

不修改投影像素、材质公式、图层顺序、蒙版、GPU 纹理内容、CPU/Worker/shader、UV/export、分辨率、Project/Scene/Layer Schema、Command 幂等性、Revision CAS、ownership 或资产，无数据迁移。回退只需移除驻留快速路径中的发布调用；历史工程与贴图无需处理。
