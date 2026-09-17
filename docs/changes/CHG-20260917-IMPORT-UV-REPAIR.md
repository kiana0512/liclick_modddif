# 导入 UV 检查与用户确认后修复

- UI：贴图工作台模型导入（文件选择、拖放、批量文件共用入口）。主模块 M02，协作 M10/M13。
- 算法：`IMPORT-UV-REPAIR` v1.0.0；新增服务端 Blender 导入修复用途，不替代生产 Auto UV 页面、Asset V4 或 PBR 烘焙服务。
- 授权：用户确认“越界/退化 UV 检测 → 弹窗同意 → 服务器 Blender 展 UV、内缩 → 合格后导入”，取消不导入。该完整链路需要跨浏览器导入、确认 UI、受认证服务端路由及 Blender 脚本，超过默认单模块修复文件/行数范围，按已批准方案集中实现，不改投影/绘制算法。

## 输入与判断

输入为现有加载器解析的所有 Mesh、当前绘制 UV0 通道和实际三角形 drawRange，支持 indexed / non-indexed。按 Float32 读入，缺失 UV、非有限值、坐标严格超出 `[0,1]`、三角形二维行列式为零均需要修复。小而非零的三角形不按经验阈值误判。不把坐标逐点 clamp 到边界。

正常模型保持原 File 和原模型对象，无修复网络调用。异常模型在加入 scene、图层及保存模型资产之前弹出原生模态 dialog，显示异常面数和改变原贴图映射的风险。取消、Escape、组件卸载或工程 revision 失效均不提交修复、不注册模型；修复请求中切工程则中止 fetch，丢弃迟到结果。

## 修复服务

仅确认后才以原数值坐标（不含编辑器归一化和场景排放）打包内嵌资源 GLB，等待异步 FBX 贴图就绪。带动画、骨骼、形态键的异常模型明确拒绝自动修复，防止静态导出损坏动画。原文件不覆盖。

`POST /api/asset-processing/import-uv-repair?consent=change-uv-v1` 复用现有 Origin 和会话认证，要求明确确认标记。GLB 结构、长度和资源 URI 校验，不允许服务器读取客户端指定的磁盘或网络外部资源。单进程一个修复任务，输入/输出 256 MiB 上限；进程 180 秒超时，客户端 210 秒等待；客户端断开终止 Blender，临时目录最终清理，失败不返回模型。

复用 Blender 版本/可执行路径检测、无 shell 子进程、强制后台、factory-startup、disable-autoexec、超时与中止逻辑。脚本随 server dist 打包，写入独立临时目录，不依赖发布时额外复制 Python 文件。Blender 切缝保留现有 seams，并按边界/非流形边或大于 66° 的夹角补缝；ANGLE_BASED 展开、平均岛尺度、全对象共同排布，margin=0.001。原网格、材质分区和几何面不主动删除。

UV 外边界安全余量为 `1e-6`，已满足不动；不足时对整套 atlas 统一等比缩放并平移入 `[epsilon,1-epsilon]`。仅补足外边界安全余量，不把它当作像素 gutter 或岛间距。输出 GLB 前后在 Blender 两次验证范围/面积和三角形数量，网页加载器再次按 Float32 验证，未通过不导入。对仍不能展开的退化几何明确失败，不放宽 GPU 校验或启用旧 CPU fallback。

## 资产、保存、导出及回滚

修复后正常创建对象，保存的模型资产是修复后的 GLB；重新打开和后续 CPU/GPU/Worker/shader/导出均读取相同的新 UV，没有仅运行时修复。保留源模型物理单位元数据，并在重开恢复该字段。正常模型保存路径不变；原有项目和资产不迁移，Project/Layer/Capture/Generation Schema 不变，沿用现有 Asset ownership、Project Command/Revision 保存。

本轮只修改 UV，没有把旧纹理转烘焙到新 UV；弹窗明确告知已有贴图可能错位。输出 GLB 含模型现有材质资源，其贴图视觉不能作为保色烘焙结果。UI 不宣称修复所有几何、UV 重叠、拉伸或所有材质通道的问题。

回滚：撤掉导入确认/修复入口及对应服务路由，已生成 GLB 保持普通模型可读，无数据库变更或回滚迁移。不得把现有已修复资产替换回原文件。

## A100 与验证

已确认 A100 Blender 5.1.2 路径：`/data/AIGC-YuHaoze/Li3D/tools/blender-5.1.2-linux-x64/blender`。正式部署时需在服务环境配置 `BLENDER_EXECUTABLE_PATH`；当前运行服务没有设置该变量，开发验证只向隔离测试进程传入，不修改在线配置、不重启在线服务。

- 前后端类型检查、源文件 lint、Server build。
- `check:import-uv-browser`：实际 React dialog、取消/Escape/切工程不请求、确认后单次请求、正常模型绕过、失败/返回坏 UV 拒绝、资源释放、保存 File 再加载校验、indexed/小面积/越界/退化/非有限输入。
- `test:import-uv-repair`：真实 HTTP 方法/确认门禁，GLB 数据和外部资源拒绝；可选 `UV_REPAIR_INPUT` / `UV_REPAIR_OUTPUT` 跑真实 Blender、忙状态和取消释放容量。
- 用户柴油机车 FBX 经网页真实加载/打包、A100 Blender 脚本、GLB 导出回读、网页再加载：1742 个退化 UV 三角形 → 0，越界 0，三角形仍 1742，归一化包围盒误差小于 `1e-5`；未删掉原有几何面。真实 HTTP 服务处理返回 213916 字节 GLB。
- 现有模型面数限制、多模型恢复回归通过。

本变更已随 `32ad28ce` 进入 `master`，并在最终 `2222576c` 基线上完成 Server 24/24、Web 147/147 及独立 `check:import-uv-browser` 真实浏览器回归。浏览器回归覆盖 Float32 UV 检查、indexed/小面积、正常模型绕过、确认/取消/Escape/切工程、服务失败、回读 QA 失败、修复文件再加载和资源释放。

尚未部署到在线 A100 应用，也未把 `quality/cloud-release-readiness.json` 中的生产 UV 或真实工作流能力改为 passed。隔离测试不修改用户工程；正式发布仍需配置 `BLENDER_EXECUTABLE_PATH` 并完成生产环境验收。
