# Cloud 存储盘点有界化与设置请求退避

## 范围

- 日期：2026-09-16
- 主模块：M14 数据与对象存储
- 界面入口：UI-16 存储与清理
- 协作模块：M01 Cloud 工程、M12 状态与历史、M13 Cloud 集成、M15 测试与发布
- 算法版本：`ASSET-LIFECYCLE-GC` v0.3.4、`LOCAL-SETTINGS-REFRESH` v1.1.0
- 分类协议：`STORAGE-INVENTORY-001/3` 保持不变

## 问题与根因

生产 K8s server 在 4 GiB cgroup 下触发 V8 `Reached heap limit` 并进入 CrashLoop。Cloud 盘点旧实现同时读取账号全部 `asset_transfers.record_json`、全部当前工程与全部 Revision `document_json`，在 Node 中建立三份引用集合和完整候选数组。内存峰值随账号历史总量增长；提高到 8 GiB 与 `--max-old-space-size=6144` 只能止血，不能消除再次 OOM 的增长趋势。

同一时段前端每 3 秒固定读取 `/api/local-settings`。server 忙碌或重启时，请求持续得到 502 且没有单飞或退避，进一步增加入口请求与日志压力。

## 实现

1. PostgreSQL 从每页 JSONB 文档中原生提取 assetId，Node 不接收完整 Project/Revision JSON。
2. 当前工程以 `project_id`、Revision 以 `(project_id, revision_number)`、资产以 `intent_id` 做键集分页；默认文档 8 条、资产 256 条。
3. 新增 `asset_storage_inventory_scan_references` 暂存表。引用按 `current > history > trash` 在数据库去重；资产分页通过同一 scanId JOIN 得到分类。
4. 未引用候选每页批量写入。扫描完成后在事务中更新 snapshot 并移除旧候选；失败只删除本次暂存，上一份 ready 快照及候选不变。
5. 盘点 SQL 使用 45 秒 `statement_timeout`。超时返回明确失败状态；显式“重新扫描”可立即重试，普通 GET 不会无限重启失败扫描。
6. local-settings 刷新保持单飞，只在页面可见时执行；成功间隔 60 秒，失败按 30、60、120、240、300 秒退避。

内存上界由“账号全部文档 + 全部资产 + 全部候选”降为“数据库单页 + 单页候选”。数据库暂存容量仍随唯一引用数增长，但不进入 Node 堆，并受 scanId、账号和迁移表约束。

## 兼容与安全

- 不更改 current/history/trash/temporary 分类、隔离恢复窗或永久删除策略。
- 不更改 Project Command 幂等、Revision CAS、ownership、verified assets 或对象 key。
- 不更改 GPU、CPU、Worker、shader、投影、UV、局部重绘、导出、QA 或输出分辨率。
- `004_asset_storage_v2_shadow.sql` 以 `CREATE TABLE IF NOT EXISTS` 增加暂存表；无需回填历史工程或资产。现有部署迁移入口在 server 启动前执行。
- PNG canonical 无损压缩、内容寻址去重与 Cloud 物理删除仍按原设计门禁保留，本次不自动重编码正式资产。

## 验证

- `pnpm --filter @liclick/server test:storage-management`
  - PGlite 验证 current/history/trash 引用投影、跨页资产分类、批量候选写入与 cleanup 幂等。
  - 5.6 MB 单工程 JSON 只返回 assetId，Node 侧序列化结果小于 1 KiB。
  - statement timeout 通过仓储端口生效。
- `pnpm --filter @liclick/web test:global-auth-gate`
  - 拒绝恢复 3 秒固定 local-settings 轮询；要求单飞与有界退避。
- server/web typecheck 与发布门禁在提交前执行。

## 迁移与回滚

部署先执行既有 Cloud migration，再启动新 server。旧 snapshot 和候选无需重建；用户显式重新扫描时采用 v0.3.4 执行器。

回滚前停止活动 storage scan，再回退 server/web 镜像。`asset_storage_inventory_scan_references` 只保存暂存引用，可保留；确认没有活动扫描后也可独立删除。不得删除 snapshot、candidate、quarantine、Project、Revision 或对象资产。回滚会恢复全量加载的 OOM 风险，因此生产回滚优先恢复上一镜像并暂时关闭重新扫描入口，而不是仅依赖扩大内存。
