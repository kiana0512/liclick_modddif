# Cloud 存储盘点提速、对象隔离区清理与设置请求退避

## 范围

- 日期：2026-09-16
- 主模块：M14 数据与对象存储
- 界面入口：UI-16 存储与清理
- 协作模块：M01 Cloud 工程、M12 状态与历史、M13 Cloud 集成、M15 测试与发布
- 算法版本：`ASSET-LIFECYCLE-GC` v0.4.0、`LOCAL-SETTINGS-REFRESH` v1.1.0
- 分类协议：`STORAGE-INVENTORY-001/4`

## 问题与根因

生产 K8s server 在 4 GiB cgroup 下触发 V8 `Reached heap limit` 并进入 CrashLoop。Cloud 盘点旧实现同时读取账号全部 `asset_transfers.record_json`、全部当前工程与全部 Revision `document_json`，在 Node 中建立三份引用集合和完整候选数组。内存峰值随账号历史总量增长；提高到 8 GiB 与 `--max-old-space-size=6144` 只能止血，不能消除再次 OOM 的增长趋势。

同一时段前端每 3 秒固定读取 `/api/local-settings`。server 忙碌或重启时，请求持续得到 502 且没有单飞或退避，进一步增加入口请求与日志压力。

首轮生产修复后，Cloud 扫描在 826 条工程/Revision 引用阶段仍需要约 2 分钟。每 8 条文档先查询 assetId，再由 Node 发第二条 JSONB 批量插入，数据库往返和事务设置次数成为主要固定成本。Cloud 隔离区同时只统计为 trash，`purgeSupported=false` 使生产对象永远无法从显式二次确认入口物理释放。

## 实现

1. PostgreSQL 从每页 JSONB 文档中原生提取 assetId，Node 不接收完整 Project/Revision JSON。
2. 当前工程以 `project_id`、Revision 以 `(project_id, revision_number)`、资产以 `intent_id` 做键集分页；v0.4.0 默认文档 32 条、资产 256 条。
3. 新增 `asset_storage_inventory_scan_references` 暂存表。引用按 `current > history > trash` 在数据库去重；资产分页通过同一 scanId JOIN 得到分类。
4. 未引用候选每页批量写入。扫描完成后在事务中更新 snapshot 并移除旧候选；失败只删除本次暂存，上一份 ready 快照及候选不变。
5. 盘点 SQL 使用 45 秒 `statement_timeout`。超时返回明确失败状态；显式“重新扫描”可立即重试，普通 GET 不会无限重启失败扫描。
6. local-settings 刷新保持单飞，只在页面可见时执行；成功间隔 60 秒，失败按 30、60、120、240、300 秒退避。
7. 生产 `node-postgres` 的 JSONB 批次参数显式序列化为 JSON 文本，避免 JavaScript 数组被编码为 PostgreSQL array；PGlite 与生产参数适配器均覆盖。
8. v0.4.0 将默认文档页从 8 提到 32，并用单条 PostgreSQL data-modifying CTE 完成“键集取页、assetId 提取、引用优先级 upsert、返回下一游标”。Node 不再接收每页引用数组，也不再为同一页执行第二次写入；每 256 条文档的数据库往返由约 64 次降为约 8 次。
9. 完成扫描后保留当前 ready scan 的引用索引；新扫描只清理非当前快照的暂存引用，完成时原子替换。`STORAGE-INVENTORY-001/4` 强制旧快照重扫，避免旧版本没有保留引用索引时允许物理删除。
10. Cloud 隔离区容量只统计 `asset_storage_quarantine` 中仍拥有 verified transfer、未恢复、未删除且不在当前 ready 引用索引中的对象，不再把软删除工程的全部 trash 冒充可永久清空空间。
11. 新增持久化 Cloud purge job 与 item 快照。用户输入“永久删除”后，任务以用户级锁和幂等键认领对象，最多 4 并发发送签名 `DeleteObject`；404 视为幂等成功。每个对象成功后才在同一数据库事务删除 transfer 元数据、写 quarantine `deleted_at` 与 item 完成状态。Pod 重启后，状态读取会从 pending item 继续，已删对象可安全重放。

内存上界由“账号全部文档 + 全部资产 + 全部候选”降为“数据库单页 + 单页候选”。数据库暂存容量仍随唯一引用数增长，但不进入 Node 堆，并受 scanId、账号和迁移表约束。

## 兼容与安全

- current/history/trash/temporary 的可达性优先级保持 current > history > trash > temporary；重新被引用的隔离对象恢复为引用所属分类，并从可物理清空摘要排除。
- 不更改 Project Command 幂等、Revision CAS、ownership、verified assets 或对象 key。
- 不更改 GPU、CPU、Worker、shader、投影、UV、局部重绘、导出、QA 或输出分辨率。
- `004_asset_storage_v2_shadow.sql` 以 `CREATE TABLE IF NOT EXISTS` 增加 purge job/item 表；无需回填历史工程或对象。`/3` 快照首次读取会自动执行 `/4` 重扫，再开放 Cloud 清空入口。
- PNG canonical 无损压缩、内容寻址去重与 Cloud 物理删除仍按原设计门禁保留，本次不自动重编码正式资产。

## 验证

- `pnpm --filter @liclick/server test:storage-management`
  - PGlite 验证 current/history/trash 引用投影、跨页资产分类、批量候选写入与 cleanup 幂等。
  - 5.6 MB 单工程 JSON 只返回 assetId，Node 侧序列化结果小于 1 KiB。
  - statement timeout 通过仓储端口生效。
  - 单条 CTE 分页直接写入 current/history/trash 引用，并保持跨页优先级。
  - Cloud purge job 幂等、用户隔离、对象 item 快照、元数据完成和恢复后排除。
- `pnpm --filter @liclick/server test:asset-transfer`
  - S3 SigV4 DELETE、成功删除与对象已不存在幂等删除。
- `pnpm --filter @liclick/web test:global-auth-gate`
  - 拒绝恢复 3 秒固定 local-settings 轮询；要求单飞与有界退避。
- server/web typecheck 与发布门禁在提交前执行。

## 迁移与回滚

部署先执行既有 Cloud migration，再启动新 server。旧 snapshot 和候选保留；`/3` 快照首次读取自动以 v0.4.0 执行器重建 `/4` 引用索引。活动 purge job 与 item 持久化在 PostgreSQL，滚动重启后继续。

回滚前停止活动 storage scan 和 purge job，再回退 server/web 镜像。引用、purge job/item 表必须保留以便审计和继续任务；旧镜像会把 Cloud purge 显示为不可用，但不得删除仍为 pending 的 item 或把它们标成完成。不得删除 snapshot、candidate、quarantine、Project、Revision 或对象资产。若对象已成功删除但数据库完成事务尚未提交，恢复 v0.4.0 后利用 DeleteObject 幂等语义继续；不得手工伪造 transfer。回滚会恢复较慢扫描与无法物理释放 Cloud 隔离对象的问题。
