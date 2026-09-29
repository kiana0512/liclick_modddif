# CI 等待与重复编译优化

- 日期：2026-09-29；状态：本地回归通过，待远端流水线计时。
- 主模块 M15；契约 `CI-LATENCY/1.0.0`。无 UI、业务算法、Schema、Project Command/Revision、ownership、资产、图像分辨率或 QA 变化。
- 根因：原 build 阶段等待所有 verify 完成；Server 回归的 23 个标准脚本各自清理并编译同一代码；普通 master 源码提交也并行重做 server/web 两个 Docker 镜像，而 Dockerfile 含 Blender 大层和第二次完整发布构建。用户要求结合实际需求缩短 CI 总耗时。
- 改动：正式 build 与 verify 并行；release 镜像发布等待 build 与五项 verify 全部成功，防止未验证镜像覆盖 `release-latest`；deploy 再等待两镜像成功。master/MR 的镜像验证只在 Docker/依赖清单/SQL/部署配置/Blender QA 脚本变更时运行，其他提交保留完整类型、lint、回归、Cloud build、云产物和部署模拟。Server 回归套件一次预编译后直接运行 23 个标准测试；单项测试脚本保持原独立编译行为。
- 验证：Cloud CI 配置回归验证 DAG、变更范围和 deploy 依赖；完整 Server 29 项回归通过；最终提交执行正式 `verify:prepush`，再观察远端 pipeline 各阶段耗时。Kaniko 的 release 镜像仍会按 Dockerfile 重建，是否进一步缩短须有远端耗时数据。
- 迁移/回滚：无数据迁移。回滚 `.gitlab-ci.yml` 和回归 runner 可恢复全 master 镜像验证及逐项编译；release 部署仍须保留全部质量依赖。
