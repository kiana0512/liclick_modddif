# LI3D 接入 IDaaS 实现个人莉刻账号绑定说明

> **2026-09-08 更新：接入方案已改为官方生产应用。** 维护者确认不再使用自建 `LI3D-QA/testplugin_jwt92` 作为正式入口；改用 `idaas.lilith.com / lilithplugin_jwt62 / enterpriseId=lilith` 与生产 Atlas Gateway。每人仍独立授权，不能共用个人 Token。当前精确回调为 `https://li3d.lilithgames.com/api/liclick/account-binding/callback`，不带 `/li3d`；现行关联协议使用 `target_url`，不使用 OAuth `state`。仓库配置已修改，生产发布与端到端验收尚未完成。实施、测试和回退见 [官方生产应用变更卡](changes/CHG-20260908-IDAAS-OFFICIAL-PRODUCTION-APP.md)。下文保留 9 月 4 日 QA 排障历史，不再作为继续申请 QA Gateway 信任或当前发布状态的指令。

> 日期：2026-09-04
>
> 当前状态：LI3D 侧代码与部署已完成，QA 端到端验收阻塞在 Atlas Gateway 对新 JWT 应用的令牌校验
>
> 面向人员：IDaaS 管理员、Atlas AI Gateway 负责人、效率组、LI3D 开发与测试人员
>
> 所属模块：`M13 身份、任务与平台`
>
> 协议：`LICLICK-ACCOUNT-BINDING v1.3.3`

## 1. 一句话说明

LI3D 接入 IDaaS，是为了让不同飞书用户在登录 LI3D 后，继续绑定并使用各自的莉刻账号进行生图和查看莉刻后台记录，而不是让所有用户共用一个公共账号。

现在飞书身份、IDaaS 授权、固定 HTTPS 回调和 LI3D 服务端接收令牌均已走通；当前剩余问题是 Atlas Gateway 测试环境拒绝 `LI3D-QA` 签发的 JWT，返回 `401 invalid_token`。

## 2. 为什么需要 IDaaS

LI3D 是浏览器零安装的云端应用。用户进入 LI3D 时已经有自己的飞书身份，但调用莉刻/Atlas 生图能力时，还需要一个可被 Atlas Gateway 识别的个人身份凭证。

我们不能使用固定公共账号，原因包括：

- 生图额度、任务和后台记录会全部混在公共账号下，无法区分实际使用者。
- 用户无法在自己的莉刻后台查看自己从 LI3D 发起的任务。
- 公共 Token 会形成共享凭据，存在泄露、越权和审计不清的问题。
- 一个用户可能看到或轮询另一个用户的远端任务，不符合账号隔离要求。
- 公共账号失效会同时影响所有用户。

因此需要 IDaaS 在用户完成企业身份认证后，为当前用户签发 JWT，并由 Atlas 运行时为该用户建立独立的凭据缓存。LI3D 只把该独立凭据目录绑定到当前飞书用户，不接触或保存明文 Token。

## 3. 期望的完整流程

```text
用户打开 LI3D
  → 使用自己的飞书账号登录
  → 点击“绑定莉刻账号”
  → LI3D 发起 IDaaS JWT SSO
  → 用户在 IDaaS 中完成本人认证
  → IDaaS 把当前用户的 JWT 返回 LI3D 固定 HTTPS 回调
  → LI3D 将 JWT 交给 Atlas 运行时
  → Atlas Gateway 验证 JWT，并确认用户拥有 liclick 服务权限
  → Atlas 运行时为该用户写入独立的加密凭据缓存
  → LI3D 校验 Atlas 邮箱与当前飞书邮箱一致
  → 将该 Atlas 凭据目录绑定到当前 LI3D 用户
  → 后续生图、编辑、轮询和历史查询全部使用该用户自己的身份
```

所有用户可以共用同一个 LI3D 回调地址和同一个 IDaaS 应用，但每次 JWT 中的用户身份不同，最终保存的 Atlas 凭据目录也彼此独立。这不等于共用账号。

## 4. 环境与应用配置

### 4.1 LI3D QA 应用

当前在 QA IDaaS 中创建的 JWT 应用配置如下：

| 配置 | 当前值 |
| --- | --- |
| 应用名称 | `LI3D-QA` |
| 应用 ID / JWT audience | `testplugin_jwt92` |
| IDaaS 环境 | `https://qa-idaas.lilithgames.com/` |
| SSO 地址 | `https://qa-idaas.lilithgames.com/enduser/sp/sso/testplugin_jwt92` |
| 企业标识 | `test` |
| SSO Binding | `REDIRECT / GET` |
| JWT 算法 | `RS256` |
| JWT Key ID | `2505416851397450890` |
| JWT issuer | `https://qa-idaas.lilithgames.com/` |
| JWT audience | `testplugin_jwt92` |
| Token 有效期 | 600 秒 |
| 固定回调 | `https://li3d.lilithgames.com/api/liclick/account-binding/callback` |
| Atlas Gateway 环境 | `https://atlas-ai-gateway-test.lilithgames.com` |

