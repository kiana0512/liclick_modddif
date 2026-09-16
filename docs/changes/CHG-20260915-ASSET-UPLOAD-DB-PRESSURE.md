# 图片上传目录校验与并发收敛

- 主模块 M14/M12，协作 M04/M08；算法 PROJECT-ASSET-LOOKUP/1.0.0、WORKSPACE-ASSET-UPLOAD-QUEUE/1.0.0。
- 证据：A100 项目上传 POST /api/projects/.../assets 返回 500 / Connection terminated unexpectedly；服务日志出现数据库恢复中。诊断期间数据库 cgroup 的 oom_kill 从 26 增至 28，内存上限 1GiB。目标项目 document_json 的 pg_column_size 为 45,367,375 字节（存储大小，不是单图大小或精确内存峰值）。未取得内核按请求归因日志，不声称已证明每次故障的唯一触发语句。
- 后端 findSlug 原本调用 selectProject 取出完整 document_json；改为 SELECT slug，保留 user_id、project_id 与 deleted_at IS NULL。load/save/事务锁、Project Command 幂等与 Revision CAS 不变，不缓存或绕过归属校验。
- 前端资源 API 共用 FIFO 上传队列，浏览器运行实例内最多 3 个活动上传；自动保存、多视图截图、远端 URL 导入和 Blob 上传共用，不为每个批次另开 3 个槽。不同项目仍传自己的项目 ID，不合并资产。队列等待发生在传输超时计时之前，异常和同步抛错均释放槽；已等待任务按原 Promise.all 语义完成，不新增取消或自动重提付费任务。
- 直传完整 intent→PUT→complete 与原有 503 代理回退占同一槽，避免嵌套取槽死锁；data URL 转 Blob 后只在 Blob 上传处取槽。JSON 上传复用相同实现，保留 45/60 秒超时与凭证语义。
- 范围：只改变查询列和资源 I/O 调度。GPU/CPU/Worker/shader、Capture 的结合图/法线/作者 mask/depth、冻结相机、原像素/分辨率、回贴/UV/export、图像 QA 与保存屏障均不变；未压缩、缩图或删除任何工程内容。
- 测试：真实 PostgreSQL 兼容引擎上的 repository 回归检查大文档查询只返回 slug、跨用户/缺失/删除项目拒绝，以及原完整加载、事务、幂等和冲突保护。真实 API 源码配合假传输检查两种构建模式、30 个混合上传跨项目共享 3 槽和 Blob 字节不变；60 个调度任务验证 FIFO、失败释放与后续可用。
- 限制：并发上限按浏览器运行实例生效，不跨标签页或用户；完整项目保存本身仍可能读取大 JSON。这次不迁移内嵌图片，不改数据库 1GiB 限制、连接池或其他项目服务，不承诺消除全部 OOM。正式数据不做压力复现或付费生成。
- 迁移：无 Schema、历史数据或资产迁移。服务器/前端可独立回滚，建议成套发布；回滚恢复代码即可，保留所有项目、成功结果和 verified 资产，旧页签须刷新才能使用队列。
