# ADR-0005：单一 Project Repository 与 Cloud 数据面

- 状态：Accepted，PostgreSQL 事务适配器与多实例契约测试已实施
- 日期：2026-08-21

## 问题

项目路由、命令、资产、导出和文件夹服务曾直接调用文件系统实现。这样即使增加 PostgreSQL，也会形成“本地一套、服务器一套”的长期双实现：修复容易只落到一边，部署表现继续不一致。

## 决策

所有项目领域消费者只依赖 `ProjectRepository`。`fileProjectRepository` 服务隔离开发，`postgresProjectRepository` 服务多人 Cloud；二者在同一个选择点按 `LICLICK_PROJECT_REPOSITORY` 切换，不增加 Cloud 专用路由。架构门禁拒绝业务模块重新直接导入文件系统实现。

PostgreSQL 适配器当前以完整项目 JSONB 文档作为权威当前快照，同时把每一次 Revision 写入不可变历史表，并把 Command ID 与 SHA-256 幂等回执放进同一事务。每个查询都包含 `user_id`，更新采用 Revision compare-and-swap；任何实例检测到旧 Revision 时返回 409，不覆盖较新项目。

Cloud 数据蓝图位于 `apps/server/prisma/cloud.schema.prisma`，核心约束为：

- tenant、user、project ownership 进入每个权威查询条件；
- Project 保存当前 Revision 指针，Revision 文档不可变；
- Project Command 以命令 ID 和 SHA-256 建唯一幂等记录；
- 命令、Revision、当前指针和审计事件在一个 PostgreSQL 事务提交；
- Asset 表只保存对象元数据、哈希和状态，二进制不进入数据库或 BFF 内存。

## 对象存储流程

1. 浏览器请求绑定 tenant/project、文件大小、MIME、SHA-256 和短 TTL 的上传意图。
2. 浏览器直接上传对象存储；BFF 不代理普通贴图字节。
3. 完成接口验证对象头、实际大小、类型和哈希后，将 Asset 从 `pending` 置为 `verified`。
4. Project Command 只能引用当前项目内已验证的 Asset ID。
5. 下载使用短时签名 URL；浏览器按需缓存到 OPFS，缓存不成为权威数据。

## 已自动验证

- 两个独立 Repository 实例共享同一 PostgreSQL 引擎并发保存：恰好一个提交，另一个得到 `PROJECT_REVISION_CONFLICT`；
- 同一个 Command 同时到达两个实例：只生成一个 Revision，双方读取同一结果；
- 项目完整文档保留对象、参考图、捕获、生成结果、图层、烘焙贴图及 UV/烘焙 Pipeline；
- 账号 A/B ownership 隔离以及重命名、移动、复制、软删除通过；
- 每次提交产生连续、不可变的 Revision 历史。

自动测试使用内嵌 PostgreSQL 兼容引擎，不冒充生产数据库。上线前仍须在目标 PostgreSQL 上执行迁移、备份恢复和故障切换演练。

## 启用方式

1. 设置 `LICLICK_CLOUD_DATABASE_URL`；
2. 执行 `pnpm --filter @liclick/server db:cloud:migrate`；
3. 设置 `LICLICK_PROJECT_REPOSITORY=postgres`；
4. 先在单个灰度实例验证数据导入，再扩到多个 API 实例；配置错误会直接拒绝启动，不会静默回退文件存储。

## 切换条件

选择点已具备事务、并发、幂等和 ownership 自动验证；正式切换仍需完成目标环境迁移回滚、故障注入、备份恢复与文件到云端的一次性导入校验。不进行长期双写；旧文件存储只读保留到回滚窗口结束。
