# CHG-20260922 — HTTP 页面参考图处理兼容

主模块 M04；算法 `REFERENCE-LIGHTING/2.0.1`（兼容修复）。

A100 HTTP 页面没有 WebCrypto subtle，参考图片摘要和任务标识直接调用 digest 会抛异常，阻断后台去光照及等待它的 ModelView 生成。两处统一复用现有 sha256Hex，支持 WebCrypto 不可用的环境。

SHA-256 输出、lighting-v2 身份输入及幂等键保持不变，已有处理绑定继续复用，不创建重复任务。无 Schema、资产、Command/CAS 或数据迁移；GPU/CPU/Worker/shader、投影、UV、导出和分辨率不变。回滚本提交即可，但会恢复 HTTP 页面故障。

回归在无 subtle 的环境执行真实摘要实现和参考处理服务，验证标准 SHA、并发去重、绑定恢复、用户隔离及中断重试。浏览器控制台已确认线上故障为 referenceLighting 的 digest 调用。
