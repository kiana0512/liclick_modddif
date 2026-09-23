# 正式 server 镜像补齐 Blender 运行时

- 主模块：M15；关联入口 UI-04/UI-12 → M02 导入预处理，协作 M10。
- 部署契约：`BLENDER-SERVER-RUNTIME/1.0.0`，状态：本地实现，待容器 CI 与生产验收。
- 算法保持 `IMPORT-UV-REPAIR/1.3.0`、`IMPORT-DECIMATE/1.1.0`；实施：Codex。

## 问题与证据

正式站 `import-uv-repair` 返回 422，消息为 Blender was not found；release 7d034de5
的最终 server 镜像只安装 Node/Atlas 和基础工具，没有安装 Blender，也未挂载旧 A100 tools 路径。
编译产物包含 Python 算法字符串，不代表包含 Blender 可执行程序。
原 CI 验证接口门禁但默认不运行真实 Blender，因此流水线全绿不能证明此依赖可用。

## 修改

在独立镜像阶段下载官方 Blender 5.1.2 Linux x64，固定校验值
`aaccb355f50183979b698bcce7467103a76261b5fa59f4972295842662a285fb`，
复制完整发行目录到最终镜像 `/opt/blender`，安装运行动态库并显式配置可执行路径。
仅 amd64，架构不匹配时拒绝构建；下载不依赖运行时用户凭据。

最终 server 镜像以正式非 root 账号执行实际编译的 UV 脚本与已有合并距离回归夹具。
验收包括版本、GLB 导入、近邻顶点合并、对象/材质保留、有限且非退化的 0–1 UV、
导出回读，以及表面破坏时拒绝输出。进程超时/错误/缺少成功标记均失败，临时产物始终清理。
现有 CI 自动构建该目标，不修改流水线分支规则、K8s/PVC 或密钥。

## 对等审计与兼容

输入、0.0001 合并距离、66° 智能投射、岛排布和 QA 阈值不变，无新算法公式或 Layer 输出。
CPU Blender 原脚本不变；GPU、Worker、shader、投影/重绘、持久化与导出继续消费原契约的最终 GLB。
不替换独立 Asset V4 UV/拓扑服务，不安装浏览器/Windows 本地组件。
Project/Layer Schema、Command 幂等、Revision CAS、ownership、verified assets 不变。
不改写已有资产，无数据迁移。

## 验证

- `node --test scripts/test-cloud-deployment.mjs`：10/10 通过，包含缺失/错误版本进程拒绝及临时目录清理。
- 官方 Linux x64 包 SHA-256 校验通过；WSL Ubuntu 22.04 普通账号实际运行同一个
  `deploy/verify-blender-runtime.mjs`，返回 `BLENDER_RUNTIME_OK`。另清除 DISPLAY、
  WAYLAND_DISPLAY 与 LD_LIBRARY_PATH 后复测通过：UV 修复、材质、GLB 回读和破坏性合并拒绝均通过。
- Server typecheck、Cloud 边界、Repository 边界及 `git diff --check` 通过。
- 本机未安装 Docker，尚未执行最终 Debian server 镜像构建；该镜像实际验收由 Dockerfile 中强制 RUN 门禁执行。
  尚未推送、触发容器 CI 或部署，正式站用户模型未复测；WSL 通过不等同 CI/生产成功。

## 回滚

回滚为兼容当前 Cloud 数据协议的已验证 server/web/db-push 镜像组合；保留所有工程、数据库、对象资产和 PVC。
若旧镜像不含 Blender，导入 UV 修复/减面会恢复为不可用，应明确告知，不可绕过 QA 或改走浏览器实验内核。
若只回退本次源码，成组撤回打包与验收；已修复模型保留，不反向重建。
