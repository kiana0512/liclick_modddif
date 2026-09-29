# 资产传输回归避免 Fetch 禁用端口

- 日期：2026-09-29；状态：本地真实 HTTP 回归通过，待完整推送前验证。
- 主模块 M15；契约 `ASSET-TRANSFER-TEST-PORTS/1.0.0`。无业务算法、Schema、Project Command/Revision、ownership、资产或生产网络配置变化。
- 根因：完整推送前验证的 `test:asset-transfer` 在应用服务 `/login` 请求处报 `TypeError: fetch failed`、`bad port`。现有测试只为对象存储服务避开 WHATWG Fetch 禁用端口，而内部存储和应用服务仍直接使用 Windows 分配的随机端口。
- 改动：三个真实 HTTP fixture 共用有界的端口选择过程，遇到禁用端口关闭并重选，最多十次；仍使用真实 Fetch 测试签名上传、下载、代理和完整性。
- 验证：`node apps/server/scripts/test-asset-transfer.mjs` 通过；最终提交再运行完整 `verify:prepush` 和远端 CI。
- 迁移/回滚：无生产迁移。还原测试监听方式会恢复端口随机失败，不影响生产服务。
