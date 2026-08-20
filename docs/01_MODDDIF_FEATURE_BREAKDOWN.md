# Feature Breakdown

本表描述当前代码能力，不是竞品功能复制清单。状态含义：`Implemented` 为当前有可达实现；`Partial` 为只完成一部分；`Placeholder` 为 UI/契约占位；`Planned` 为尚无正式实现。

| Area | Current status | Actual behavior |
| --- | --- | --- |
| Unified home | Implemented | 四张模块卡：贴图绘制、Auto UV、模型烘焙、工具箱 |
| Projects | Implemented | 项目/文件夹/资产/设置、缩略图、创建与恢复；保存/返回时临时用 PBR 模式捕获项目缩略图并还原当前显示模式；服务离线时首页可显示 mock 项目回退 |
| Texture editor | Implemented | Three.js 视口、浮动 Dock、对象/参考/生成/图层/变换面板、ViewCube、显示模式 |
| Objects | Implemented | 多模型工程、活动对象、显隐/选择、归一化、移动/旋转/缩放、居中/落地/相机适配 |
| Model import | Implemented/experimental | GLB/glTF 为主；FBX/OBJ 实验性；当前贴图导入流程不接受 STL |
| Reference images | Implemented | 导入、对象作用域、选择；支持单图/生成多视图成对分组 |
| Liclick image generation | Implemented | 根据身份策略走 workspace Atlas 或个人 4618 本地组件；任务可恢复/取消 |
| Texture Map single view | Implemented | 当前视角捕获 + 材质参考，结果自动保存并投影 |
| Texture Map multiview | Implemented | 6/10/14/自定义视角；实际是多个单视图任务的批量编排，自动投影并尝试内容补缝 |
| Capture passes | Implemented | Color、Mask、linear-view Depth、Normal |
| Projected layers | Implemented | 多层实时投影、相机召回、Mask/Depth/Normal/背面约束、透明度、强度、调整、Blend/Overlay |
| UV layers | Implemented | 空白/导入/修补/合并 UV 层；可将选中投影和 UV 源合并到新层或空白层 |
| Local repaint/inpaint | Implemented | 画笔遮罩、加/减选区、表面约束、内容识别填充、远端编辑、Worker 边缘色彩融合、原图回退与 UV 修补提交 |
| Projected Layer Eraser | Implemented but disabled | 完整 surface/layer eraser engine 仍在代码中，但 `PROJECTED_ERASER_TOOL_ENABLED=false`，当前发布不显示且会重置激活状态 |
| Undo/redo | Implemented for editor operations | 底栏按当前历史状态启用，不再是统一占位按钮 |
| Normal | Partial | Normal 视口可视化和已有材质 normalMap 导出可用；Normal 生成面板仍为 coming soon |
| Quick Mask | Placeholder | 尚无正式生产路径 |
| Segments/ColorID | Placeholder | Segments 工作区与 ColorID 导出未实现 |
| Auto Retopology V6 | Implemented with route defect | 贴图发布/任务/历史/结果/继续 UV 已实现；直接刷新 retopology URL 会误进 Auto UV |
| Auto UV | Implemented | 远端资产任务、状态、历史、结果预览/下载与烘焙交接 |
| Model baking | Implemented | 独立高低模/PBR 工作台和远端任务代理，不等同于贴图编辑器 BaseColor UV 合并 |
| Photoshop Live Link | Implemented | UXP 包、loopback bridge、会话/资产交换 |
| Blender/3ds Max connectors | Placeholder | 协议包和目录存在，但 connector README/代码仍为占位 |
| Toolbox | Implemented as catalog/download | Max、Blender 和独立工具的下载入口；不是 connector runtime |
| Export | Implemented/partial | GLB/FBX/OBJ/STL、BaseColor、已有 Normal、PNG、WebM；ColorID/MP4/项目 zip 未实现 |

## Important Semantics

- 没有全局 Auto UV bake 设置。Texture Map 结果先成为实时投影层；用户手动合并 UV，导出按需准备当前可见栈。
- 多视图不是 `LiclickApiClient.generateMultiview()` 单次调用。`GeneratePanel` 捕获多个相机，再重复调用 `generateTextureSingleView()`；通用 `generateMultiview()` 方法仍会抛出未接线错误。
- 贴图工作台的 BaseColor UV 合并与独立“模型烘焙”模块是两套流程，不能用同一个“Bake”概念描述。
