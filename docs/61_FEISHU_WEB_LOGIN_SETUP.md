# 飞书 Web 登录、身份绑定与使用统计接入

LI3D 的网页部署必须同时运行 `apps/web` 和 `apps/server`。浏览器只负责展示和发起登录，App Secret、OAuth code 换 token、通讯录查询以及多维表格写入都必须留在服务器。

旧纯前端站点没有 `/api/auth/*`。当浏览器请求登录接口时，静态站点会把 `index.html` 返回给前端，前端按 JSON 解析后就会出现：

```text
Unexpected token '<', "<!doctype "... is not valid JSON
```

这不是飞书账号本身的问题，而是请求没有到达 LI3D 后端。

## 1. 两层能力

部署时应把能力分成两层，先让基础登录稳定，再按需启用统计。

### 1.1 基础登录（必需）

1. 用户打开 LI3D 首页，右上角显示“飞书登录”。
2. 前端请求 `GET /api/auth/feishu/start`。
3. 后端生成一次性 `state`、PKCE 参数和短时 HttpOnly 浏览器校验 Cookie，返回飞书授权地址。
4. 浏览器打开飞书授权页。
5. 飞书回调 `GET /api/auth/feishu/callback`；服务端同时校验并立即消费 `state` 与浏览器 Cookie，阻止回放和跨浏览器绑定。
6. 后端用 code 换取 `user_access_token`，调用 `authen/v1/user_info`。
7. 后端创建 LI3D 用户和 HttpOnly 会话 Cookie。
8. 页面刷新 `GET /api/auth/me`，右上角显示当前用户。

浏览器不会拿到 App Secret，也不需要保存飞书 token。后续访问 LI3D 使用自己的会话 Cookie。

### 1.2 身份绑定与本地统计（核心）

LI3D 默认启用随机设备身份、事件落盘、幂等去重、匿名历史归属和每日聚合。通讯录补全与 Bitable 同步仍是服务器端可选能力。完整数据链路为：

```text
右上角飞书登录
  -> LI3D 会话建立
  -> 随机 machine_id / install_id 绑定飞书用户
  -> 通讯录补全姓名、邮箱和部门（可选）
  -> 客户端事件先写服务器本地持久层
  -> event_id 幂等去重
  -> 匿名设备历史记录迁移到正式用户
  -> 按日聚合
  -> 可选同步到飞书多维表格
```

身份绑定和本地事件持久化不依赖通讯录或 Bitable；飞书平台暂时不可用时也不能丢失本地事件。只有在权限、目标表和隐私说明已经配置后，才打开通讯录及 Bitable 开关。

## 2. 飞书开放平台配置

### 2.1 创建应用和 Web 能力

1. 创建或复用一个企业自建应用。
2. 为应用添加网页应用 / Web 能力。
3. 在“凭证与基础信息”取得 App ID（通常以 `cli_` 开头）和 App Secret。
4. App Secret 只进入服务器 Secret 管理或服务器环境文件，禁止放入 Git、前端 `VITE_*` 变量、网页源码、安装包或聊天记录。

### 2.2 登记精确的 HTTPS 回调

在飞书开放平台“安全设置”中登记完整回调 URL。协议、域名、端口、路径和路径前缀必须与生产访问地址完全一致。

部署在域名根路径：

```text
https://YOUR_HOST/api/auth/feishu/callback
```

部署在 `/li3d` 前缀：

```text
https://YOUR_HOST/li3d/api/auth/feishu/callback
```

服务器的 `FEISHU_OAUTH_REDIRECT_URL` 必须填写同一个值。生产环境使用 HTTPS，不要登记通配符，也不要把开发机的 `127.0.0.1` 回调带到生产环境。

如果只在受控公司局域网内做临时验收，飞书开放平台允许登记精确的 HTTP 回调。LI3D 仍默认拒绝非本机 HTTP；必须在服务器端显式设置：

```env
FEISHU_OAUTH_ALLOW_INSECURE_HTTP_CALLBACK=true
SESSION_COOKIE_SECURE=false
```

该例外会让登录会话 Cookie 在网络传输中失去 TLS 保护，只能用于受控内网临时阶段，且防火墙应限制为公司子网。切换到 HTTPS 后必须立即恢复为 `false`，并把 `SESSION_COOKIE_SECURE` 改回 `true`。

### 2.3 应用可用范围、数据范围和发布

三种“范围”不要混淆：

