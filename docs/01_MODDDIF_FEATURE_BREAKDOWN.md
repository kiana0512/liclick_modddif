# Feature Breakdown

本表描述 `codex/modernization` 当前代码能力。`Passed` 表示有真实输入/输出和恢复证据；`Connected, quality blocked` 表示真实链路已证明但算法质量门禁失败；`Partial` 表示仍缺生产验收；`Deferred` 表示本轮明确不交付。

| Area | Current status | Actual behavior |
| --- | --- | --- |
| Unified home | Partial | 四张模块卡保留原产品信息架构：贴图绘制、Auto UV、模型烘焙、工具箱 |
| Feishu/Atlas login | Local real-user flow passed | Server-side OAuth/IDaaS、HttpOnly LI3D 会话、真实员工姓名/邮箱；生产 HTTPS 回调仍待部署验收 |
| Projects | Partial | 项目/文件夹/资产/设置、Revision、Command 幂等、账号级历史和恢复边界已建立；数据库/对象存储事务化尚未完成 |
| Texture editor | Partial | Three.js 视口、浮动 Dock、对象/参考/生成/图层/变换面板、ViewCube、显示模式；完整生产回归仍进行中 |
| Objects and model import | Partial | 多模型、活动对象、显隐/选择/变换/居中/落地；GLB/glTF 为主，FBX/OBJ 实验性 |
| Reference images | Implemented | 导入、对象作用域、选择；支持单图/生成多视图成对分组 |
| Liclick image generation | Partial | 浏览器经 LI3D 应用服务器连接受控生成服务；任务可恢复/取消，不再依赖 4618 本地组件 |
| Texture Map single/multiview | Partial | 当前视角或 6/10/14/自定义视角批量编排，自动投影并尝试内容补缝；仍需生产资产矩阵 |
| Capture passes | Implemented | Color、Mask、linear-view Depth、Normal |
| Projected/UV layers | Partial | 多层实时投影、相机召回、约束、调整、Blend/Overlay、手动 UV 合并和修补层；仍需完整像素金图与恢复矩阵 |
| Local repaint/inpaint | Partial | 浏览器指针蒙版、表面约束、云端 ModelView 生成、Worker 边缘融合、Revision 保存和重启恢复已有真实证据 |
| Projected Layer Eraser | Implemented but disabled | 底层仍在代码中，当前发布不显示且阻止激活 |
| Undo/redo | Partial | 编辑器操作历史可用，跨全部异步任务的统一事务历史仍未完成 |
| Normal | Partial | Normal 视口和已有 normalMap 导出可用；Normal 生成未交付 |
| Quick Mask / Segments / ColorID | Placeholder | 尚无正式生产路径 |
| Auto Retopology | Connected, quality blocked | 真实 39.7 MB FBX 进入 `asset-worker-3090-b`；被 `RETOPOLOGY_COORDINATE_MISMATCH` 阻断，未发布错位结果 |
| Auto UV | Connected, quality blocked | 真实 Asset V4 容量为 9 Worker/16 槽位；任务进入 `asset-control-4090`，被 `UV_QA_FAILED` 阻断 |
| Model baking | Real vertical slice passed | 真实 `asset-worker-3090-b-windows` TLS 连接；完成 4K Base Color、Normal、AO、Curvature、World Normal、Thickness、Position |
| Toolbox | UI aligned | 保留原产品目录、下载信息和九项工具说明；不等同于 DCC runtime |
| Photoshop/Blender/3ds Max live bridge | Deferred | 标记 `DEFERRED_PS_DCC_BRIDGE`，不作为零安装浏览器核心链路 |
| Export | Partial | GLB/FBX/OBJ/STL、BaseColor、已有 Normal、PNG、WebM；ColorID/MP4/项目 zip 未实现 |
| Windows local component | Retired | 安装器、下载资产、4618 路由、身份桥接和启动/打包脚本已从现代化分支移除 |

## Important Semantics

- 浏览器本机算力用于视口、绘制、蒙版、投影、图层合成和适合浏览器的交互内核；生产 UV、拓扑和 PBR Bake 由真实 GPU/AIGC 服务执行。
- 多视图是多个单视图生成任务的批量编排，不是一次返回全部视角的占位调用。
- 贴图工作台的 BaseColor UV 合并与独立 Substance 模型烘焙是两套流程。
- 历史浏览器 xatlas/BVH 实验代码只用于回归和对照；正式页面不能静默回退。
- 页面显示成功、模拟器成功或链路可达不能替代生产资产质量通过。
