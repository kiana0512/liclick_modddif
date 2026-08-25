# Product Goal

Liclick 3D Texture 是面向 3D 资产生产的零安装 Web 工作台。同一账号工程沿以下流程流转：

```text
Texture -> Auto Retopology -> Auto UV -> Model Baking
```

首页保留贴图绘制、自动展 UV、模型烘焙和工具箱四个入口；自动拓扑作为贴图工程发布后的中间步骤存在。

## Current Product Boundary

- 浏览器负责统一入口、Three.js 视口、图层编辑、遮罩、投影和交互计算，直接使用用户设备的 CPU/GPU。
- LI3D 应用服务器负责飞书/Atlas 身份、HttpOnly 会话、项目 Revision、Command、账号历史、对象存储编排和任务所有权。
- 独立 GPU/AIGC API 集群负责 Auto UV、自动拓扑、Substance Bake、生成和局部重绘等生产计算。
- 正式 Browser Cloud Build 不包含 Windows 本地组件、安装器、loopback 守护进程或 `127.0.0.1:4618` 回退。
- 账号历史和项目数据由服务器按用户隔离；localStorage、OPFS 和 IndexedDB 只能作为缓存或恢复辅助。

## Delivered Core Workflow

1. 使用真实员工身份登录，在账号作用域中创建或恢复项目。
2. 在贴图项目中导入模型、参考图，捕获颜色/Mask/深度/法线并执行单/多视图 Texture Map。
3. 使用局部重绘、边缘融合、图层调整、内容补缝和手动 UV 合并修正结果。
4. 浏览器负责视口、蒙版、投影和图层合成；生成与重绘任务由受控服务处理。
5. 工程可提交真实自动拓扑，再把服务返回的正式低模继续交给真实 Auto UV。
6. 高模、低模和材质贴图可提交真实 Substance Worker，生成 PBR 贴图并写入账号历史。

## Current Acceptance State

- 零安装 Cloud 边界和真实员工本地联调链路已通过。
- Substance Bake 已完成真实 4K 七通道纵向验证。
- Auto UV 与自动拓扑已证明真实服务、真实 Worker、真实进度和账号历史链路，但生产输出分别被 `UV_QA_FAILED` 与 `RETOPOLOGY_COORDINATE_MISMATCH` 质量门禁阻断，不能标记完成。
- 生产 HTTPS OAuth、企业应用发布、目标域名、数据库/对象存储事务化和完整性能矩阵仍待验收。

## Deferred Or Not Productized

- Photoshop、Blender、3ds Max 实时启动与双向桥接标记为 `DEFERRED_PS_DCC_BRIDGE`；工具箱页面和标准文件下载/导入仍保留。
- 普通自由绘制 Brush、Quick Mask、Segments/ColorID、Normal 生成、MP4 与便携 `.liclick3d` 工程包尚未正式交付。

## Clean-room Requirement

- 不复制竞品私有源码、bundle、CSS、图标、Logo、图片、文案、私有 API 或品牌资产。
- 公共截图和公共功能描述只可作为信息架构参考。
- 视觉、组件实现、数据契约与资产必须为 Liclick 自有或合规开源内容。

当前详细状态见 [modernization/FEATURE_ACCEPTANCE_MATRIX.md](modernization/FEATURE_ACCEPTANCE_MATRIX.md)。原“四周 MVP”内容保留在 [08_4_WEEK_MVP_PLAN.md](08_4_WEEK_MVP_PLAN.md)，不再作为交付真源。
