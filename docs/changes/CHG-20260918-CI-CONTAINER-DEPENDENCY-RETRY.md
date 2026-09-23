# 容器依赖引导临时网络故障重试

- 主模块：M15；策略：`CI-CONTAINER-DEPENDENCY-RETRY/1.0.0`。
- 故障：master 提交 `4fb1d8ec` 的 GitLab pipeline `633789` 中，verify 五项和 build 均通过，`container:verify: [web]` 通过；仅 `container:verify: [server]`（job `3590944`）在 `corepack prepare pnpm@9.15.4 --activate` 下载约 2.9 MiB 后被远端关闭 TLS socket，报 `UND_ERR_SOCKET / other side closed`。这不是业务回归、包体超限或服务端镜像目标语义错误。
- 处理：Docker `deps` 阶段对固定版本 pnpm 的 Corepack 准备和冻结锁文件安装分别采用最多 3 次的有限重试，失败后等待 5 秒、10 秒再试；连续 3 次失败仍以非零状态阻断镜像，不跳过依赖、测试、构建、包体或 Cloud 产物门禁。server/web 继续共用同一 deps/build 阶段和锁文件。
- 边界：不修改基础镜像、依赖版本、registry、镜像目标、推送和部署规则，也不吞掉确定性依赖错误。该修复只容忍依赖引导期间的短暂连接中断，不替代 Runner/出口网络治理。
- 运行时与数据：浏览器、服务端业务、GPU/CPU/Worker/shader、投影/UV/重绘/Bake 像素、分辨率、QA、Project Command 幂等、Revision CAS、ownership、verified assets、Schema、对象存储与导出均不变；无数据或资产迁移。
- 验证：部署契约测试锁定两个命令、3 次上限与 fail-closed 文案；最终提交仍须通过 `pnpm verify:prepush`，并以新 GitLab pipeline 的 server/web 容器任务结果为准。
- 回滚：恢复 Dockerfile 中两条原单次命令即可；无需数据回滚，但会重新暴露单次临时断网导致的假失败。