对应 PKCS8 公钥已经从 IDaaS 导出，可单独提供给 Atlas Gateway 负责人。本文不附完整公钥、Token、Cookie 或其他凭据。

当前用于隔离验收的用户：

- `kianaren@lilith.com`
- `haoze.yu@lilith.com`
- `alonshi@lilith.com`

新增测试用户仍需要在 IDaaS 中获得该应用的使用权限。

### 4.2 本地已成功的对照链路

本地 `127.0.0.1:4517` 使用 Atlas SkillHub 原生登录协议，实际走的是现有生产应用：

| 配置 | 本地成功链路 |
| --- | --- |
| IDaaS | `https://idaas.lilith.com/` |
| JWT 应用 | `lilithplugin_jwt62` |
| 企业标识 | `lilith` |
| 回调 | `http://localhost:20265/callback` |
| Gateway | `https://atlas-ai-gateway.lilithgames.com` |

清除本地历史凭据后重新授权，已经验证该链路能够重新获得个人 Atlas 凭据，并成功读取 `liclick` 工具列表。

本地成功不能证明 `LI3D-QA` 已经被 Gateway 信任，因为两条链路使用的是不同的 IDaaS 环境、应用 ID、issuer、audience 和签名密钥。

## 5. 已经完成的工作

### 5.1 固定 HTTPS 回调

IDaaS JWT 应用要求登记固定的 Service URL。当前线上真实入口为：

```text
https://li3d.lilithgames.com/api/liclick/account-binding/callback
```

该地址不携带邮箱、`loginId`、`state` 或其他动态查询参数，也没有末尾 `/`。

LI3D 使用同源、十分钟有效、只能消费一次的绑定任务来区分不同用户。回调接收 JWT 后会立即清理浏览器地址栏中的令牌参数，再通过同源 Cookie 完成服务端关联。

### 5.2 本地与 Cloud 流程隔离

- 本地 4517 使用 Atlas SkillHub 原生的 `localhost:20265/callback`。
- Cloud/服务器环境使用 `LI3D-QA` 登记的固定 HTTPS 回调。
- 两种模式不再互相套用回调协议。

### 5.3 K8s 个人凭据模式修复

Atlas SkillHub 2.9.1 在 K8s 中会根据环境信号自动进入 ArkClaw/TIP 模式，导致个人 IDaaS Token 被忽略，并错误要求公共 `VE_TIP_TOKEN`。

LI3D 已经在“明确使用某个用户独立 Atlas home”的子进程中隔离这些自动探测信号，使 Atlas 读取当前用户的加密凭据缓存。该处理不会把 Token 放进环境变量，也不会允许个人请求回退到公共 TIP Token。

### 5.4 QA/生产 Gateway 配对

服务器已经显式配置：

```text
QA IDaaS → Atlas Gateway test
生产 IDaaS → Atlas Gateway prod
```

服务启动时会拒绝已知的 QA/生产混配，缓存中的 Gateway 地址也必须与当前环境一致。

### 5.5 发布状态

- LI3D 相关修改已经进入 `master`。
- 已合并到 `release` 并通过 CI/CD 部署。
- 当前 release 提交为 `2c49d52`。
- 本地自动测试、类型检查、Lint、Cloud 边界和身份流程模拟均已通过。

这些结果证明 LI3D 代码和部署门禁通过，但不等于外部 Atlas Gateway 已接受新应用签发的 JWT。

## 6. 之前遇到的问题及处理结果

### 6.1 动态回调地址被 IDaaS 拒绝

最初把 `loginId` 等动态参数拼进回调地址，导致回调与 IDaaS 后台登记的 Service URL 不完全一致，出现“Service 地址不存在”。

处理结果：改为固定 HTTPS 回调，用户与绑定任务在 LI3D 服务端通过一次性任务 ID 关联。该问题已经解决。

### 6.2 本地流程被错误切到 Cloud 回调

本地 4517 原本应使用 Atlas SkillHub 的固定 `localhost:20265/callback`，但曾被套用服务器固定回调流程，导致本地重新授权失败。

处理结果：本地与 Cloud 两条协议已经隔离；清除本地 Token 后重新授权成功。该问题已经解决。

### 6.3 K8s 环境错误要求 TIP Token

服务器收到 IDaaS 回调后，Atlas 子进程因检测到 K8s 环境而进入 ArkClaw/TIP 模式，提示缺少 `VE_TIP_TOKEN`，没有继续读取用户个人凭据。

处理结果：仅对个人 Atlas home 的子进程隔离 K8s/TIP 自动探测信号。该问题已经解决。

