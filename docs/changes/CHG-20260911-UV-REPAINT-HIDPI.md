# 局部 UV 重绘 HiDPI 分块错位修复

- 主模块 M08 / ALG-LR-UV-PAINT v1.1.2，运行标记 UV_REPAINT_VERSION=4；协作 M03/M07/M11/M12，仅审计下游，不修改其算法。
- 用户录屏反复画同一区域留下阶梯形旧贴图。已安装 Three.js 的 renderer.setScissor 在绑定离屏目标时仍乘屏幕 DPR；原调用却直接传物理 UV texel。DPR=1.5 时 x=256、width=256 被变为 x=384、width=384，而 CPU 选块/读回仍为原坐标。
- source 与 output 两遍共用 setUvScissor，只在该适配器除以 renderer DPR，让实际 GL scissor 保持物理 UV 像素。不改全局 Three.js，不降低 DPR/输出分辨率，不放宽 source alpha、作者 mask、depth/face 可见性、共享 UV 取色或混合公式，不恢复自动补洞。
- GPU 正确写入原脏瓦片；CPU 的 publish/undo/redo/readback 不变。Worker、保存、UV 合并及 FBX 继续消费原 barrier 后的 RGBA；无第二套需要同步的裁剪算法。图层顺序、旧投影重绘和单视图不变。

## 回归证据

- 新增真实 WebGL 测试先在未修复代码失败：DPR=1.25 的 scissor 为 0,0,320,320，而 tile 应为 256×256。修复后 DPR 1/1.25/1.5/2 全部通过。
- 使用 640×640 UV 验证非零偏移及末行/末列 128px 瓦片；各 DPR 五笔（包含擦除）整张 GPU RGBA 逐字节一致，累计覆盖均为 6264/12528/18792/23972/21216。两遍共 90 次 GL scissor 校验/比例；脏块之外 GPU 与 CPU 全图一致，撤销/重做精确恢复，重新准备的 Canvas/GPU 仅允许既有预乘透明度量化误差。
- CI 的 native UV 回归直接执行生产坐标适配器，验证四种 DPR、偏移/末边瓦片及两遍调用契约；浏览器测试入口默认包含上述矩阵，并支持 --dpr=1.5 验证真实 React ViewportCanvas。
- 原模型、来源图、深度和两组相机的隔离真实视口复测（未启用诊断 wrapper）：DPR=1.5 五笔累计覆盖 3404/8661/12598/16609/21253；下一代四笔 4122/8059/12097/16786。旧实现分别为 96/96/96/3208/7852 和 3036/6973/6973/11587，确认被吞笔画恢复。未改用户线上工程或调用生图。
- 真实 React DPR=1.5：独立两/三层共存、显隐、覆盖撤销、擦除撤销、PNG、FBX 颜色和重开通过；既有 9 组 1K/4K 可见性测试零漏点，薄斜遮挡物测试通过。
- 118 项 Web 回归、全仓类型检查、lint（0 错误、14 个既有警告）、Cloud/持久化边界、9 项协议和 7 项部署回归通过；新增 CI 坐标适配用例独立复跑通过。

## 兼容、边界和回滚

- 不修改 Project/Layer/Capture/Generation Schema、Command 幂等、Revision CAS、ownership 或 verified assets。保留 native-v1 图层 ID，不做存量数据迁移，不自动补写之前遗漏的像素；保存后刷新，再在旧遗漏处重新绘制。
- 录屏当时实际 DPR 未采集；原模型夹具不等于全部历史图层重现。修复已证实的分块错位，不声称解决所有不可绘区域或鼠标椭圆显示差异，不宣称长期性能达标。
- 回滚本次 M08 坐标适配和运行版本或恢复 A100 发布备份即可，保留新旧已保存 RGBA 与全部资产。旧程序可读取新像素，但高 DPR 绘制缺陷会重新出现。
- 发布前须对最终提交执行 verify:prepush，记录产物预算；推送 master 和 A100 发布结果独立核对。
