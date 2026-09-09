# 单视图回贴等待优化

主模块 M04；协作 M05/M06/M12。SINGLE-VIEW-AUTO-PROJECTION v1.1.0，维护版本 2.19.11。

## 证据与范围

- GeneratePanel 原先对单视图和多视图均 beginProjectedPreviewBatch，直到投影事务的 saveCriticalProjectState 和本批补偿检查结束后才 end。layerStore 在冻结期间保留旧 projectedPreviewLayers；SceneRoot 消费该快照，因此即使新图层已创建仍不能开始显示。工程保存延迟被串到视口准备之前。
- 上一版新增后台恢复每 5 秒检查，恢复结果在两次检查之间到达时还需等下一轮。该等待与真实生成耗时无关。
- 以上是代码与受控时序证据，不冒称已测量用户 A100 的 2–3 秒全部由此导致；解码、上传和 GPU 材质编译仍可能耗时。

## 实施

1. 仅多视图请求保留整批冻结。单视图仍先确认图片/蒙版/深度资产上传完成，再通过原 addProjectedLayerFromGeneration 发布，视口准备与后续工程 CAS 保存可重叠。
2. Generation 变化及生成锁释放时立即唤醒同一个恢复器；复用 in-flight 去重，保留 5 秒重试及 online/focus 唤醒，卸载清理对应回调。
3. 不提前发布非持久化 URL，不跳过保存，不提交重复生图，不降低图像分辨率或绕过材质驻留安全检查。

## 一致性与验证

Layer、Project Command 幂等、Revision CAS、ownership、verified assets 不改。GPU/CPU/Worker/shader、原投影覆盖/深度/边缘算法、UV 合成和导出不改；多视图冻结逻辑保持。无 Schema/资产迁移。

时序回归执行生产投影事务与真实 batch 条件分支，故意挂起工程保存：单视图保存未结束时新图层已可进入渲染，多视图仍保持旧快照。沿用并发、删除、取消、切项目与上传失败恢复测试。实际用户模型的首帧耗时需部署后验收，不承诺零延迟。

回滚恢复 GeneratePanel 的无条件 begin/end 批冻结及移除 Generation 变化唤醒 effect；保留上一版自动投影恢复能力，不改已保存数据。

验证记录：101 项完整 Web 回归、TypeScript、修改文件 lint、Cloud 生产构建与 artifact 检查通过。新增恢复器真实 effect 回归覆盖在途新结果即时补检查、无并行重复上传、5 秒失败兜底及卸载清理。包体 82 chunks / 3,150,180 bytes，通过现有 3,150,750 总量及各 chunk 门禁；本次未调整预算。尚未推送或部署 A100。
