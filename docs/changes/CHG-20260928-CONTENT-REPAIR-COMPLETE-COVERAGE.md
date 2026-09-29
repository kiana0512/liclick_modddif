# 内容填补残余完整覆盖

主模块 M09，协作 M07/M08。`ALG-CA-003` 表面约束传播 v1.4.0，production；`ALG-CA-001/002/004`、Layer/Project Schema 无版本变化。用户报告布料接缝和未贴图处有点状缺口，随后局部重绘上传图中留下白点。旧策略即使仍有 `unresolvedPixels`，也发布部分稀疏图层并提示完成；完全无同 region 或单物理缝 donor 的 UV 岛始终透明。

## 输入、输出与规则

- 输入：完整分辨率投影合成 RGBA、严格 UV core 内的缺口 mask、region/物理缝拓扑和现有高置信纹理像素。颜色为直通 sRGB 字节；UV 和屏幕捕获矩阵、阈值及颜色空间不改。
- 首轮仍按同 region 边界传播并局部混合。只在确有残余时构建物理缝拓扑，第二轮最多跨一条可信缝；两轮成功像素在稀疏 RGBA 中优先保留。
- 第二轮无法到达的剩余 mask texel，才用本次输入中通过 alpha 与颜色离群门禁的已有纹理像素均色写入 alpha=255。没有 seam link 也执行该残余兜底；从不写未选 texel、core 外 halo、真实几何空隙或有效投影。诊断记录 `globalFallbackPixels`，用户收到近邻供色不足的警告。
- 若模型根本没有任何可靠颜色，或末轮仍有残余，则拒绝发布新图层。自动多视图流程收到失败并提示补缝未完成，不再把部分结果当成功。旧图层和原始资产保持原样。

## 对照审计

- GPU：投影 raster/Resident UV、显示上传和材质采样不改；新图层仍走现有原子预热发布。
- CPU：主线程兼容路径和 Worker 共用 `repairSurfaceTexture`，只有末轮显式打开兜底；首轮、一般调用和黄金像素不变。
- Worker：末轮继续使用已转移的 source/mask 与稀疏 RGBA 合并，保持取消、校验和及完整尺寸。
- Shader：实时空洞斜线、投影准入、UV 采样和 Alpha 公式不改。兜底只改变输入稀疏纹理的残余像素。
- Persistence：仍保存 `uv + content-aware-underlay` 的同一 PNG/Layer 契约；Project Command 幂等、Revision CAS、ownership、verified assets 不改。
- Export：仍使用现有 underlay 层序、方向与 source-over 合成；新兜底像素随普通 UV 作者资产导出，无独立导出算法。
- 局部重绘：上传输入生成公式不改；完成修补后的视口捕获获得已覆盖底色。未修补/旧图层不会被偷偷改写。

## 迁移与回退

无数据库、Schema、缓存键或资产迁移。旧项目需要重新执行内容填补才获得新像素；已有修补图层不删除。回退移除末轮显式 `fillUnreachableWithGlobalAverage`、零 seam 残余 pass 与完整覆盖发布门禁，恢复允许残余透明的旧行为；无需重写已保存 PNG。

## 验证

内容填补单元测试覆盖无 donor 岛的显式末轮、普通局部路径仍保留残余、Alpha 与颜色；拓扑分类和 Web typecheck 通过。只读浏览器夹具加载用户提供的第二个工程 `project-391f8fb8-9f5a-44ef-ad44-9ebdd95071b9` 中 `004_flour_bag.glb`、六个真实投影层及一个已有补缝层，按生产烘焙、拓扑、缺口扫描和修补路径逐像素核对：2048 下严格 UV core 2,824,550 px，原本全透明 404 px，修补请求 427 px，修补后全透明/可见缺口/请求未覆盖均 0 px，残余 0 px；4096 下严格 UV core 11,303,651 px，原本全透明 20 px，修补请求 33 px，修补后全透明/可见缺口/请求未覆盖均 0 px，残余 0 px，其中 32 px 使用末轮兜底。夹具只读本机工程资产。正式 `build:4517` 后重启本机前后端，health/ready/首页均返回 200。登录后的真实 4517 编辑器选中面粉袋执行原生 4K 内容识别修补，发布 `内容识别修补 2`：33 px 全部写入，其中 21 px 最终兜底；再次执行扫描，`hardPixels=0`、`weakPixels=0`、`totalPixels=0`，未发布多余图层。此真实操作经应用保存到了用户提供的第二个工程；局部重绘上传链路并未重新调用生图服务。