### 6.4 QA JWT 曾发往生产 Gateway

QA IDaaS 签发的 JWT 与生产 Gateway 的信任配置不属于同一环境，跨环境提交会被拒绝。

处理结果：Cloud 已明确切换为 Atlas Gateway test，并加入启动和缓存配对检查。该问题已经解决。

## 7. 当前剩余卡点

### 7.1 实际现象

当前线上测试可以完成以下步骤：

1. 用户进入 LI3D。
2. 打开 IDaaS 授权页面。
3. IDaaS 成功签发 JWT。
4. 浏览器返回 LI3D 固定 HTTPS 回调。
5. LI3D 服务端收到 JWT 并交给 Atlas 运行时。

随后 Atlas Gateway test 返回：

```text
HTTP 401
{"error":"invalid_token","message":"token validation failed"}
```

### 7.2 能确认的事实

- IDaaS 应用已经启用。
- 用户能够进入授权流程并获得 JWT。
- 固定回调可以到达 LI3D 服务端。
- LI3D 已经使用 test Gateway，而不是生产 Gateway。
- 错误发生在 Atlas Gateway 验证令牌阶段，不是飞书登录、回调路由或前端页面阶段。
- 本地使用既有 `lilithplugin_jwt62` 与生产 Gateway 可以成功，说明 Atlas CLI 2.9.1 的基础授权能力可用。

### 7.3 当前判断

`LI3D-QA/testplugin_jwt92` 是新建的 QA JWT 应用，使用独立的 issuer、audience、Key ID 和签名公钥。Atlas Gateway test 必须明确接受这组验证材料，才能验证该应用签发的令牌。

目前我们没有 Atlas Gateway test 的验签配置读取权限，因此不能直接确认它当前信任了哪些应用。根据 `401 invalid_token / token validation failed`、新应用能够正常签发 Token，以及本地既有应用可以成功的对照结果，当前最需要确认的是：

- Gateway test 是否已经登记 `testplugin_jwt92`。
- Gateway 是否接受 issuer `https://qa-idaas.lilithgames.com/`。
- Gateway 是否以 audience `testplugin_jwt92` 校验该令牌。
- Gateway 是否已经导入 Key ID `2505416851397450890` 对应的 RS256 公钥。
- Gateway 是否要求额外的用户或服务权限声明。

在读取 Gateway 实际配置或日志前，不能把其中某一个验签字段单独宣布为最终根因；但问题边界已经收敛到 Gateway 对这套 QA JWT 的信任/验签配置。

## 8. 为什么 IDaaS 管理页面不能单独解决 401

IDaaS 页面主要负责“谁能登录”和“签发什么 Token”：

| IDaaS 页面功能 | 能解决的问题 | 是否能直接解决当前 401 |
| --- | --- | --- |
| 修改应用 | 回调地址、Binding、Token 有效期、账号映射 | 否；应用 ID 和签名密钥不能在这里改成既有应用 |
| 应用授权/绑定群组 | 指定哪些用户可以使用 `LI3D-QA` | 否；当前 JWT 已经成功签发 |
| 指定认证方式 | 指定飞书等登录方式 | 否；与 Gateway 验签无关 |
| SSO 地址 | 提供登录发起入口 | 否 |
| API Key/API Secret | SCIM、用户和组织数据接口 | 否；不是 JWT 验签材料 |
| 导出 JWT 公钥 | 向 SP/Gateway 提供验证签名所需材料 | 是，属于必要材料，但仍需 Gateway 侧导入或登记 |

IDaaS 能生成并导出公钥，但不能替任意外部服务自动修改其信任配置。因此当前还需要 Atlas Gateway 负责人在验证端完成接入。

## 9. 需要 Atlas Gateway/效率组协助的事项

请协助确认 Atlas Gateway test 接入新 IDaaS JWT 应用的标准流程，并完成或指导以下配置：

1. 在 Atlas Gateway test 的可信 JWT 应用列表中登记 `LI3D-QA`。
2. 使用以下非秘密元数据配置验签：

   ```text
   algorithm: RS256
   issuer: https://qa-idaas.lilithgames.com/
   audience: testplugin_jwt92
   key id: 2505416851397450890
   ```

3. 导入与上述 Key ID 对应的 PKCS8 公钥，或告知应提交公钥/JWKS 的正式位置。
4. 确认该应用签发的用户身份可以调用 `liclick` 服务。
5. 如 Gateway 对邮箱、用户 ID、组织或权限 claim 有额外要求，请提供所需字段名称和格式。
6. 如测试 Gateway 不接受新建 QA JWT 应用，请提供应复用的应用、回调登记方式或正式申请流程。

不建议通过以下方式绕过：

