# 官方生产 IDaaS 应用接入与验收

- 主模块：M13 身份、账号绑定；关联 M15 部署验证。
- 协议：LICLICK-ACCOUNT-BINDING v1.3.3 → v1.3.4（配置 Patch）。
- 负责人：Codex 实施，维护者与 IDaaS/Atlas 运维验收。
- 状态：本地修改，尚未发布；不声明生产绑定成功。

## 证据与决定

2026-09-08 维护者明确要求复用官方生产应用，停止将 LI3D-QA 作为正式接入。运维聊天回复“直接按照你的方案配置了，你验证下”，但没有提供实际应用/回调配置读回，因此只作为已处理的通知。

当天从真实网站首页点击当前用户的“绑定”，页面仍显示 `HTTP 401 invalid_token / token validation failed`。无会话 GET `/api/health` 显示 `release-2c49d521`、Atlas SkillHub 2.9.1；这证明运行版本，不能单独证明 Pod 当前所有环境变量。仓库的 base ConfigMap 仍是 QA IDaaS/test Gateway，CI 使用的 zprod overlay 没有覆盖这组值。

回调只读探测：`/api/liclick/account-binding/callback` 返回 401 JSON `Authentication required`（正常认证门禁）；`/li3d/api/liclick/account-binding/callback` 返回 200 SPA HTML（路由错误，不能当成功）。首次聊天中的 `/li3d` 和 OAuth `state` 已过时。

## 最终配置

```dotenv
IDAAS_JWT_SSO_ENABLED=true
IDAAS_JWT_SSO_URL=https://idaas.lilith.com/enduser/sp/sso/lilithplugin_jwt62
IDAAS_ENTERPRISE_ID=lilith
IDAAS_SP_SERVICE_URL=https://li3d.lilithgames.com/api/liclick/account-binding/callback
ATLAS_AI_GATEWAY_ENV=prod
ATLAS_AI_GATEWAY_URL=https://atlas-ai-gateway.lilithgames.com
LICLICK_SHARED_TEST_ACCOUNT_ENABLED=false
LICLICK_ENABLE_ATLAS_LOCAL_LOGIN=false
```

复用应用不等于复用个人令牌。输入是当前飞书 Session 与本人 IDaaS 认证；固定回调通过同源 `target_url` 的随机绑定 UUID 对应十分钟任务。输出仍是通过 secure cache、有效期、liclick 工具权限、邮箱一致性校验后的个人 Atlas home 绑定。无图像公式、Layer 输出、Project Schema、Revision、ownership 或资产变更。

## 发布与分段验收

1. 在官方应用 `lilithplugin_jwt62` 核对精确根路径回调登记；无末尾斜杠，无动态参数。实际回调必须原样带回 LI3D 的 `target_url`。如只登记了 `/li3d/api/...`，应修正登记，不能通过关闭路由或身份检查掩盖。
2. 通过现有完整 CI 将本次配置交付至 release；实际部署仍要求 release 提交包含 `[deploy]`。读取新 Pod 的上述非秘密配置，检查 env/Secret 覆盖和 ConfigMap 是否已经生效；只改仓库、master CI 成功或浏览器刷新均不代表发布完成。保持单副本、PVC 与现有数据。
3. 本人重新点“绑定”。记录开始/回调/绑定完成各阶段：实际授权域名应为 `idaas.lilith.com`，应用为 `lilithplugin_jwt62`，企业为 `lilith`；不再跳 QA。回调进入根路径 API，`target_url` 通过任务归属校验，最终用户菜单显示本人邮箱。
4. 绑定完成内部已执行 `gateway list-tools --service liclick`。确认实际工具列表及权限，再用本人测试素材发起一次真实生图，验证提交、轮询、结果显示及本人莉刻后台记录；不要把构建通过当作真实业务通过。
5. 至少第二名用户使用自己的飞书/IDaaS 会话重复；正式扩展前完成三用户验收。每人独立目录、额度/任务/历史正确；A 查询 B 任务应拒绝，取消/过期/重复回调/邮箱不一致均不产生新绑定。解绑一个用户不影响另一个。
6. 保存并重开工程，检查正式结果资产、历史和下载；在受控重启后验证合法个人凭据可恢复。记录当时版本和成功/失败阶段，不收集或粘贴完整 JWT、Cookie、私钥。

错误定位：Service 不存在检查官方应用登记；返回首页检查回调前缀；关联目标失效检查 target_url、同源 Session、超时/重启；invalid_token 检查实际 issuer/audience 与生产 Gateway 验签日志；工具权限拒绝检查用户 liclick 授权；邮箱不一致检查本人会话。不得凭同一个 401 就断言某个具体签名字段是根因。

## 自动验证

- `node --test scripts/test-cloud-deployment.mjs`：解析 CI 指定 overlay 与 base 的合并配置，锁定官方应用/企业/Gateway、根路径回调、禁用共享账号；新增用例先在旧 QA 配置上失败。
- `corepack pnpm --filter @liclick/server test:liclick-personal-account`：既有安全边界与生产 SSO/target_url 往返。
- Web 账号分离回归、服务端 typecheck、Cloud/repository 边界和 diff 检查。
- 自动测试不访问真实 IDaaS，不冒充多用户或真实生图验收。

本轮结果：部署测试 6/6、服务端个人账号边界回归（含 TypeScript 编译）、Web 零安装账号分离回归、修改脚本 ESLint、Cloud/repository 边界与 `git diff --check` 均通过。使用无网络连接的占位秘密配置加载编译后 serverConfig，确认实际解析为官方生产 SSO、lilith、生产 Gateway 且共享模式关闭；两种 QA/prod 混配均触发预期拒绝。正式站点的修改前绑定交互仍失败；没有进行修改后线上授权、真实生图、跨用户任务或重启恢复验收。

## 迁移与回退

无数据库、Project/Layer/Capture/Generation、GPU/CPU/Worker/shader、投影/UV/export 或分辨率迁移。QA 令牌不能作为生产凭据继续使用；本人重新授权，禁止批量删除用户目录或复制个人缓存。发布重启会使内存中未完成绑定过期，重新开始即可。

应用镜像回退必须保留这套生产 IDaaS/Gateway 配对配置；如确需恢复 QA 配置，应明确标记该环境尚未验收，不宣称恢复服务。保留项目、任务、Revision、对象资产、合法个人目录及 PVC。故障期间暂停新的绑定可以在运维入口执行；不要把 `IDAAS_JWT_SSO_ENABLED=false` 当作已实现的暂停开关，当前实现会选择另一登录协议。不得恢复共享 Token、本地组件或动态注册回调。
