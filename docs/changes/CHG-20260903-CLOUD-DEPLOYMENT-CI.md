# CHG-20260903-CLOUD-DEPLOYMENT-CI

- 主模块：M15 质量门禁与发布。UI：无。
- ALG：不修改业务算法；部署契约 CLOUD-DEPLOYMENT v1.0.0。
- 基线：master 5f880fd + release cd30512；保留双方 Git 历史，应用源码保持 master。
- 问题：release 的旧 Dockerfile 漏掉 contracts workspace、运行目录不匹配，K8s 仍执行旧 SQLite 初始化，
  缺少 Cloud 运行时配置、构建身份和部署文件门禁；旧 nginx 仍含退休安装器路由。
- 变更：合并并适配镜像、CI、K8s 与文档；保留效率组 Runner/ACR/namespace/域名/TLS/PVC。
  master 完整 verify/build 后并行验证两个镜像，禁止推镜像或部署；release+[deploy] 才可生产部署。
  release 同样保留 verify/build，部署使用不可变 SHA，串行执行并在 apply 前写入最终标签。
- 安全与数据：真实凭据不入 Git/镜像；Qwen 密钥和注入由效率组处理。部署必须明确 PostgreSQL 与 HTTPS 对象存储，
  缺配置阻断。保留原 PVC；SQL 001–003 只初始化表，既有项目必须独立迁移并验收后才设置 LI3D_CLOUD_DATA_READY。
- Schema/算法：Project Command v1、Revision CAS、ownership、verified assets、GPU/CPU/Worker/shader/UV/export 与分辨率不变。
- 迁移/回滚：本次只准备代码和 master CI，未操作集群或迁移生产数据。回滚只使用兼容 Cloud 协议的已验证镜像；
  不删数据库、资产或 PVC，不退回旧本地组件或生产文件存储。
- 验证：新增部署配置/运行时门禁回归；现有完整 CI 与两个真实镜像构建结果以 master 流水线为准。
  CI 不替代现网数据库、存量数据、OAuth、Qwen、GPU 服务与浏览器业务验收。
