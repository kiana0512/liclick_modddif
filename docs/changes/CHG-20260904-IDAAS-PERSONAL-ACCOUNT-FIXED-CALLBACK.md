# CHG-20260904 IDaaS 个人莉刻账号固定回调

## 范围

- 主模块：M13 身份、授权与平台边界。
- 协议：`LICLICK-ACCOUNT-BINDING` v1.2.0 → v1.3.2。
- 目标：每个飞书用户授权并使用自己的莉刻账号进行生图、编辑、任务查询和后台历史查看；生产模式不使用固定公共账号。

## 根因

现有个人绑定已按 `cloud_users.id` 分配独立 Atlas home，也会校验 Atlas email 与当前飞书 Session email，但 IDaaS 发起地址仍按 OAuth 方式动态附加 `redirect_uri?loginId=...` 和 `state`。IDaaS JWT 应用的回调地址由应用侧固定登记，SP 发起流程使用 `target_url`，因此动态回调无法匹配官方协议。

当前生产 ingress 挂载在域名根路径。线上探测结果为 `/api/liclick/account-binding/callback` 命中服务端并返回未登录 JSON，`/li3d/api/liclick/account-binding/callback` 落入 SPA HTML；生产应登记：

`https://li3d.lilithgames.com/api/liclick/account-binding/callback`

## 修改

- 注册回调只由公开站点 origin 和 `LICLICK_PUBLIC_PATH` 生成，不包含用户或任务参数。
- IDaaS SP 发起地址移除动态 `redirect_uri` 与 OAuth `state`，改为官方 `target_url`。
- `target_url` 只携带十分钟有效的随机绑定 UUID，并固定为同源 `/api/liclick/account-binding/complete?loginId=...`。
- GET 和 POST 回调均校验目标的 origin、pathname、唯一参数、无 fragment 和 UUID 格式；目标不用于重定向，避免开放跳转。
- 浏览器取得 GET 模式返回的令牌后立即清除地址栏 query/fragment，再通过同源 Cookie 的 JSON POST 交给 Atlas loopback-only bridge。
- 继续校验当前飞书 Session、绑定任务 ownership、Atlas secure cache、有效期、莉刻服务权限和双方 email 一致性；成功后只保存当前用户的独立 Atlas home。

## QA IDaaS 配置

1. QA JWT 测试应用为 `LI3D-QA`，应用 ID `testplugin_jwt92`，SSO Binding 为 `REDIRECT / GET`。
2. 固定登记 `https://li3d.lilithgames.com/api/liclick/account-binding/callback`；不要追加 `/`、`loginId`、`state` 或其他动态参数。
3. QA 应用已长期授权 `kianaren@lilith.com`、`haoze.yu@lilith.com`、`alonshi@lilith.com`；新增用户仍须由 IDaaS 管理员授权。
4. Cloud 配置启用 QA SP 地址 `https://qa-idaas.lilithgames.com/enduser/sp/sso/testplugin_jwt92`，`enterpriseId=test`；应用 ID 属于非秘密配置，PublicKey/私钥或短期令牌不得提交 Git。
5. 分别用三名飞书用户扫码登录并授权，确认绑定邮箱、Atlas home、莉刻生成记录与后台历史互不串用；再验证 A 不能轮询 B 的任务。
6. QA 通过后创建或更新生产 JWT 应用，保持相同固定回调及用户组授权，并将 Cloud 配置替换为生产 SP 发起地址/企业标识后再次走发布门禁。

## 本地 4517 兼容修复

- `LI3D-QA` 只供显式配置 `IDAAS_JWT_SSO_ENABLED=true` 的服务器环境使用。
- 本地真实联调不启用该开关，恢复 Atlas SkillHub 原生授权 URL，由运行时使用协议固定的 `redirect_uri=http://localhost:20265/callback` 直接接收令牌并写安全缓存；随机 loopback 端口只用于 Cloud 内部 bridge。
- v1.3.0 曾无条件把本地浏览器切到 Cloud 固定回调协议；尝试恢复带动态 `loginId` 的 LI3D callback 又会被 IDaaS 的精确 Service 校验拒绝。v1.3.1 不再让本地经过 LI3D callback，而在 Atlas 子进程成功退出后校验并绑定其个人 Atlas home。
- Cloud 继续由固定 LI3D callback 接收令牌并转交 loopback-only Atlas bridge；两种模式都保留个人 Atlas home、工具权限及邮箱一致性门禁。

## K8s 个人凭据模式修复

- Atlas SkillHub 2.9.1 会因 `KUBERNETES_SERVICE_HOST` 等云环境信号自动切换为 ArkClaw/TIP-only，即使用户独立 Atlas home 中已存在有效 IDaaS Token，后续 `status`、`list-tools` 和业务调用仍会错误要求公共 `VE_TIP_TOKEN`。
- LI3D 仅在为明确的用户独立 Atlas home 启动 Atlas 子进程时移除 `KUBERNETES_SERVICE_HOST`、`VE_TIP_TOKEN` 及 ArkClaw/workload 自动探测信号，使 Atlas 读取该用户安全缓存。未指定个人 home 的机器级调用继续继承原环境并保持 TIP 行为。
- 该处理不把用户 Token 放进环境变量，不修改 Pod 主进程环境，也不允许个人任务回退到公共 TIP Token。

## 不变项

- `LICLICK_SHARED_TEST_ACCOUNT_ENABLED` 仍默认关闭；本变更不启用、创建或回退到公共账号。
- 不改变 Project Command 幂等性、Revision CAS、Project/Layer/Capture/Generation Schema、对象 ownership 或 verified assets。
- 不改变生图、投影、UV、重绘、GPU/CPU/Worker/shader 或输出分辨率。
- 不恢复 Windows 本地组件、localhost/4618、安装器、端点切换或本地凭据托管。

## 迁移与回滚

- 无数据库或资产迁移。既有合法个人绑定继续有效；部署时尚未完成的十分钟临时绑定由用户重新发起。
- 回滚可切回前一 Cloud 镜像，或先将 `IDAAS_JWT_SSO_ENABLED=false` 暂停新的账号绑定；均保留所有已绑定 Atlas home 和用户数据。
- 本地不得回滚到无条件固定 callback/`target_url` 的 v1.3.0 行为，否则清空缓存后的重新授权会再次失败。
- 不得以恢复动态回调、共享默认账号、共享 `ATLAS_TOKEN_FILE` 或删除个人凭据作为回滚方式。

## 验证

- `pnpm --filter @liclick/server test:liclick-personal-account`
- 服务端 typecheck、lint、Cloud/repository boundary 与 `git diff --check`
- QA 环境双用户端到端授权、生图、后台历史与跨用户任务拒绝
