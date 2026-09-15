# 云端局部重绘保存门禁修复

- 主模块 M12，协作 M04/M08，入口 UI-05。
- 算法/策略：GENERATION-SERVER-PERSISTENCE/1.0.0。

## 原因与范围

A100 项目实际 workspaceMode 为 cloud-server。GeneratePanel 的 persistGeneratedImage 只接受 local-server，因此直接返回临时 blob URL；GPT 分支随后拒绝它，显示“原始选区尚未保存”，未提交远端任务。同期没有新增数据库 OOM 或服务端错误，和此前资源上传查询导致的数据库压力不同。

增加已有服务端枚举的前端类型与共用精确判定，生成面板的图片、Capture 四平面、参考图、关键状态、投影结果保存同时接受 cloud-server 和兼容 local-server。关键保存合并到最新 Revision，并保留 latest / savedProjectSnapshot 的 workspaceMode。离线/未知模式仍不上传，不增加部署方式或端点。

## 安全及对等路径审计

- 不取消原始选区 durable URL 校验。上传或关键保存失败、用户取消均不得进入 GPT 付费提交。
- 已保存同源资源仍复用；Blob/数据图上传共用既有三并发队列和鉴权 API。
- 保留 Command 幂等、Revision CAS、对象归属、删除状态与项目级写锁；不修改数据库限制或重启数据库。
- GPU、CPU、Worker、shader、相机/法线/深度/作者 mask、投影/UV、导出算法与图像分辨率完全不改；只将原有资产按原像素上传保存。
- 不扩展到 EditorPage 中与本次生成门禁无关的旧模式检查。

## 验证

test-generation-server-persistence.mjs 执行实际面板持久化函数和 GPT 提交分支（仅模拟传输，不付费）：cloud/local 两种项目、四平面资源和冻结相机、参考图、持久 URL 重用、保存等待期间零提交、上传失败/保存失败/取消零提交、云端模式保留、未知/离线模式不上传。既有单视图投影测试加载同一实际模式判定函数。

完整回归、发布检查和实际部署结果以执行记录为准，不将单元测试称为真实远端生图验收。

## 迁移与回滚

无数据库 Schema、资产或历史任务迁移；cloud-server 已由生产后端使用，本次只修复前端兼容。失败且未提交的任务不自动重提，用户选区留在当前页面。回滚本提交可恢复旧代码，但云端重绘将再次被错误拦截；不得删除修复后保存的资源。未请求改变数据库或其他项目。
