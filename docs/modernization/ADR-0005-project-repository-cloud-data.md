# ADR-0005：单一 Project Repository 与 Cloud 数据面

- 状态：Accepted，边界已实施，PostgreSQL 适配器待实施
- 日期：2026-08-21

## 问题

项目路由、命令、资产、导出和文件夹服务曾直接调用文件系统实现。这样即使增加 PostgreSQL，也会形成“本地一套、服务器一套”的长期双实现：修复容易只落到一边，部署表现继续不一致。

## 决策

所有项目领域消费者只依赖 `ProjectRepository`。当前 `fileProjectRepository` 是迁移期唯一实现；架构门禁拒绝其他模块重新直接导入 `projectFileService`。Cloud PostgreSQL 适配器必须替换同一个选择点并通过同一套契约/并发/幂等测试，不能增加另一组 Cloud 专用路由。

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

## 切换条件

在 PostgreSQL 适配器具备迁移回滚、故障注入、并发、幂等、ownership 和恢复测试前，选择点不得切换。切换时执行一次文件到云端导入与校验，不进行长期双写；旧文件存储只读保留到回滚窗口结束。