- **应用可用范围**：决定哪些员工能看到并使用应用。测试用户必须在范围内。
- **通讯录数据范围**：决定应用身份使用通讯录 API 时能读到哪些用户和部门。按最小业务范围配置；只有确实需要全组织部门路径时才扩大范围。
- **多维表格文档权限**：决定应用是否能读写目标 Base。API scope 已开通也不等于自动拥有某个 Base 的编辑权。

完成权限申请后，需要创建并发布应用版本，等待企业管理员审批，并确认应用对测试用户可用。权限或可用范围变化后通常也需要重新发布版本。

## 3. 最小权限

### 3.1 仅登录

基础 `authen/v1/user_info` 登录不需要额外 API scope：

```env
FEISHU_OAUTH_SCOPE=
```

如果登录页需要返回邮箱，再申请并加入：

```text
contact:user.email:readonly
```

邮箱和手机号是企业通讯录资料，不应当作为密码或唯一认证凭据。不需要刷新飞书 token 时，不申请 `offline_access`。

### 3.2 通讯录补全（应用身份）

使用自建应用的 `tenant_access_token` 查询用户和部门时，按实际返回字段申请以下应用身份权限：

| 用途 | 建议 scope |
| --- | --- |
| 通讯录基础读取 | `contact:contact.base:readonly` |
| 姓名、头像等用户基础信息 | `contact:user.base:readonly` |
| 用户所属部门 ID | `contact:user.department:readonly` |
| 部门名称 | `contact:department.base:readonly` |
| 父部门、部门层级组织信息 | `contact:department.organize:readonly` |
| 邮箱（可选） | `contact:user.email:readonly` |
| 企业内 `user_id`（可选） | `contact:user.employee_id:readonly` |

这些应用身份权限在飞书控制台开通，不要把所有 tenant scope 都机械地塞进 `FEISHU_OAUTH_SCOPE`。应用还必须拥有覆盖目标用户和部门的通讯录数据范围。

### 3.3 多维表格（应用身份，可选）

每日聚合按条件查找、创建和更新记录时，最小 granular scopes 为：

```text
base:record:retrieve
base:record:create
base:record:update
```

如果按 `record_id` 单独检索，再申请 `base:record:read`。如果程序需要检查、创建或修改字段，再按需申请：

```text
base:field:read
base:field:create
base:field:update
```

还要在目标多维表格中把应用添加为“文档应用”并授予编辑权限。若 Base 开启高级权限，应用也必须取得足够的行、列和字段管理权限。

## 4. 服务器环境变量

基础生产配置示例：

```env
SERVER_HOST=127.0.0.1
SERVER_PORT=4517
LICLICK_SERVE_WEB=true
LICLICK_PUBLIC_WORKSPACE_URL=https://YOUR_HOST
LICLICK_FRONTEND_URL=https://YOUR_HOST
LICLICK_ALLOWED_ORIGINS=https://YOUR_HOST

AUTH_MODE=feishu-oauth
LICLICK_ENABLE_ATLAS_LOCAL_LOGIN=false
IDAAS_JWT_SSO_ENABLED=false

SESSION_COOKIE_NAME=liclick_3d_session
SESSION_SECRET=REPLACE_WITH_A_STABLE_LONG_RANDOM_VALUE
SESSION_MAX_AGE_DAYS=14
SESSION_COOKIE_SECURE=true

FEISHU_OAUTH_CLIENT_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_OAUTH_CLIENT_SECRET=SERVER_ONLY_SECRET
FEISHU_OAUTH_AUTHORIZE_URL=https://accounts.feishu.cn/open-apis/authen/v1/authorize
FEISHU_OAUTH_TOKEN_URL=https://open.feishu.cn/open-apis/authen/v2/oauth/token
FEISHU_OAUTH_USERINFO_URL=https://open.feishu.cn/open-apis/authen/v1/user_info
FEISHU_OAUTH_REDIRECT_URL=https://YOUR_HOST/api/auth/feishu/callback
FEISHU_OAUTH_SCOPE=
FEISHU_OAUTH_TOKEN_AUTH_METHOD=client_secret_post
FEISHU_OAUTH_TOKEN_REQUEST_FORMAT=json
```

可选通讯录和 Bitable 配置：

```env
FEISHU_DIRECTORY_ENRICHMENT_ENABLED=false
FEISHU_TENANT_TOKEN_URL=https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal
FEISHU_CONTACT_BASE_URL=https://open.feishu.cn/open-apis/contact/v3

FEISHU_BITABLE_SYNC_ENABLED=false
FEISHU_BITABLE_BASE_URL=https://open.feishu.cn/open-apis/bitable/v1
FEISHU_BITABLE_APP_TOKEN=
FEISHU_BITABLE_TABLE_ID=
FEISHU_BITABLE_SYNC_INTERVAL_MS=30000
```

