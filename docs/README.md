# LI3D Documentation Map

本目录同时包含当前实现说明、历史阶段记录和未来方案。三类文档不能混用：

1. 当前行为以代码和本页列出的“当前真源”文档为准。
2. 带日期的 audit、merge、optimization、release 文档只描述当时快照，不保证仍然成立。
3. 名称含 `PLAN`、`SPEC`、`V0_1` 或以 Phase/Week 为主的文档是设计输入，不代表已经交付。

## 当前真源

| 主题 | 文档 |
| --- | --- |
| 总览、运行方式、功能状态、已知问题 | [../README.md](../README.md) |
| 现代化架构、收尾汇总与真实服务证据 | [modernization/README.md](modernization/README.md)、[modernization/CLOSING_REPORT_2026-08-22.zh-CN.md](modernization/CLOSING_REPORT_2026-08-22.zh-CN.md)、[modernization/FEATURE_ACCEPTANCE_MATRIX.md](modernization/FEATURE_ACCEPTANCE_MATRIX.md) |
| 产品目标与功能矩阵 | [00_PRODUCT_GOAL.md](00_PRODUCT_GOAL.md)、[01_MODDDIF_FEATURE_BREAKDOWN.md](01_MODDDIF_FEATURE_BREAKDOWN.md) |
| 技术架构、3D 引擎和项目数据 | [02_TECH_ARCHITECTURE.md](02_TECH_ARCHITECTURE.md)、[03_WEB3D_ENGINE_DESIGN.md](03_WEB3D_ENGINE_DESIGN.md)、[04_PROJECT_SCHEMA.md](04_PROJECT_SCHEMA.md) |
| 图层、捕获、投影、Liclick、UV | [05_LAYER_STACK_DESIGN.md](05_LAYER_STACK_DESIGN.md)、[06_CAPTURE_AND_PROJECTION_DESIGN.md](06_CAPTURE_AND_PROJECTION_DESIGN.md)、[07_LICLICK_API_ADAPTER.md](07_LICLICK_API_ADAPTER.md)、[11_UV_BAKE_MVP_NOTES.md](11_UV_BAKE_MVP_NOTES.md)、[19_PROJECTED_LAYER_VISIBILITY_AND_DEPTH.md](19_PROJECTED_LAYER_VISIBILITY_AND_DEPTH.md) |
| 工作区、导出 | [14_PROJECT_WORKSPACE_AND_PACKAGE.md](14_PROJECT_WORKSPACE_AND_PACKAGE.md)、[15_EXPORT_MATRIX.md](15_EXPORT_MATRIX.md)、[17_EXPORT_MVP_IMPLEMENTATION.md](17_EXPORT_MVP_IMPLEMENTATION.md) |
| Web 身份、数据和部署 | [22_FEISHU_OAUTH_LOGIN.md](22_FEISHU_OAUTH_LOGIN.md)、[23_DATABASE_SCHEMA.md](23_DATABASE_SCHEMA.md)、[24_MULTI_USER_WORKSPACE.md](24_MULTI_USER_WORKSPACE.md)、[25_AUTH_SECURITY_NOTES.md](25_AUTH_SECURITY_NOTES.md)、[60_SINGLE_NODE_WEB_MVP.md](60_SINGLE_NODE_WEB_MVP.md)、[61_FEISHU_WEB_LOGIN_SETUP.md](61_FEISHU_WEB_LOGIN_SETUP.md) |
| A100 真实服务器交接 | [A100_SERVER_HANDOFF_2026-08-23.zh-CN.md](A100_SERVER_HANDOFF_2026-08-23.zh-CN.md) |
| 当前性能验收方法 | [performance/LI3D_PERFORMANCE_TEST_PROTOCOL.zh-CN.md](performance/LI3D_PERFORMANCE_TEST_PROTOCOL.zh-CN.md) |

## 端口真值

| 用途 | 值 |
| --- | --- |
| Vite 开发页面 | `5173` |
| 源码/`pnpm dev` 主服务默认值 | `4518` |
| 集成或 LAN 部署 | 由 `SERVER_PORT` 决定；现有部署示例常用 `4517` |
| 已退役 Windows 本地组件 | 历史端口 `4618`；现代化 Cloud 产物禁止访问 |

旧文档中的 Electron `4617/5673`、本地组件 `4618`、`dist-installer` 或 `package:windows` 属于已退役桌面/组件方案。

## 当前功能速查

- 已完成纵向证据：零安装 Cloud 边界、真实员工登录、多实例 PostgreSQL 项目事务、真实 Auto UV 小模型成功、真实 Substance 4K 七通道烘焙、工具箱 UI 对齐。
- Auto UV 小模型已成功，但大型工业模型仍曾触发 `UV_QA_FAILED`；Auto Retopology 仍为 `RETOPOLOGY_COORDINATE_MISMATCH`。二者尚不能整体标为生产通过。
- 部分交付：贴图项目、模型导入与变换、单/多视图 Texture Map、自动投影、局部重绘、图层合成、手动 UV 合并与导出；仍需生产资产和性能矩阵。Normal 生成不可用；PS/DCC 实时桥接已暂缓。
- 未交付：Quick Mask、Segments/ColorID、贴图工作台内的 Normal/Roughness/Metallic 烘焙、MP4、`.liclick3d` zip。
- 当前没有全局 Auto UV bake 开关。投影结果保持为实时投影层；用户手动合并 UV，模型/贴图导出按需生成精确 BaseColor。

## 历史与规划文档

- `08_4_WEEK_MVP_PLAN.md`、`28_TEXTURE_MAPPING_MODE_PLAN.md` 和 `39`–`42` 是计划/规格；其中一部分后来已实现，状态以当前真源为准。
- `29`–`38` 是 2026 年 7 月的性能、桌面安装器和发布审计。桌面安装器结论不适用于当前 Browser Service + Local Component 架构。
- `HANDOFF_*`、`MASTER_UPLOAD_*`、`MERGE_*`、`OPTIMIZATION_*`、`TODAY_*`、`*_UPDATE_*` 与仓库根目录日期/merge notes 是变更历史。
- `performance/LI3D_PERFORMANCE_OPTIMIZATION_PHASE_*` 是分阶段优化记录；它们解释为什么代码这样演进，不替代当前功能说明。

如果历史文档与当前真源冲突，先检查当前代码，再更新当前真源；不要反向改写带日期的历史事实。
