# 多 UV 显示方向与重复合并输入

主模块 M09，协作 M05/M06；ALG-UV-006 v2.1.0；合并产物版本 5。

## 问题与修复

已有合并 UV 不满足 isFlattenableUvMergeSource 的旧筛选，只允许内容填补，故选中 UV1 仍会被忽略。现在接收 merged-uv，沿用排序、opacity 和 straight-alpha under 合成，在新投影覆盖之外保留 UV1。

多 UV Worker 输出已翻转到 GL 方向。createWorkerBackedPreviewTexture 返回 flipY=false 的 DataTexture，SceneRoot 却按 image 不是 ImageBitmap 改为 true，使条带偏移反序。现在保留工厂方向，仅 CanvasTexture 回退显式使用 flipY=true。

## 验证与边界

后续补齐：纯 UV 选择允许合并；自动颜色导出/烘焙计划在可见多 merged-uv 时将其余 UV 纳入输入，不直接复用最上层。旧局部重绘迁移只适用于版本 <4，版本 5 不应使版本 4 的隐藏重绘复活。计划回归和 typecheck 通过。用户已在原项目确认两张 UV 同时显示正常；FBX 回读尚未验收，代码路径会将可见 UV 全部压平为 Base Color。

test-fixtures/uv-stack-orientation.html 使用真实合成 Worker、bitmap Worker、条带上传和 WebGL framebuffer readback：1024² 非对称图像加透明上层，对照单图；旧分支差异 12,288 字节，修复 0。另验证已有 merged-uv 可入选，以及局部不透明红色覆盖和透明区域保留蓝色底图。Typecheck 与导出入口回归通过，修改文件 lint 无错误（SceneRoot 原有 unused warning）。用户项目的完整再次合并还需体验验证。

GPU/CPU/Worker 的 source-over 像素公式不改；shader/投影/UV 栅格化不改；导出入口沿用合成输出。保持分辨率、QA、资产发布与源层隐藏事务、ownership、Revision CAS 和 Command 幂等性。无 Schema 迁移，不删除或改写旧 PNG。此前 UV2 已漏掉的内容不会自动出现，需选择原 UV1 与重绘投影重新合成；仅显示错位无需重做资产。

回退恢复筛选与 flipY 赋值、版本常量即可，但会恢复两项错误；已生成正确 PNG 无需删除。未发布 release。
