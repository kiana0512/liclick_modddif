# Feishu Web Login And Personal Liclick Binding

当前有两条独立身份链，不能混成“Atlas 就是飞书登录”。

## Web Application Identity

统一浏览器服务使用主服务上的 Feishu Web OAuth/OIDC：

1. 用户从页面点击飞书登录。
2. 主服务创建一次性 state/PKCE 数据并跳转到官方 Feishu authorize URL。
3. Feishu 回调主服务的固定 HTTPS URL。
4. 主服务在后端交换 code、读取用户信息，并创建 LI3D 自己的 HttpOnly session cookie。
5. 前端只读取清洗后的用户/provider status，不接触 Feishu token、App Secret 或原始 LI3D session token。

正式环境需要精确注册：

```text
https://YOUR_HOST/api/auth/feishu/callback
```

具体环境变量、回调和 smoke 流程见 [61_FEISHU_WEB_LOGIN_SETUP.md](61_FEISHU_WEB_LOGIN_SETUP.md)。`dev-mock` 只用于明确的开发模式。

## Personal Liclick Identity

Texture Painting 的 AI generation 还有第二条、每用户独立的 Liclick/Atlas 身份：

- Windows Local Component 默认运行在 `127.0.0.1:4618`。
- 组件发起个人 Atlas/IDaaS 授权，可使用本机 `localhost:20265` callback，因为浏览器和组件都在同一台用户电脑。
- token 只存该 Windows 用户的本地应用数据，不上传到主服务器。
- 组件将绑定的 Liclick email 与当前 Feishu Web email 比较；不一致时拒绝 generation。
- `GET /api/local-liclick-account/status` 只返回清洗后的绑定/可用状态。

## Local Identity Proof

网页访问 loopback 组件不能只依赖 CORS 或提交一个 email 字符串。当前流程由主服务签发短期 local identity proof，组件再次验证来源、用户和有效期，然后才允许个人 generation/project 操作。

前端 transport 根据 provider status 选择：

- `atlas-workspace`：开发/兼容 workspace Atlas path；
- `personal-local-component`：当前产品目标路径，访问 4618 并携带 identity proof。

## Retired Shared-server Login Model

旧 A100 文档中的 machine-wide Atlas service token、服务器本地 `localhost:20265` interactive callback 和 remote browser workaround 只属于历史测试方案。它不满足当前“飞书 Web 用户与个人 Liclick 账号一一匹配”的生产边界。

## Failure Semantics

- Web session 失效：重新走 Feishu OAuth。
- 本地组件缺失/版本过旧：Texture Runtime Gate 要求安装或更新组件。
- Liclick 未绑定：打开个人绑定流程。
- email mismatch 或 proof 失效：组件返回 401/403/428 等错误，前端清除 account-status cache 并要求重新验证。
- 非贴图远端模块继续走主服务会话和相应服务权限，不复用个人 Liclick token。
