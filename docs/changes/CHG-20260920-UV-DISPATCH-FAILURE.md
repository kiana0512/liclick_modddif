# UV 合成派发失败恢复

- 主模块：M07；协作：M03/M08/M15。
- 契约：`UV-COMPOSITE-DISPATCH/1.0.1`，L1 调度修订。
- 状态：本地修复，未提交、推送或部署。

## 问题与修改

旧实现先登记 active，再创建 Worker / postMessage。构造或结构化克隆同步抛错时，该 active 永远不能收到回执，后续所有 owner 的合成都积压。

派发失败现在撤销 active、释放未成功交接的输入位图、拒绝当前任务并更新队列诊断；使用 microtask 推进下一任务，避免连续同步失败形成递归栈。保留一个运行任务、每 owner 最新请求替换、取消只清待运行任务的契约。正常成功路径不增加等待或复制。

## 验证

扩展 `test:uv-composite-backpressure`，覆盖构造异常、DataCloneError、正在推进已有队列时失败、不同 owner 后续成功、位图清理、Worker 崩溃后重建，保留原替换/取消断言。新增用例在旧实现失败，修复后通过。

## 对应实现审计、迁移与回滚

SceneRoot 的 Worker/CPU fallback 使用原有顺序、完整尺寸和颜色空间；调用方继续处理任务拒绝。GPU 上传、shader、蒙版/投影、持久化与导出没有改动，不自动以实验核替代生产服务。像素算法与合成版本不变，无 Schema/资产迁移，Command/CAS/ownership/verified assets 不变。回滚仅恢复派发代码，会恢复队列锁死风险；无数据清理。完整验证见系统规范当日记录。
