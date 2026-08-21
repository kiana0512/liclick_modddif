# ADR-0004：版本化 Project Command 与幂等写入

- 状态：Accepted，第一步已实施
- 日期：2026-08-21

## 问题

旧客户端通过多个 `PUT/PATCH/POST` 接口直接修改项目。网络超时后，客户端无法判断服务器是否已经完成写入；盲目重试可能重复执行，放弃重试又可能让界面与权威数据不一致。随着 Cloud 多端编辑和存储迁移，这种行为无法可靠审计或放入数据库事务。

## 决策

Cloud 项目写操作统一表示为 `ProjectCommand`：

- `schemaVersion` 固定命令协议版本；
- `id` 是客户端为一次用户意图生成的幂等键；
- `projectId` 和 `expectedRevisionId` 绑定目标及其前置 Revision；
- `kind` 与结构化 `payload` 取代任意路由副作用；
- `issuedAt` 用于审计，不参与并发胜负判断。

服务器按用户和项目串行处理命令。命令成功后，项目保存一个有界的 `{ id, sha256 }` 日志，并在项目私有 `.commands` 目录写入回执。同一命令重放直接返回当前结果，不生成新 Revision；同一 ID 携带不同内容则返回 `409 PROJECT_COMMAND_ID_REUSE_CONFLICT`。即使进程在项目写入后、回执写入前中断，项目内日志也能恢复回执而不重复执行。

## 当前兼容边界

- Cloud Web 的保存、重命名、移动已走 `/api/projects/:id/commands`。
- 网络错误和超时只使用原命令 ID 重试一次。
- `desktop-legacy` 暂时保留旧 `PUT/PATCH/move` 接口，避免一次性替换导致功能回归。
- 删除、复制、资产上传尚未转成 Project Command；它们必须在相应领域契约和对象存储方案落地后迁移。

## 下一步

文件回执是迁移期实现，不是最终 Cloud 数据库。PostgreSQL 适配器应在一个事务中写入命令唯一键、项目 Revision、资产清单和审计事件；对象二进制通过短时签名 URL 由浏览器直传对象存储。数据库唯一约束继续执行同一幂等语义，不能另造第二套协议。
