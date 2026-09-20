# 局部重绘投影范围外暗带修复

- 状态：本地实现并通过下述自动回归，未推送、未部署；负责人：Codex。
- UI-05/UI-06/UI-10 → M08（审计 M06/M07/M09/M11）；`ALG-LR-008` bounded falloff v3.0.0、`ALG-LR-UV-PAINT` v1.3.0。
- 用户批准：确认“投影溢出范围外、羽化向内、避免背景取色”的方案后要求“可以，优化一下”。

## 证据与决策（ADR）

用户 ModelView 视频显示生成视角不明显、转动后出现淡灰长条，并给出擦除前后对照。发现两个可独立复现的扩散来源：

1. 主线程和 Worker 原 falloff 根据选区重心生成覆盖全画布的径向渐变，零点甚至在最远角之外，非选区及孔洞仍可能有权重。
2. 原生 UV 画笔继承投影图的 straight-RGBA mip 过滤；透明黑像素混入 RGB，较大过滤 footprint 还会使原图 alpha=0 的位置出现非零覆盖。真实 WebGL 的平面/圆管负对照复现 240–480 个范围外暗像素。

以冻结作者蒙版定义回贴授权，移除全图径向尾巴；不调整 3px@2048 轮廓内缩、不重新生成或修复 UV、不改变相机矩阵、不将黑色材质当背景删除。曲面遮挡深度、当前视角的可见面和笔刷范围仍同时约束写入。本次不声称已在用户原工程上完成最终视觉验收。

## 输入、公式与输出

- 输入：冻结作者 mask（max(RGB)/255 × alpha/255）、生成返图 RGBA、生成相机和已有深度；输出仍为相同完整分辨率的 UV RGBA。
- CPU/Worker 共用 `createBoundedRepaintFalloffPixels`：复用既有向内距离羽化（16px@2K，6–24px；阈值0.08），权重再以原 mask 覆盖封顶。输出白色 RGB + 权重 alpha，以兼容 Canvas destination-in 和 GPU luma×alpha。孔洞、未选区、空 mask 均为零。
- 原生 UV source shader 在原生 texel 中心无授权时返回零，不允许 mip/bilinear 扩大支持范围；透明边界用四个原生 texel 的 RGB×alpha 插值后除回 alpha。完整不透明区域继续使用原 mip 过滤。遮罩过滤权重以原生覆盖封顶；不增加 sampler。
- 颜色仍在既有 sRGB 解码后的线性空间采样，再按既有 UV render target 转回 sRGB；不改变物体/capture/world/UV 矩阵。

## 全链路审计

- GPU/shader：仅 `createUvRepaintSourceMaterial` 的局部重绘取色/授权；普通单/多视图投影及 GPU UV bake 不改。mask-only 橡皮分支不调用此源材质，保持不变。
- CPU/Worker：主线程 fallback 和真实 Worker 共用同一内向核；旧 Canvas 绘制路径也消费同样的 alpha falloff。
- 持久化/历史：原生 UV 保存实际 RGBA，新笔画没有额外图层/schema/算法字段；撤销/重做保留整块像素。Command/Revision CAS/ownership/verified assets 不改。
- 合并/export：既有 CPU Canvas、Worker 图层合成、GPU resident、PNG/GLB/FBX/OBJ 继续消费修复后相同 UV RGBA，无导出专用近似算法。旧投影图层已有 mask、旧 UV 像素不自动重写。
- 迁移：无资产迁移。已写入/合并的暗带不能通过升级自动消失，需撤销或擦除旧笔迹后重新回贴。历史源重新启用画笔时使用新范围规则。
- 回滚：整体恢复径向 falloff、缓存标识及旧 UV 源采样。已生成的 UV 资产保持可读，不删除任何图层/历史。

## 验证

- Web TypeScript、变更文件 ESLint、生产构建及原包体门禁通过：总 JS 3,254,090 / 3,256,500 bytes，未放宽预算。

- `run-repaint-bounded-projection.mjs`：真实 Worker 与 CPU alpha 一致，选区外/孔洞零覆盖，内部及羽化存在；平面和圆管、原视角和45°绘制、源 alpha/作者 mask 共16组。旧取色240–480个越界暗像素，新取色全部0；保留完整不透明核心，PNG保存回读及撤销重做一致。
- `run-uv-repaint-alpha-edge.mjs`：live GPU/Canvas/PNG重开/上下层合成/CPU颜色暗化为0；64/512/2048/4096 UV 岛边界、历史及擦除通过。
- `run-uv-repaint-browser.mjs`：DPR 1/1.25/1.5/2，曲面/平面、透视/正交、遮挡、旋转、共享UV、无效UV、作者/源alpha、sRGB通过。
- 9项 local repaint/native UV 单元与契约回归、Web TypeScript 通过。Projected visibility 源码测试在 Windows CRLF 下原断言失败；只在读取时规范换行后原测试全部通过，未放宽断言。

限制：自动夹具证实上述两种缺陷及修复，不等同用户完整原模型/原UV/旧已合并笔迹的验收。
