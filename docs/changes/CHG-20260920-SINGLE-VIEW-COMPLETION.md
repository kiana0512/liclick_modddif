# 单视图完成保存去重

- UI-05 → 主模块 M04，算法 `SINGLE-VIEW-COMPLETION/1.0.0`，production 路径，本地未发布。
- 基线 `7081a76a`；实现 Codex，真实体验由维护者验收。

## 证据与修改

单视图 `addGenerationAsProjectedLayer` 在上传所有图层资产后发布图层，并同步 Generation 回贴回执、等待工程 CAS 保存。旧 `completeView` 随后再次生成 `projectionCommittedAt`、同步 Generation，86% 后又等待 `saveGenerationStateBestEffort`。截图已显示纹理且左上角 Saving，与此串行重复保存路径相符；用户报告约 4 秒，尚未取得线上阶段耗时，不能承诺精确节省秒数。

engine 中的 `persistProjectionCommit` 统一已有三个回贴事务分支：同步同一回执、通知保存阶段、等待原 save Promise，只有成功后回调本次已保存 Generation。GPT/ModelView 单视图消费该确认，直接复用结果而不改写时间/重新同步。收尾策略仅在非多视图、本次确认成功、完成数=1、实际图层数=1、失败数=0 时省去第二轮保存；无确认、已有历史回执、失败、删除或多视图仍保留 checkpoint。确认只在当前调用栈中使用，不做跨任务全局缓存。

保存期间进度文案显示“回贴完成，正在保存”，状态卡同步解释。没有固定延时、超时假成功或把必要保存改为 fire-and-forget。提交前捕获保存、任务身份保存、素材上传、回贴事务队列、后台恢复所有权和取消检查继续保留。

## 对应路径与数据

- 输入：原 Generation、真实 Layer ID、原串行 CAS 保存 Promise；输出：同一已保存 Generation 的瞬时确认。无像素、颜色空间、矩阵或距离单位。
- GPU/CPU/Worker/shader：不修改渲染、回贴、atlas 或上传/合成算法，仅减少重复工程保存；不降低分辨率或跳过 QA。
- 持久化：仍先保存 verified 图层资产，再以原 Command/Revision CAS 保存图层与回执；ownership 和冲突重试不变。只有已获保存确认的正常单视图才省去重复 checkpoint。
- Schema、历史资产、UV 合并和 export 字节不变；无迁移。失败仍保留既有恢复流程。

## 验证与回滚

- 执行生产回贴事务、生产 completeView 与生产收尾 checkpoint 语句，不以测试副本代替。
- GPT/ModelView 正常单视图：保存被人为挂起时图层已可见但任务未结束，保存成功后相同 Generation/时间回执不再重写；回贴后的保存次数由 2 降到 1。
- 保存失败不发成功确认、已有内存回执不当作本次确认、图层删除/失败/多视图继续收尾保存；并保留并发去重、删除、跨项目、取消、资产失败重试回归。
- 15 个专项入口通过：单视图自动回贴、远端多视图、GPT 成组、轮询、冲突、认证续跑、删除、Revision 恢复、保存协调器、云端生成持久化、单视图质量混合、Resident UV 显示/上传、UV 合并和模型导出方向。新增 helper 已接入生产函数回放夹具。
- Web typecheck、改动文件 ESLint（无警告）、生产构建、Cloud/Repository 边界及 diff 空白检查通过。启用性能面板的本地构建 editor 498770/499024 字节、总 JS 3251656/3256500 字节，包体检查通过，未提高预算；尚非带最终提交元数据的发布验证。
- 回滚前端这次变更，恢复重复收尾保存即可；不重写或删除任何历史结果。未操作生产项目、未发起付费生图，实际 A100 耗时待部署后验证。
