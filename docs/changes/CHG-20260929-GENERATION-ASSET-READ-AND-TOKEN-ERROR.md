# 生图参考图读取回退与个人凭证错误提示

- 日期：2026-09-29
- 主模块：M14；相关 M04、M13。无图像算法改动；传输策略 `ASSET-READ-FALLBACK/1.0.0`，Patch。
- 症状：生产参考图 `/api/projects/.../assets/.../content` 重定向至对象存储后，失败的签名 GET 可能被浏览器报告为缺少 CORS 头，导致参考图去光照准备失败；Atlas 个人 token 缓存错误被显示为“共享生图服务凭证未配置”，与生产关闭共享测试账号的配置相矛盾。
- 处理：同源 verified asset 先按原有 `resolve=1`、`credentials: omit` 直读；签名 GET 抛出浏览器网络 `TypeError` 时，通过 `proxy=1` 的同源 Session 请求回退。服务器重新核对 user/project/asset、verified 状态，以内网端点签名并流式读取，校验长度、MIME、编码；失败返回明确 502，不把上游 XML 或密钥交给浏览器。个人 token 缺失或过期时提示重新绑定个人账号。
- 边界：非项目 URL、未验证资产及跨用户资产不能使用回退；原签名下载、上传、对象 key、SHA-256 上传校验和历史项目不变。没有 GPU、CPU 图像公式、Worker、shader、投影、UV、局部重绘像素、导出、Schema、Revision CAS 或资产迁移。
- 验证：`test:asset-transfer` 验证公开与内网签名 GET 及跨用户拒绝；`test:cloud-base-path-assets` 注入签名 GET 的 CORS `TypeError`，验证同源回退和凭证模式；`test:liclick-personal-account` 验证错误文案；正式发布执行 `verify:prepush`。生产真实账号与实际生图需要部署后验收，静态健康检查不能证明个人 token 有效。
- 回滚：移除浏览器 TypeError 回退和服务端 `proxy=1` 分支即可恢复原有短时签名 GET；既有项目、绑定和对象资产保留。若实际个人 token 过期，用户须通过现有账号菜单重新授权，不使用共享凭据代替。
