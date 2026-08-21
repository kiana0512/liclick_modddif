# LI3D 现代化迭代总纲

状态：已批准执行，采用隔离仓库渐进迁移。

## 不可妥协的目标

1. 莉刻 Cloud Build 不要求安装本地组件，也不允许回退到 `localhost`。
2. 投影、图层合成、蒙版、UV/PBR Bake 等普通贴图计算使用用户浏览器的 CPU/GPU。
3. 云端只负责身份、权限、项目 Revision、对象存储、同步、审计和明确的 AI 推理服务。
4. 一个 Git SHA 只构建一次；Web、Server、协议和数据 Schema 必须具有同一 Release Manifest。
5. 迁移采用适配器和可回滚阶段，不通过验收门禁的替代实现不得删除旧路径。

## 目标边界

```text
Browser local compute plane
  React UI -> Project Domain -> Engine Session
                              -> WebGPU/WebGL2
                              -> Web Worker/WASM
                              -> OPFS/IndexedDB cache

Cloud control plane
  BFF -> Liclick SSO
      -> Project revisions
      -> PostgreSQL metadata
      -> signed object-storage URLs
      -> audit and observability
```

浏览器缓存不是项目权威数据。大模型、图片和贴图使用签名 URL 在浏览器和对象存储之间直传，BFF 不代理普通贴图中间像素。

## 迁移原则

- `master` 保留原始产品基线，现代化工作只进入 `codex/modernization`。
- 当前桌面路径被视为 `desktop-legacy` 适配器；新增业务代码不得直接依赖它。
- Cloud 边界检查首先采用固定白名单阻止债务扩散，随后按功能迁移逐项清零。
- 项目数据采用版本化 Command 和 Revision，禁止多个存储实现长期双写。
- WebGPU 是优先 Compute 后端；WebGL2 保留为成熟渲染和降级后端；CPU 算法进入 Worker/WASM。

## 阶段

| 阶段 | 交付物 | 退出条件 |
| --- | --- | --- |
| 0. 隔离与基线 | 独立仓库、审计、基准、ADR | 原仓库零修改，基线可复现 |
| 1. 发布与契约 | Release Manifest、CI、Cloud 边界门禁 | 混合版本可检测，新债务被阻断 |
| 2. 项目领域 | 权威 Schema、Command、Revision、迁移 | 项目协议只有一个实现 |
| 3. 云端数据面 | PostgreSQL、对象存储、签名直传、SSO | 无本地组件可保存和恢复项目 |
| 4. 本地计算面 | Engine Session、Scheduler、资源预算 | 重任务不阻塞交互，服务器不补算 |
| 5. 算法迁移 | WebGPU/WASM Bake、Auto UV、拓扑 | 核心贴图计算全部在浏览器 |
| 6. 切换 | Cloud Build 清零 localhost 依赖、灰度 | 干净设备纯浏览器 E2E 通过 |

详细门禁见 [ACCEPTANCE_GATES.md](./ACCEPTANCE_GATES.md)，首个架构决策见 [ADR-0001](./ADR-0001-cloud-local-compute.md)。

逐功能的真实完成状态见 [FEATURE_ACCEPTANCE_MATRIX.md](./FEATURE_ACCEPTANCE_MATRIX.md)。机器可读发布闸门会拒绝任何仍为进行中、失败或未测试的必需能力。

## 当前实施状态

- 隔离基线已建立，原仓库不参与现代化修改。
- Release Manifest、协议兼容检查和发布环境一致性校验已接入。
- Cloud 构建已采用独立适配器：项目/设置走同源控制面，浏览器贴图入口不检测桌面组件。
- Cloud 产物门禁会拒绝安装器、可执行文件、本地账号桥接端点和 `4618` loopback 回退。
- 桌面组件、个人设备账号和 Photoshop/DCC 仍保留在 `desktop-legacy` 兼容路径，Cloud 构建不装载这些实现。
- 浏览器能力协商已形成版本化 Compute Policy；任何降级仍在用户浏览器执行，`serverFallbackAllowed` 固定为 `false`。
- 项目保存已加入服务器签发的单调 Revision；Cloud 模式拒绝缺失或过期令牌，避免多端用客户端时间戳互相覆盖。
- Cloud 保存、重命名和移动已统一为版本化 Project Command；网络重试具有持久化幂等回执，同一命令不会重复生成 Revision，旧桌面接口继续作为兼容适配器。
- 项目路由、命令、资产、导出和文件夹服务已收拢到单一 Project Repository；门禁阻止业务层重新绑定文件系统，并已给出 PostgreSQL/对象存储权威数据蓝图。
- Cloud 最终产物已加入分块和总 JavaScript 体积 ratchet；当前性能债务、拆分顺序和 demand-render 前置条件记录在性能基线中。
- Cloud 大资产已采用签名对象存储直传；本地远端部署模拟器已覆盖失败重试、校验、幂等完成、签名下载和控制面重启恢复。
- 项目级 Engine Session 已接管第一批全分辨率 UV/修补任务，并统一计算计划、并发、取消和资源释放边界；其余算法继续渐进迁移。

计算策略见 [ADR-0002](./ADR-0002-browser-compute-policy.md)，项目并发策略见 [ADR-0003](./ADR-0003-project-revisions.md)，写入协议见 [ADR-0004](./ADR-0004-project-commands.md)，Cloud 数据边界见 [ADR-0005](./ADR-0005-project-repository-cloud-data.md)，对象直传见 [ADR-0006](./ADR-0006-direct-object-storage.md)，Engine Session 见 [ADR-0007](./ADR-0007-engine-session.md)，当前性能预算见 [PERFORMANCE_BASELINE](./PERFORMANCE_BASELINE.md)。
