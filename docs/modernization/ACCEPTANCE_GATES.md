# LI3D 现代化验收门禁

## 发布一致性

- [ ] Web 和 Server 报告同一 `releaseId` 与 `gitSha`。
- [ ] API、Project、Compute、Asset 协议版本可自动比较。
- [ ] 同一 SHA 的产物只构建一次，并按环境晋级而不是重建。
- [ ] 生产部署不执行 Git 操作和现场构建。
- [ ] 发布失败立即停止，生产可在三分钟内切回上一不可变版本。

## Cloud 零安装

- [x] Cloud Web 产物不包含本地组件安装器。
- [x] Cloud Web 产物不包含 `localhost:4618` 或本地运行时回退。
- [x] 从未安装 LI3D 组件的干净设备可以完成核心 E2E。
- [x] 清空浏览器缓存或重启服务后可以从云端恢复项目。
- [x] Photoshop/DCC 不属于莉刻核心流程依赖。

## 计算边界

- [x] 普通投影、图层合成、蒙版和视口交互使用浏览器 CPU/GPU，不要求安装本地组件。
- [x] WebGPU/WebGL2/WASM 后端按能力协商，不支持时显式降级。
- [x] Auto UV、自动拓扑和生产 PBR Bake 只提交真实服务集群，禁止静默切换到浏览器实验内核或模拟器。
- [x] UI 的 Worker、槽位、TLS、进度和错误来自真实状态/任务 API。
- [ ] 浏览器重任务支持取消、分块、进度、checkpoint 和设备丢失恢复。
- [ ] UV 与拓扑生产质量门禁通过；当前真实任务分别被 `UV_QA_FAILED` 与 `RETOPOLOGY_COORDINATE_MISMATCH` 阻断。

## 性能

- [ ] 静止编辑器不持续满帧渲染。
- [ ] 普通编辑 input-to-present P95 小于 50ms。
- [ ] 目标硬件帧耗 P95 满足 16.7ms/33ms 分级预算。
- [ ] 主线程没有持续超过 50ms 的 Long Task。
- [ ] 连续切换项目后 Texture、ImageBitmap 和 Worker 内存回落。
- [ ] BFF 只负责任务编排和受控数据转发，不承担 Substance/Asset Worker 的计算负载。

## 安全与数据

- [x] Cloud 项目写入只使用版本化 Command，并在重复投递时返回同一 Revision。
- [x] Command 幂等键、项目 Revision、项目资产清单和账号 ownership 在同一数据库事务提交。
- [ ] 独立审计事件与项目事务关联，并在生产 PostgreSQL、备份和恢复演练中验证。
- [ ] SSO Token 不进入浏览器持久存储，使用 Secure/HttpOnly 会话。
- [ ] 所有项目、资产和任务访问都验证 tenant/user/project ownership。
- [ ] 签名 URL 绑定对象、大小、类型、哈希和短 TTL。
- [ ] 文件魔数、像素、面数、压缩倍率和外部 URL 均有上限。
- [ ] 生产启用 CSP、COOP/COEP、CORP、nosniff 和权限策略。
- [ ] 数据 Schema 有升级、降级策略和迁移测试。
- [ ] Lockfile、依赖、许可证、Secret、SBOM 和产物哈希进入 CI。
