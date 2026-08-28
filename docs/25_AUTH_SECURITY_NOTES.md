# Auth Security Notes

## Current Boundaries

- 主 Web 身份是 Feishu OAuth/OIDC；正式环境必须使用精确 HTTPS callback。
- Texture Painting 的个人 Liclick/Atlas 身份只保存在 Windows Local Component，不保存在共享主服务。
- Feishu email 与个人 Liclick email 必须一致；mismatch 直接拒绝请求。
- 浏览器访问 4618 使用主服务签发的短期 local identity proof，不把主站 cookie直接发送给本地组件。
- 主服务 session cookie 为 HttpOnly、SameSite=Lax，可配置 Secure；服务端只保存 session token hash。
- Feishu token、Atlas token、Liclick token、API key、App Secret 和原始 session token 不进入前端 store、项目 JSON、遥测或 Git。

## Route And Data Isolation

- Main workspace 的 projects/folders/assets/export/history 路由要求有效 Web session，并把文件路径限定到 `workspace/users/<userId>`。
- Local component 只监听 loopback，额外校验 Origin、identity proof 和本地用户/绑定状态。
- 静态 workspace asset route 使用 allowlisted public path pattern、resolved path 和 realpath 三层边界，拒绝 traversal/symlink escape。
- 远端 generation asset import 只允许 HTTPS 和显式 host allowlist。
- 项目、auth、job、Photoshop session、telemetry、logs 和本地 token cache 都属于 ignored runtime data。

## Deployment Requirements

- 生产环境设置不可预测的 `SESSION_SECRET`，TLS 后设置 secure cookie。
- Feishu App Secret、remote service keys 和企业 CA 只通过服务端环境/受控文件注入。
- 不允许不同真实用户无意共享一个 machine-wide Atlas token；service account 只能作为明确标注、权限可接受的专用模式。
- 单节点文件工作区不是分布式安全存储。扩为多实例前必须引入数据库事务、共享对象存储、任务所有权和分布式锁。
- `dev-mock`、loopback OAuth provider 和 insecure HTTP 例外只用于明确的本地/受控测试。

## Product Access Behavior

- 首页可以在未完成登录时展示模块入口；受保护模块/动作在进入或提交时要求身份。
- Texture Projects 还受 Local Component health/version gate 约束。
- Generation job、Auto UV、Retopology 和 Bake history 必须按用户所有权过滤；客户端传来的 user id 不能作为授权依据。
- 遥测 action/event 采用 allowlist 和 event id 去重，不应记录 prompts、tokens 或用户资产正文。

## Known Gaps

- 当前项目 JSON 尚未统一使用完整 runtime schema 校验，服务端部分读取依赖断言；应把输入大小限制和 schema migration 作为后续安全工作。
- 文件存储的并发/恢复语义弱于事务数据库。
- DCC/Photoshop bridge 扩展到 Blender/3ds Max 前，需要为 connector 建立独立认证、重放保护、文件范围和版本协商；目前两个 connector 仍是占位。
