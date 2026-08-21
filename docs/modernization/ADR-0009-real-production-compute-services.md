# ADR-0009：真实生产计算服务边界

状态：已接受并开始实施。

## 决策

- 浏览器保持零安装，不依赖任何用户下载的本地组件。
- 浏览器 CPU/GPU 用于视口、投影、图层合成、蒙版、局部交互和适合浏览器的贴图内核。
- Auto UV、自动拓扑和生产 PBR Bake 不在浏览器内伪造或替代；浏览器把输入交给 LI3D 应用服务器，由应用服务器调用独立 GPU/AIGC API 集群并返回产物。
- LI3D 应用服务器和 GPU/AIGC API 集群是两个部署边界。应用服务器承载登录、账号隔离、项目、历史、对象存储与任务所有权；GPU/AIGC 集群只提供计算 API。
- 正式模式禁止静默回退到模拟器、本地 xatlas 或本地 BVH。测试模拟器必须由显式命令启用，并在状态和证据中标记为模拟。
- UI 的 Worker、槽位、TLS、进度和错误必须来自真实状态 API。账号历史必须从服务器按用户读取，不能以 localStorage 作为权威数据。

## 2026-08-21 证据

- Asset V4 容量探测返回 9 个 Worker、16 个槽位，UV 与拓扑能力可用。
- 真实员工“任田”提交的 39.7 MB UV 任务进入 `asset-control-4090` 并运行 464 秒，历史记录归属该账号；最终被严格 QA 以 `UV_QA_FAILED` 拒绝发布，未把不合格产物返回前端。
- 真实 Substance Worker `asset-worker-3090-b-windows` 通过 TLS 检测，并完成 4K 的 Base Color、Normal、AO、Curvature、World Normal、Thickness、Position 输出；账号历史记录成功。
- 自动拓扑真实任务进入 `asset-worker-3090-b`，但被坐标门禁以 `RETOPOLOGY_COORDINATE_MISMATCH` 拒绝发布。该结果证明质量门禁生效，同时保留为待修的生产服务缺陷，不能冒充通过。

## 验收要求

1. 服务不可用时阻断提交并显示真实原因。
2. 真实任务必须具有可轮询 Job ID、可取消、可恢复的账号历史和经过校验的产物。
3. UV、拓扑和 Bake 分别至少完成一组生产资产端到端测试；失败门禁不得被前端绕过。
4. 模拟器通过不计入生产验收。