- 不使用公共莉刻账号或公共 Atlas Token。
- 不把个人 Token 上传到 CI/CD 变量或 Pod 公共环境变量。
- 不关闭 Gateway JWT 验签。
- 不在 Git 中提交公钥文件之外的私钥、Token、Cookie 或用户凭据。
- 不把本地个人缓存复制到服务器作为其他用户的凭据。

## 10. QA 验收方案

Gateway 信任配置完成后，按以下顺序验收：

### 10.1 单用户重新绑定

1. 清除当前测试用户在 LI3D 中的旧失败绑定状态。
2. 使用该用户自己的飞书账号登录 LI3D。
3. 点击绑定莉刻账号并完成 IDaaS 认证。
4. 确认页面显示当前用户自己的莉刻邮箱。
5. 确认 Atlas `list-tools --service liclick` 成功。
6. 发起一次真实生图并在该用户自己的莉刻后台找到对应记录。

### 10.2 三用户隔离验证

分别使用以下用户独立完成登录和绑定：

- `kianaren@lilith.com`
- `haoze.yu@lilith.com`
- `alonshi@lilith.com`

每名用户都需要使用自己的飞书/IDaaS 会话完成一次授权。无需也不得互相提供 Token。

检查：

- 三人的 LI3D 账号绑定邮箱分别正确。
- 三人的 Atlas home 目录相互独立。
- 每个人的生图任务只出现在自己的莉刻后台。
- A 用户不能查询或轮询 B 用户的任务 ID。
- 退出、解绑或 Token 失效只影响当前用户。
- 日志中不出现完整 Token、Cookie 或其他个人凭据。

### 10.3 通过标准

只有同时满足以下条件，才算 QA 全流程通过：

- 三名用户都能独立完成飞书登录、IDaaS 授权和莉刻账号绑定。
- Atlas Gateway 不再返回 `invalid_token`。
- 三名用户都能使用自己的账号完成生图。
- 生图后台记录、额度和任务所有权互不串号。
- 跨用户任务访问被拒绝。
- 服务器重启后已绑定用户仍能读取自己的加密凭据。
- 全流程没有使用或回退到公共账号。

## 11. 上线步骤

QA 验收通过后再进入正式环境：

1. 创建或更新生产 IDaaS JWT 应用。
2. 在生产应用中登记同一个固定 HTTPS 回调。
3. 由 Atlas Gateway 生产环境登记生产应用的 issuer、audience、Key ID 和公钥。
4. LI3D 将 IDaaS 配置从 QA 切换到生产，同时将 Gateway 环境从 `test` 切换到 `prod`。
5. 重新执行 CI/CD、单用户验证和至少双用户隔离验证。
6. 验证通过后再向更多用户授权。

QA JWT 不得发送给生产 Gateway，生产 JWT 也不得发送给测试 Gateway。

## 12. 回滚与故障处理

- 如果 Gateway 配置尚未完成，可以暂停新的莉刻账号绑定入口，但保留现有用户数据和合法个人凭据。
- 可以回滚到前一个兼容 Cloud 协议的镜像，不删除用户 Atlas home、项目、任务或资产。
- 临时绑定失败时只清理该次未完成的临时目录，由用户重新发起授权。
- 不恢复动态回调、共享默认账号或公共 `ATLAS_TOKEN_FILE`。
- 不删除已经完成绑定的其他用户凭据。

## 13. 可直接发送给相关负责人的简短版本

> 我们接入 IDaaS，是为了让不同飞书用户登录 Li3D 后，分别绑定并使用自己的莉刻账号生图和查看后台记录，不使用公共账号。
>
> 目前飞书登录、IDaaS 签发、Li3D 固定 HTTPS 回调和服务端接收 Token 都已走通，Li3D 也已部署到 QA 配置。当前唯一剩余卡点是 Atlas Gateway test 在验证 `LI3D-QA（testplugin_jwt92）` 的 JWT 时返回 `401 invalid_token`。
>
> 麻烦协助确认新 IDaaS JWT 应用接入 Atlas Gateway test 的流程，并登记该应用的 issuer、audience、Key ID 和 RS256 公钥，同时确认它可以调用 `liclick` 服务。公钥可以单独提供。

## 14. 相关仓库记录

- 变更说明：`docs/changes/CHG-20260904-IDAAS-PERSONAL-ACCOUNT-FIXED-CALLBACK.md`
- 模块规范：`docs/00_SYSTEM_MODULES_AND_CHANGE_STANDARD.md`
- LI3D 服务端配置：`apps/server/src/config.ts`
- LI3D Atlas 账号绑定实现：`apps/server/src/auth/atlasAuthService.ts`
- Cloud 环境配置：`deploy/k8s/base/server-config.env`

本文档只记录当前事实、问题边界和协作事项，不包含私钥、完整 JWT、Cookie、用户 Atlas 缓存或其他秘密材料。
