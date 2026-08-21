# ADR-0001：云端控制面与浏览器本地计算面

- 状态：Accepted
- 日期：2026-08-21

## 背景

现有系统把项目/资产/账号能力绑定到 Windows 本地组件，同时发布链路允许 Web、主服务和本地组件独立漂移。莉刻平台要求零安装，但普通贴图计算又必须使用用户自己的 CPU/GPU，不能由 LI3D 服务器兜底。

## 决策

采用 Cloud-Local Compute 架构：

- 项目、身份、权限、资产索引和 Revision 迁到云端控制面。
- 普通贴图计算在浏览器通过 WebGPU/WebGL2、Web Worker 和 WASM 执行。
- AI 推理保持独立远端服务，但不得作为低性能设备的隐式降级路径。
- 莉刻构建只允许 Cloud Adapter；Desktop Legacy Adapter 仅在迁移期内部版本存在。
- 浏览器本地缓存只做加速和 checkpoint，云端项目 Revision 是权威状态。

## 后果

正面：

- 莉刻用户无需安装本地程序。
- 用户数量增加时服务器压力主要是元数据和带宽，而不是 Bake 计算量。
- 项目可以跨设备恢复，发布不再依赖某台电脑上的本地组件版本。

代价：

- 必须建立 WebGPU/WebGL2/WASM 能力分级和硬件基准。
- Auto UV、拓扑和 High-to-low Bake 需要验证或迁移为浏览器算法。
- WASM 多线程要求 HTTPS、COOP/COEP 及兼容的 CDN/CORS 配置。
- Photoshop/DCC 实时控制不能成为莉刻核心流程；Cloud 模式改为标准资产导入导出。

## 禁止事项

- Cloud Build 访问或探测 `127.0.0.1`/`localhost` 本地服务。
- 因用户设备较慢而把普通贴图任务静默转移到服务器。
- 在 React 页面组件中直接拥有跨项目 GPU 资源和持久任务生命周期。
- 在生产服务器执行 `git pull`、现场构建或保存 Git 外产品代码。
