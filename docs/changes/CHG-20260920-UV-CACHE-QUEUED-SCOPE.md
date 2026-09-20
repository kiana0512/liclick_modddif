# UV 压缩缓存排队 scope 保留

- 主模块：M07；协作：M06/M09/M15。
- 契约：`UV-DISPLAY-DERIVED-CACHE/1.4.1`，L1 参数传递修订。
- 状态：本地修复，未提交、推送或部署。

## 问题与修改

编码忙时只保留最新完整 UV，队列保存了 scope，但出队递归 offer 漏传 scope；Worker 因此不会写该状态的 active pointer，刷新预恢复可能失去命中。修复只补传出队项自己的 scope，不借用上一次任务的账号/项目身份。

## 验证

扩展 `test:resident-uv-display`，三个待压缩状态各用不同 scope/key，检查仅第一项与最新项被转移，最新项保持自己的 persistentKey/scope，被替换项未转移，dispose 后不再发送。新增断言旧实现失败、修复通过。既有真实压缩 Worker 测试继续验证字节无损、同 scope 恢复、不同 scope/key 拒绝、损坏字节拒绝、四状态预算与释放。

## 对应实现审计、迁移与回滚

Worker 的 pointer/压缩格式及 SHA-256 验证未改；主线程仍在发布前比较完整 verified key。GPU/CPU/shader/投影/UV/export 像素、作者资产、完整分辨率和 QA 不变；Schema/Command/CAS/ownership/verified assets 保持。无格式迁移；旧无 pointer 的可丢弃派生缓存仍按原精确恢复/重算，不回填不可信身份。回滚只撤回参数透传，会恢复排队缓存预恢复 miss，不删除作者数据。完整验证见系统规范当日记录。
