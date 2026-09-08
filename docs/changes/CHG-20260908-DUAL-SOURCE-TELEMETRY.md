# A100 / 正式站登录与使用统计

主模块 M13，协作 M15；契约 `IDENTITY-TELEMETRY` v1.1.0，日聚合 schema v3。

## 行为

仅覆盖 http://10.3.2.59:44770 与 https://li3d.lilithgames.com。
两个部署各自持久化并同步同一张飞书表；来源分别为 A100、正式站。
聚合键为日期、用户、工具版本、宿主版本、来源，来源加入哈希。
来源由后端 LICLICK_TELEMETRY_SOURCE 配置；这两个已知公开 origin 可自动识别。
客户端不能提交来源，也不能向 /api/events 提交 login_success。
飞书 OAuth 校验完成且创建 Li3D 会话后，记录一次 login_success；独立于后续莉刻账号绑定。
事件 ID 由一次性 OAuth 任务 ID 哈希生成，重复调用去重；不保存 OAuth state/code/token。
登录次数是 auth_login_count，功能使用列继续使用原 module_action 计数。
登录事件不伪造客户端版本，所以可能与带版本的使用事件分行；汇总登录次数按日期、用户、来源求和。

## 迁移

首次启动为无 source 的旧事件赋予该部署来源并原子落盘，再重建 v3 聚合。
已带来源的记录不随配置变化重新归属。新聚合键不沿用旧飞书 record_id，避免改写来源不明的旧行。
飞书已有历史行保留；旧表数据来源未确认前，不与新增来源明确的行混合统计，避免重复。
不回填此前未采集的登录次数。Project、Revision、资产、个人凭据不变。

## 上线前置

确认表中完整原有字段，加普通文本 来源、数字 登录次数。
目标 U1IhbUlrlaFRFJsHB4rcJKgAnsd / tblFHaZQY9UBDEop。
正式配置在 deploy/k8s/overlays/zprod/server-config.zprod.env；
A100 使用运行目录 runtime/app.env，显式 LICLICK_TELEMETRY_SOURCE=A100。
先备份各自 telemetry 目录，再发布代码并开启同步；单个来源保持一个写进程。
2026-09-08 字段读取权限已恢复，已核对原有字段并创建 来源（文本）与 登录次数（数字）。

## 验证

回归覆盖两来源同用户同日键隔离、真实汇总映射、登录幂等、旧事件来源落盘、拒绝客户端伪造及同步状态。
发布后分别由用户真实登录并操作功能，核对飞书 来源、登录次数、对应功能计数；不得写虚假生产测试事件。

## 回滚

先关闭 FEISHU_BITABLE_SYNC_ENABLED，再回退代码，保留日志、v3 聚合和飞书新字段。
旧程序不能读取新增来源维度作正确汇总，禁止回退后继续向表写入旧聚合键。
恢复修复版后由原始事件重建即可；不删除历史表行或用户数据。

验证记录：后端全部 14 项回归逐项通过（原 telemetry 字段集合断言更新后单独复测通过）；修改源码和新增测试 lint、TypeScript 编译、diff 检查通过。A100 隔离目录以实际运行模块加最小补丁执行双来源回归通过。
