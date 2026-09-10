# CHG-20260910-UV-RESIDENT-QUALITY

状态：候选、本机验收；尚未证明完整 Merge 毫秒级，不发布到 Cloud。

2026-09-10 master 集成：按用户要求仅提交 master 并运行其 CI；不修改 release 分支、tag 或部署配置。保留上游 20b0912 的重绘 source alpha 契约，在 engine 准备入口透传 ignoreSourceAlpha；会话签名 v11、派生内容契约 uv-composition-7/resident-2.2.1/persistent-2 拒绝集成前旧缓存，首次需重新生成派生结果，历史资产不改写。新增准备/最终 PNG/持久缓存回归接入标准 CI 套件。

主模块 M07；协作 M06/M09。ALG-UV-003 v2.1.0 候选，涉及 ALG-UV-001/008 的 GPU 采样与读回调度。用户要求替换投影到 UV 中间流程、保留正确完整分辨率并提供内置浏览器实际效果。

集成检查：112 项 Web 回归、全仓类型检查通过。修复上游 FBX 浏览器 fixture 缺失的 ESLint 全局声明；Cloud 候选 JS 实测 3,189,943 bytes（上游 3,163,384），新增常驻内核与缓存功能分配 27,000 bytes 总体积额度，所有单 chunk 上限与质量门禁不变。CI 和部署配置未修改。

## 实现
普通投影复用原 coverage-alpha/quality-alpha RGBA8 shader 输出，在 WebGL RGBA32UI ping-pong 中保存 Top-3；删除通过校准后的普通层逐层整图 CPU 读回、CPU Top-K 和重新上传。浮点排序使用 CPU double 与存储 Float32 的非对称比较排名，反预乘用完整 256×256 原 JS 舍入表。GPU resolve 保留原质量、颜色一致性和 dominance 公式；舍入边界像素稀疏读取候选，由与原 Worker 共享的 canonical CPU 单像素核修正。最终完整 RGBA 仍按原 8 MiB 条带读回，GPU reduction 保留各层 coverage 总计。

按 renderer/alpha 模式首次实际结果与强制 CPU 原核逐字节校准，仍要求 alpha 零差异、RGB 最大差 1、差异比例不超过 0.00001；失败返回 CPU 并禁用该模式，context loss 清除批准。当前仅显式 URL perfResidentQuality=1 启用，perfQualityCpuGold=1 回退原核，perfQualityGpuAb=1 每次校准。2–255 层、最高 4096，无静默降分辨率。局部重绘/其他 overlay 仍按原 Worker 顺序叠加，已有 literal suffix GPU 批合成保持。后续补缝、拓扑填孔、gutter、PNG、预热与持久化保持。

## 审计与验证
GPU/GLSL：新增常驻质量内核，原几何投影 shader 不变。CPU/Worker：原像素核提取共享，CPU raster fallback 不变，新增已校准底图的原 overlay 入口。保存/导出：仍输出原 ImageData，经原处理、PNG、verified asset、Project Command/CAS/ownership 流程；没有新持久字段或后台补低清。

已通过 TypeScript、变更文件 ESLint；原 quality-blend 240 CPU 对照及 GPU tile/资源回归通过。真实 WebGL 23 层随机字节 128²、不透明及 coverage alpha 两种模式均与冻结旧核零差异；coverage reduction 精确。RTX 4070 Ti SUPER，23 层 4K 已上传常量输入，最终条带读回及稀疏检查热态约 140–154ms、首次约 220ms。这只是隔离内核，不含真实投影、解码、补缝、保存、显示；不得宣称完整 Merge 达标。真实工程结果和总耗时仍待内置浏览器验收。

## 迁移与回滚
算法实现候选版本升级，无 Project/Layer Schema、缓存像素语义或资产迁移。关闭 perfResidentQuality 即恢复原完整流程。不要删除旧资产、绕过 QA 或复用未校准模式。候选尚未提交/推送/部署 Cloud。

## 实测后续：最终显示上传调度

实际割草机器人工程最终预热 2362.7ms。M09 的候选可见纹理上传改为累计 4ms 同步提交预算才强制等呈现，条间仍让出任务、检测交互/取消；掉帧反馈仍触发呈现，原条带像素、GL 状态恢复和末尾两帧显示门禁保持。真实 WebGL 4096² 同图 A/B 上传 2158→100.1ms，64MiB 输出逐字节零差异（130/128 条），只代表上传阶段。原 90 项资源/故障回归及新增 14 项候选路径回归通过。仍仅 perfResidentQuality=1 生效，未宣称整个 Merge 已秒合成。

## 后台完整 UV 缓存候选

M07 / ALG-UV-003 准备策略 v2.2.0 候选：页面稳定且空闲后以原完整分辨率和完整后处理提前准备当前可见投影；后台与点击 Merge 共用唯一入口、相同 in-flight 请求和有界一项结果缓存。层/作者蒙版变化失效，旧任务不发布；工程切换/卸载清理。缓存签名 v10 增加 mesh/geometry 身份、position/normal/UV/index revision、draw range、矩阵与可见性。全栈 bake 串行保护共享离屏 renderer；不写图层、项目、资产，不降低 QA，模块按需加载。PNG、UV underlay 合成及持久化尚在点击路径，因此不宣称完整 Merge 毫秒级。缓存同请求去重、输出隔离、变化失效、旧结果拒绝和退出清理回归通过。回滚关闭候选参数/移除准备订阅；无持久化 Schema 或资产迁移。

## 跨刷新与最终编码准备

