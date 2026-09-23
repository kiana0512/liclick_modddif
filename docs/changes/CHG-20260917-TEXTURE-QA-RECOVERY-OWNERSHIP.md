# 多视图 QA 与后台恢复的状态所有权

- 日期：2026-09-17
- 主模块：M04；协作：M12 / UI-05
- 算法：TEXTURE-GENERATION-RECOVERY-OWNERSHIP/1.0.0；GPT-SILHOUETTE-RETRY/1.0.1
- 状态：本地实现及回归，未推送、未部署，未提交付费生图。

## 问题与边界

前台 GPT 多视图等待函数负责返图 QA、一次同视角重试及有序回贴；后台单任务轮询和项目历史恢复也调用返图 QA，可能把正在重试的同一任务发布为失败，交错覆盖提示。项目历史恢复的一条 QA 异常还会中断整个恢复遍历。未证实调度器本身重排视角。

## 修改

1. engine 中的独立所有权模块为当前项目 texture-map 前台流程签发会话。覆盖 GPT / ModelView 单、多视图；同项目历史 texture-map 后台写入暂缓，不改变其他项目、参考图或局部重绘既有恢复策略。
2. 后台操作在开始前、异步恢复后及异常处理前核验票据。即使前台会话已经结束，跨过其开始/结束的旧票据仍无效；使用新票据才能恢复后台处理。所有正常、失败、取消出口释放自己的令牌，旧 finally 不能解除另一个令牌。
3. 前台 QA 拒绝附带可选 metadata `returnQaRejected` / `returnQaErrorCode`，初次失败保留既有 `silhouetteRetryGenerationId`。后台不复活已拒绝或被替代的结果；新重试不继承拒绝标记。
4. 历史恢复对 QA 失败仅保存该任务的拒绝状态，不发起付费重试；其他任务继续恢复。其他单任务异常隔离，瞬时网络错误保留重试。前台开始/结束触发恢复 effect 更新。
5. 未提交任务的既有提交超时 watchdog 保留，仍在回调时确认最新记录尚未提交；所有权只阻止已提交任务的后台返图轮询/QA，不移除 ModelView / GPT 提交卡住的终止机制。

## 不变项及风险审计

QA 算法与门限、最多一次重试、冻结 Capture / 相机 / 参考图 / 分辨率、GPT 组内顺序和组间 resident 等待、ModelView 逐视角串行、成功同组视角保留、终态失败停止后续组均不变。没有提升并发，没有绕过 QA，没有隐藏不合格结果再回贴。

不改 GPU、CPU 像素核、Worker、shader、作者蒙版、UV、投影提交、资产导出或分辨率；保留现有保存队列、Project Command 幂等、Revision CAS、归属校验和 verified assets。只增加可选生成记录 metadata，原始服务器结果及资产仍保留，不删除模型/图片/任务。无数据库迁移；旧替代任务可通过已有重试关联字段被识别，旧未标记 QA 结果首次重新校验后记录拒绝。

## 验证

- `test-texture-generation-recovery-ownership.mjs` 编译执行生产所有权模块、实际后台 poll effect 与 reconcileJob：前台时零后台 QA、迟到 QA 异常、跨整段会话的迟到成功、项目隔离、重复释放、多令牌隔离、重新接管、拒绝结果不循环、兄弟任务继续恢复。
- 测试由现有 `test-gpt-multiview-pairs.mjs` 引入，纳入既有 CI；原有冻结视角、一次重试、二次失败保留成功视角、顺序/组间等待回归继续执行。入口错误/取消实测释放令牌。
- 实际 A100 浏览器验收需部署后进行，本轮未执行线上生图。
- 本轮结果：完整 Web regression 147 contracts、单独并发回归、typecheck、production build、bundle budget、diff check 均通过。lint 0 errors，保留原有两条未使用变量 warning。最终 Editor chunk 497949 / 499024 bytes（余量 1075），总 JS 3230875 / 3256500 bytes；未调高预算。

## 回滚

回退本次前端所有权及状态恢复修改；无需资产或数据库回滚。可选 metadata 对旧版本透明，已拒绝图片不自动变成合格图片，不删除任何历史结果。Ctrl+D 清空蒙版的独立未提交改动不属于本变更。
