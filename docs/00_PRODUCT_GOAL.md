# Product Goal

Liclick 3D Texture 是面向 3D 资产生产的 Web 工作台。当前产品目标不是单一“AI 贴图 Demo”，而是让同一工程沿以下流程流转：

```text
Texture -> Auto Retopology -> Auto UV -> Model Baking
```

首页当前提供贴图绘制、自动展 UV、模型烘焙和工具箱四个入口；自动拓扑作为贴图工程发布后的中间步骤存在。

## Current Product Boundary

- 浏览器负责统一入口、工程 UI、Three.js 视口、图层编辑、遮罩交互和任务控制。
- 主服务负责 Web 身份、工程/任务文件、远端 Auto UV/Retopology/Bake/Inpaint 代理和遥测。
- 每位 Windows 用户的本地组件负责贴图本地文件、个人 Atlas/Liclick 登录、生成请求和 Photoshop/DCC 本地边界。
- 当前运行时持久化以 JSON + 二进制资产为主；Prisma 是未来数据库契约。

## Delivered Core Workflow

1. 在贴图工程中导入一个或多个模型并选择活动对象。
2. 导入材质参考，或从单图生成配对的多视图参考。
3. 从当前视角或多视角捕获颜色、Mask、线性视深和法线。
4. 提交单视图/多视图 Texture Map，自动保存结果和相机信息并建立投影层。
5. 使用局部重绘、边缘色彩融合、图层透明度/混合/调整和内容识别补缝修正结果。
6. 将需要的投影/UV 层手动合并到 UV，或在模型/BaseColor 导出时按需生成精确贴图。
7. 可将工程发布到自动拓扑，再进入 Auto UV 和独立模型烘焙工作台。

## Not Yet Productized

- 普通自由绘制 Brush、Projected Layer Eraser、Quick Mask、Segments/ColorID。Eraser engine 保留在代码中，但当前发布入口被关闭。
- Normal Map 生成，以及贴图工作台内的 Roughness/Metallic 烘焙。
- Blender/3ds Max 实时 connector；Photoshop UXP Live Link 是目前完成的 DCC 集成。
- MP4 与便携 `.liclick3d` 工程包。
- 数据库化、对象存储和分布式任务队列。

## Clean-room Requirement

- 不复制竞品私有源码、bundle、CSS、图标、Logo、图片、文案、私有 API 或品牌资产。
- 公共截图和公共功能描述只可作为信息架构参考。
- 视觉、组件实现、数据契约与资产必须为 Liclick 自有或合规开源内容。

原“四周 MVP”内容已经是历史计划，保留在 [08_4_WEEK_MVP_PLAN.md](08_4_WEEK_MVP_PLAN.md)，不再用它判断当前交付状态。