`FEISHU_BITABLE_APP_TOKEN` 和 `FEISHU_BITABLE_TABLE_ID` 是服务器端配置，不能进入前端。`tenant_access_token` 应由服务器用 App ID / App Secret 动态取得并按有效期缓存，不要把它写入静态 `.env`。

示例文件中的两个飞书平台开关默认关闭；这不会关闭核心身份绑定和本地统计。只有在应用权限、通讯录数据范围及目标 Base 已配置后，才把对应开关改为 `true`。

服务器集成点位于 `apps/server/src/services/feishuPlatformService.ts`：

```ts
enrichFeishuUserByOpenId(openId): Promise<FeishuDirectoryProfile | undefined>
syncTelemetryAggregateToBitable(aggregate): Promise<{
  aggregateKey: string;
  recordId: string;
  action: 'created' | 'updated';
}>
```

通讯录开关关闭时，第一个函数返回 `undefined`；远端请求或部门层级异常会抛错，登录/绑定调用方应捕获后降级为基础资料。Bitable 同步成功后，调用方必须把返回的 `recordId` 保存为本地 `sync_record_id`，下一次同步即可直接幂等更新。

## 5. 身份绑定与匿名历史迁移

客户端标识必须是应用随机生成的 ID，不使用 IP、MAC 地址、硬盘序列号或其他硬件指纹：

- `machine_id`：同一浏览器资料目录长期保存。
- `install_id`：当前安装环境标识。
- `session_id`：当前浏览器会话标识。

登录完成后，服务器保存“设备标识 -> 飞书用户”的绑定。共享电脑可能存在多个用户；当一个设备有多个候选身份时，不应自动选择最近一次用户，而应要求重新登录。

用户首次登录前可能已经产生匿名事件。绑定后只把能够唯一确认的匿名记录迁移到正式用户键，迁移只改变身份和聚合归属，不再次增加次数。若同一日的正式记录已存在，应合并去重后的绝对值，不能简单把两条记录重复相加。

用户唯一键需要在项目内固定语义：

- 单应用内部识别可使用 `open_id`。
- 同一企业多个应用需要关联时评估 `user_id`。
- 同一开发商旗下多个应用需要关联时评估 `union_id`。

不同应用的 `open_id` 不能直接比较。

## 6. 事件去重、日聚合与 Bitable

事件应先写服务器本地持久层，再异步聚合和同步。每个事件带稳定的 `event_id`，客户端重试同一个事件时复用原 ID。

推荐聚合维度：

```text
日期 + 飞书用户唯一键 + LI3D 版本 + 宿主版本
```

推荐流程：

1. 原始事件先落盘或写数据库。
2. 按 `event_id` 幂等去重。
3. 根据设备绑定解析正式用户；未绑定时保留匿名记录。
4. 更新每日聚合的绝对计数。
5. 标记 `sync_pending`。
6. 后台批量查询、创建或更新 Bitable 记录。
7. 只在同步成功后清除 `sync_pending`；失败保留本地数据并退避重试。

写入 Bitable 的是“当前聚合绝对值”，不是“本次 +1”。这样即使请求重试也不会重复计数。多维表格用于展示和协作，不应成为唯一数据库。

服务端平台客户端使用以下固定字段名。创建目标数据表时应完全按名称和类型建立字段；名称中的空格也必须一致：

| 固定字段名 | Bitable 类型 | 内容 |
| --- | --- | --- |
| `聚合键` | 文本 | 稳定唯一键；用于查询和 upsert |
| `日期键` | 文本 | `YYYY-MM-DD` |
| `用户唯一 ID` | 文本 | LI3D 固定用户键 |
| `用户姓名` | 文本 | 飞书显示名 |
| `飞书邮箱` | 文本 / 邮箱 | `email || enterprise_email` |
| `所属部门` | 文本 | 部门父链；多部门用中文分号分隔 |
| `工具版本` | 文本 | LI3D 版本 |
| `宿主版本` | 文本 | 浏览器或 DCC 版本 |
| `事件总数` | 数字 | 当前聚合绝对值 |
| `动作计数 JSON` | 文本 | 排序后的各模块动作绝对计数 |
| `最后事件时间` | 日期 | 最后一个事件时间 |
| `同步哈希` | 文本 | 聚合内容 SHA-256 |