持久缓存 v1 使用当前账号/项目/对象/分辨率、几何属性与源图实际字节 SHA-256、完整图层参数和后处理/debug 契约建立键，排除运行期 UUID 与 blob URL 身份。保存完整 RGBA 与原报告并验证整条记录 SHA-256；恢复检查分辨率/长度，损坏/不可读取/动态不可获取源回退原核，不接受旧内容。最多两项浏览器派生缓存，不写 Project/Layer/Command/CAS 或云端资产；缓存写完才报告 ready。形变蒙皮暂不持久复用。预热另外提前完成 UV underlay 合成与无损 PNG 编码，只对相同有序输入复用 Blob；最终 verified asset 保存及正式 GPU 上传仍在提交路径。跨刷新身份、实际 UV 改动、账号隔离、RGBA 精确恢复、损坏拒绝回归通过。全部 GPU 尚未完成，CPU 后处理与边界修正仍存在，不能据此宣称全 GPU/点击毫秒级达标。

## 实际工程首轮阶段数据

割草机器人、20 个投影输入、4096：后台完整准备 37425.7ms；GPU raster/readback 12015.2ms，literal batch 6 层省 11 次读回；resident quality accumulate 78.4ms、resolve 394.2ms、overlay 118.2ms，CPU 对照 RGB/alpha 零差异。seam reconciliation 5493.3ms，coverage repair 8130.7ms，gutter 2755.2ms（含拓扑约 2001.7ms），最终清理 166.3ms。明确未达到冷计算毫秒级；当前瓶颈为旧逐层参考路径与 CPU 几何后处理。

## 后处理等价删减与接缝关系复用

M07 / ALG-UV-005 v2.0.4（实现优化，像素语义不变）：gutter 去掉逐轮 pending Map 与第二次整批写回。前一轮 frontier 是唯一 donor，新目标立即标记 coverage 并按发现顺序追加下一轮，因此仍为原先的 first-donor / Map 插入顺序；邻接方向、迭代次数、source alpha、rgb-only coverage=2 均不变。UV 内孔修补仅需要 coreMask/regionIds，关闭不被消费的 seamLinks 构造；原几何法线门禁和岛屿归属分析仍执行。

接缝修补在相同几何时复用内部 pair 关系；缓存严格比较 position/normal/UV/index 的实际字节、attribute 解释方式、遍历顺序与世界矩阵，不依赖 needsUpdate 或短哈希。一次只保留一个根节点的私有关系，几何快照最多 32 MiB、pair 最多 100,000，超限不缓存；分段构造中模型变化不发布缓存。透明 missing-coverage 模式原来每笔同步更新 data/source，现在直接共享 data，去掉一张 4K/64 MiB 复制；平均颜色模式仍保存不可变源。几何关系仅会话驻留，完整 UV 结果仍按前述持久缓存跨刷新恢复。

GPU/CPU/Worker/shader 审计：此次删减在三条 bake 后处理公共 CPU 入口生效，GPU 投影/质量核、Worker overlay 和 shader 未变；没有把仍在 CPU 的后处理宣称为 GPU。PNG/export 与 verified assets、Project Command 幂等、Revision CAS、ownership 完整保留。没有像素/Schema 改动，不升级已验证像素缓存键、不使现有缓存失效；回滚这三项等价优化即可，无历史资产迁移。

验证：原 600 gutter + 500 补洞/扩展 + 40 接缝冻结核对照保持，增加 24 组有/无 seamLinks 的 coreMask/regionIds/conflictMask 精确对照，以及未设 needsUpdate 的几何/UV/normal/index 编辑、矩阵/层级/attribute 解释改变后的缓存失效与冷/热像素对照。隔离 4096²/16 轮 gutter 三次：旧 1310.8/1295.5/1278.1ms，新 264.1/259.1/260.3ms，完整 RGBA/coverage/count 零差异；约 13 万面球体 seam 关系首次 406.6ms、复用 7.8/7.5ms。属于隔离阶段数据，不能替代用户实际工程完整 Merge 耗时。

真实工程已验证一次完整准备后刷新为 `uvMergePreparationRead=disk-hit`，完整 UV 与最终 PNG 均 ready，未重跑 37 秒准备；仍不代表首次计算或整个点击链路毫秒级。新增删减后的真实工程总耗时仍需实测。

最终 PNG 命中时，提交入口改为读取准备结果的不可变引用，跳过前台及页面重复缓存的两份 64 MiB RGBA 复制；只复用相同完整签名的 PNG，未命中仍持有独立可写副本。原 coverage 报告、上传资产与真实 GPU 呈现门禁不变。

实际点击发现最终准备范围错配：工具栏只传可见 projected IDs，而准备服务把可见修补 UV 也当作 underlay，导致 final PNG miss；旧实测 20 投影/4K 点击到原子图层切换 1918.4ms（最终纹理预热 242.3ms）。准备范围修正为此工具栏的投影输入；显式选中 UV 合并仍按原精确 key 和完整 underlay 路径处理，不强行复用不匹配 PNG。增加含可见修补 UV 的准备回归，未改按钮合并/消费语义、像素算法或持久缓存键。

修正后真实工程复测：20 投影/4096、最终 PNG hit，点击到原子图层切换 365.2ms，其中 preview prewarm 312ms。该计时在 store 原子切换处结束，不能等同于下一帧最终显示时间；只适用于完整结果已准备的热态，首次 4K 冷计算仍非毫秒级。两次保存 PNG 的完整 SHA-256 相同。发现原 UV-only 未覆盖背景变白的显示差异，另卡 CHG-20260910-UV-MERGE-EMPTY-FALLBACK 修复，不能只凭速度宣告画面验收。

包含显示修复的最终构建再次实测 366.4ms（prewarm 310.7ms），白块问题在原模型消失。测试合并已 UI 撤销，内置浏览器保持新版本，原投影和持久准备可供再次测试。当前仍未消除冷计算中的 CPU 后处理，也未证明 23 层、不同机器或首次计算同样达到此耗时。
