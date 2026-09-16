# 内网 HTTP 编辑器初始化修复

- 主模块 M07，协作 M03/M15；兼容性修订 `UV-ARCHIVE-HTTP-ID/1.0.1`。
- 原因：新增 UvContributionArchive 在字段初始化中直接调用 crypto.randomUUID；内网 HTTP 非安全上下文缺少此方法，ProjectedUvRasterCache 创建时抛错。
- 修改：会话 owner 使用已有 createId，仅作为本地派生缓存命名空间，不用作授权令牌。其他已存在的 UUID 调用不在本次热修复范围。
- 验证：HTTP UUID 回归执行真实 TypeScript 构造函数及 ID helper，覆盖无 crypto、crypto 无 randomUUID、原生 UUID；两种兼容环境各创建 1000 个独立 owner。最终提交须通过类型检查及正式 verify:prepush。
- 审计：GPU/CPU/Worker/shader 不涉及 owner 生成；投影/UV 像素、缓存编解码、QA、分辨率、生成请求、Command/CAS/ownership、项目持久化、导出均不变。
- 迁移：无 Schema 或数据迁移，已有会话缓存由原 owner 管理，刷新建立新 owner。
- 回滚：前后端发布包可整体回滚，保留运行目录和资产。恢复原代码会重新暴露 HTTP 初始化错误，不应作为该环境长期方案。