`聚合键` 应设置为普通文本字段。程序会按该字段精确查询；若人工制造出多个相同聚合键，服务端会拒绝自动选择，避免把统计写入错误记录。

事件中不要上传提示词、图片内容、项目文件、用户文档路径等无关敏感数据。产品上线前应明确告知用户采集的身份字段、事件类型和保存周期。

## 7. 单实例 JSON MVP 与多实例

单机、单 Node 进程的 MVP 可以使用本地 JSON / 文件队列：

- LI3D 用户和会话落在服务器工作目录。
- OAuth `state` 暂存在当前进程内存，短时有效并一次性消费。
- 设备绑定、原始事件、去重索引和每日聚合保存在单一服务器磁盘。
- 同一时间只允许一个进程写这些文件，并使用串行写队列和原子替换避免损坏。

这种方案只适用于单实例。出现以下任一情况时必须迁移到 Redis / 数据库 / 可靠队列：

- 多个 Node 副本或负载均衡。
- 滚动发布、自动扩缩容或容器随时重建。
- 多进程同时写事件和聚合。
- 需要高可用、审计、备份恢复或大规模统计。

多实例至少要共享：OAuth state（带 TTL 和一次性消费）、会话、设备绑定、事件幂等索引、每日聚合和待同步队列。只配置粘性会话不能替代持久化。

## 8. Secret 与部署文件

Linux 部署脚本把运行环境写入 `/etc/liclick-3d-texture.env`。建议：

- 文件所有者为 `root:root`，权限 `0600`。
- systemd 通过 `EnvironmentFile=` 在降权到应用用户前读取。
- 重部署未显式提供新值时保留已有 App ID / App Secret。
- Secret 轮换时通过服务器 Secret 管理或受保护的部署通道注入，避免 shell 历史、进程参数和 CI 日志。
- 备份、日志、故障转储和支持包排除该文件。

`SESSION_SECRET` 也必须是稳定的强随机值。每次部署随机变化会让所有现有会话立即失效。

## 9. 验收

### 9.1 确认 API 到达后端

```bash
curl -i https://YOUR_HOST/api/auth/provider-status
```

预期：

- `content-type: application/json`
- `"feishuConfigured": true`
- `"feishuLoginProvider": "web-oauth"`

如果返回 HTML，说明 `/api` 仍被静态站点或 SPA fallback 接管。如果 `feishuConfigured` 为 `false`，说明服务器没有加载 App ID / App Secret。

### 9.2 完成真实登录

1. 点击右上角“飞书登录”。
2. 浏览器进入 `accounts.feishu.cn`，不是 ChatGPT 登录页。
3. 授权后回调返回 LI3D 页面。
4. 响应写入 `liclick_3d_session` Cookie。
5. `GET /api/auth/me` 返回 `"authenticated": true`。

### 9.3 分阶段验证可选能力

1. 单独验证服务器能获取并缓存 `tenant_access_token`。
2. 验证通讯录用户详情返回所需字段，并确认数据范围没有越权。
3. 验证部门父链有最大深度和循环保护。
4. 验证重复提交同一 `event_id` 只计数一次。
5. 验证匿名记录迁移后计数不增加。
6. 验证关闭 Bitable 或飞书 API 故障时，本地事件和聚合仍不丢失。
7. 验证目标 Base 的应用文档权限、高级权限和字段类型。

## 10. 官方文档

- [获取 OAuth 授权码](https://open.feishu.cn/document/common-capabilities/sso/api/obtain-oauth-code)
- [获取 user_access_token](https://open.feishu.cn/document/authentication-management/access-token/get-user-access-token?lang=zh-CN)
- [获取登录用户信息](https://open.feishu.cn/document/server-docs/authentication-management/login-state-management/get)
- [获取自建应用 tenant_access_token](https://open.feishu.cn/document/server-docs/api-call-guide/calling-process/get-?lang=zh-CN)
- [获取单个用户信息](https://open.feishu.cn/document/server-docs/contact-v3/user/get?lang=zh-CN)
- [通讯录权限范围](https://open.feishu.cn/document/server-docs/contact-v3/scope/scope_authority?lang=zh-CN)
- [API 权限列表](https://open.feishu.cn/document/server-docs/application-scope/scope-list?lang=zh-CN)
- [多维表格接口概览](https://open.feishu.cn/document/server-docs/docs/bitable-v1/bitable-overview?lang=zh-CN)
