# CHG-20260908-REMOTE-MULTIVIEW-SEQUENTIAL

- 日期：2026-09-08
- 主模块：`M04` 生成编排
- 协作模块：`M03/M05/M06/M09/M12/M15`
- 界面：`UI-05/UI-06/UI-12`
- 算法：`ALG-GEN-006` v1.0.0

## 问题与目标

多视图只有 GPT2 批处理，远端 ModelView 只支持单视图。本次让多视图也可选“远端”，并严格按视角串行生成：上一视角返回图必须先投影且驻留到正式材质，下一视角才捕获当前效果并提交。这保证后续视角能继承已生成表面，而不是彼此独立重复生成。

## 流程与性能约束

1. 当前活动视角优先，其后每次选择与上一视角方向点积最大的视角，减少相邻步骤的新暴露面积。排序在独立纯函数中实现，不放在 React 面板。
2. 静态 clay/mask/depth/camera 在任务开始时一次捕获并持久化；当前材质效果必须在每次切换并等待两个浏览器绘制边界后即时捕获。
3. 完全覆盖的视角不发起远端请求；部分覆盖复用单视图现有贴图补全与外扩蒙版；全白模复用普通远端单视图。不降低捕获或生成分辨率，不改 QA 门禁。
4. 每个返回结果使用对应 capture camera/mask/depth 创建普通 projected layer，并等待 `liclick:projected-material-resident` 后才继续。整批只在末尾执行一次内容识别填补。
5. 远端推理存在前后依赖，不并行提交各视角。节省时间来自重用静态捕获、按覆盖跳过和最近视角顺序，不牺牲回贴依赖正确性。
6. 为通过原有 Web 包体门禁，ModelView client 的三类返图只共用相同的 Generation 字段映射；端点、workflow/provider、referenceIds、input mode、任务 ID 和服务端返回字段保持不变。未提高包体预算。

## 取消、失败、恢复与回滚

- 统一终止操作会 abort 当前 ModelView HTTP 等待，阻止之后的视角和末尾填补。已成功投影的图层保留，不回滚用户成果。
- 中途失败会标记当前 Generation 失败并停止整批，不自动切换 GPT2。重试时通过完整覆盖检查跳过已完成视角。
- 任务结束、取消或失败都恢复原相机与原活动视角。
- 无 Project/Layer/Generation/Capture Schema 变更，无数据迁移；Command 幂等性、Revision CAS、ownership 和 verified assets 不变。GPU/CPU/Worker/shader、UV/export 和投影公式不变。
- 回退时移除多视图的远端提供方入口、串行编排器和相机方向设置辅助函数，保留已存在的 Generation、Capture 和投影图层；不删除工程、资产或运行配置。

## 验证

- 新回归覆盖提供方路由、最近视角顺序、白模/补全分支、逐图投影驻留、一次末尾填补、中止与相机恢复。
- Web 完整回归、typecheck、lint、Cloud release build/artifact/bundle budget 和 A100 健康检查以最终发布记录为准。不使用付费生成作为自动门禁，需由维护者在 A100 真实项目中终验。
