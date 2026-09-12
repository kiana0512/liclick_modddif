# CHG-20260912-CLOUD-AUDIT-HARDENING

- 主模块：M01、M02、M12、M15
- 边界契约：`CLOUD-RUNTIME-BOUNDARY` v1.1.0
- 目标：修复全仓审计发现的退役运行时残留、Revision CAS 旁路、扫描盲区、过期冒烟断言和已知依赖漏洞。

## 修复

- Release Manifest 只允许 `cloud/development` 与 `web/server`，生产默认 Cloud；删除 `desktop-legacy`、`local-agent` 的合法契约。
- 删除非 Cloud 环境可省略 `expectedRevisionId` 的工程文件更新旁路，所有运行模式共用 Revision CAS。
- Cloud 边界检查覆盖 Web、Server 和 Contracts，并禁止退役运行时、adapter 与 4618 地址重新进入生产源代码。
- 删除服务端对退役安装器路径的专门运行时代码；该不存在静态资源仍由普通 404 处理。
- 同步当前 OAuth 固定 callback/target_url 与 Bake Set high 输入语义的冒烟断言。
- 升级 `sharp` 并用 pnpm overrides 修复审计中的 `browserslist`、`baseline-browser-mapping`、`fflate`、`nanoid`、`postcss` 传递依赖。

## 数据、兼容与迁移

Project/Layer/Generation/Capture Schema 不变，不批量改写历史 Revision 或资产。CAS 收紧会拒绝原本仅在非 Cloud 可无条件覆盖的调用；这是退役路径删除，不提供兼容开关。Cloud verified assets、ownership 与 Command 幂等契约保持。

## 验证与剩余边界

生产依赖审计为 0 已知漏洞；Contracts、Cloud boundary、pipeline persistence、OAuth、Bake-high 与 Web smoke 通过。Release readiness 中依赖真实 Cloud 凭据/服务或仍标记 in-progress 的 8 项能力未伪造为已完成，需在有授权的发布环境继续验收。

## 回滚

依赖锁可独立回退；运行时枚举、CAS 和边界扫描不应回退，因为回退会重新允许仓库准则明确禁止的本地运行时或无 CAS 写入。若新依赖出现兼容故障，应升级/定向修复，不能恢复已知漏洞版本。
