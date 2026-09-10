# CHG-20260910-UV-DEFAULT-RESIDENT

主模块 M07；协作 M06/M09。ALG-UV-003 v2.1.1（路由和失败策略），准备策略 v2.2.2（GPU 所有权），ALG-UV-005 v2.0.5（等价候选删减）。用户要求所有正常入口使用新实现，旧实现仅作代码备份；速度目标毫秒级且保持正确。此前 ac2afb2 已推送 master，release 分支/tag/部署配置不动。

## 已实现

最新用户明确要求先砍掉补洞：公共 Merge/export profile 的 uvCoverageGapPixels、uvInteriorHolePixels 均设为 0，完整停用拓扑覆盖扩展与内部孔洞填充，未覆盖区域保留原样。保留独立几何接缝 band 和 UV 外侧过滤 gutter。旧补洞函数留在代码供其他明确修补用途/诊断，不再在普通 Merge 调用。此前正在开发但尚未接入的 GPU 补洞草稿已移除，不等待其完成才关闭补洞。Merge 像素语义因此升为 v8，会话键 v12、持久派生键 uv-composition-8/resident-2.2.2/persistent-3 拒绝含补洞的旧准备结果，历史资产不改写。首次新语义需重新计算一次。

后台准备在多视图生成期间暂停，避免每返回两张图就立即跑一次昂贵的中间 UV。最终 PNG 使用私有 RGBA buffer 转移所有权，去掉一份64MiB复制；CRC32 从每字节8次位循环改为同一多项式查表，不改压缩级别/PNG像素。

- 普通入口不再依赖 perfResidentQuality=1；旧 localStorage CPU 选择和普通 URL 的禁用参数不再把用户送回旧核。单层 public API 转发同一 GPU stack；可见自动合成、Merge、补缝底图及纹理/FBX 导出共用此入口。旧单层 CPU 函数保留 LegacyReference；仅 perfLab=1 显式诊断可调用。CPU/GPU 对照也要求此诊断入口，避免把两份新结果误当旧/新对照。
- 普通质量合成启用 resident Top-3，首轮保留完整 CPU 校验；失败抛错并保留原输入，不使用 CPU 结果替代。GPU 异常不再自动 CPU raster fallback；literal 批次失败也不再自动旧逐层重跑。旧代码仍可在诊断中访问。单层也覆盖真实 WebGL 校验。8K 或超过 255 层的普通质量合成尚未适配新常驻核，明确失败而不是降分辨率/旧算法回退；纯 GPU coverage overlay 不受此质量核限制。
- 裂缝阶段只对有一组相对拓扑邻点的未覆盖像素做射线搜索：原射线遇第一个 topology=0 就停止，所以其他点绝不可能成为有效修补。复用已有 component 分块队列，按原行顺序保存候选，各 pass 仍批量写入，alpha、donor tie-break、regionIds 与 RGB 限制不改。
- 普通可见纹理上传启用已验证 4ms 提交预算和任务让出，保留掉帧反馈、交互避让、取消、末尾实际呈现门禁。
- 完整无损 PNG 预热时提前上传一张有界 GPU 纹理，持有独占 pin。点击正式保存同一不可变 Blob 成功后移动缓存键到返回资产 URL，沿用同一个 Texture 和 GPU allocation；不建立 alias、不重解码/上传。不同 Blob、目标键已存在、多人持有、上下文丢失或未上传完整均拒绝接管并走正常新上传。取消/失败等上传 finally 再释放，已转交纹理不会被旧 URL 清理。持久化 Command/CAS/ownership 与已验证资产保存未改。

## 审计和验证

GPU/GLSL：质量核公式不改，单层首次纳入校验；转交纹理保留同一对象/GL 数据，不改 gamma、翻转、滤波。CPU/Worker：首轮 QA、稀疏舍入修正、overlay 和拓扑后处理仍存在，**不宣称全 GPU**。旧 CPU fallback 正常路径禁用；公共补洞对 GPU 和诊断 CPU 消费者同样生效。导出沿用共用入口及完整源 alpha/蒙版约束。

114 项套件已接入新增正常路由/校验拒绝/上下文恢复、单层派发、准备纹理独占所有权、精确 Blob 身份、取消/失败/目标已存在保护回归（最终总套件状态见后续实测）。600 gutter、500 repair、40 seam 冻结核对照通过。类型与 lint 无错误；15 个既存 warnings。真实 WebGL 23 层/单层两种 alpha 模式通过原门禁。

隔离 4K 裂缝场景（6 UV 区域）：1303.1→413.1ms，78,000 repaired texels，完整 RGBA/coverage/count 零差异。4K 上传原路径 2169.8ms，新调度87.1ms；同 PNG 预上传后 GPU 接管0.2ms，确认为同一 Texture，与重新解码上传的完整64MiB图像逐字节零差异。都是阶段数据，**不是完整 Merge 或首次合成时间**。用户当前 shelter 项目旧链实测20,879ms；新完整链仍需浏览器验收。

最终无补洞版本：114 项 Web 回归、类型检查、lint（0 errors/15既存warnings）、Cloud 构建与包体检查通过。PNG CRC 变更在随机1²、17×39、257×255、1024² RGBA输入的完整 PNG 文件与原实现逐字节相同。Cloud JS 最终3,192,466 bytes，仍在本功能3,194,000预算内，保留每个 chunk 限制与全部质量检查。不修改 CI/部署配置。

内置浏览器 index-D7W8pyi8 构建确认：用户新 shelter 13层/4096 的一次准备4262.7ms，gpuRasterAndReadback3124.9ms、quality311.2ms、coverageRepair0ms、seam51.3ms、gutter317.7ms、最后清理138.3ms；完整PNG准备约1395.8ms。用户确认比之前快，但仍要求继续改。此记录未包含首次GPU完整校准/页面加载时间，也不是最终点击到显示时间，不能宣称毫秒级达标。

## 迁移和回滚

不修改 Project/Layer Schema、历史资产或派生缓存格式；关闭补洞改变新输出语义，缓存版本按上文更新，旧含补洞结果不复用。GPU 纹理只会话预热，页面刷新从当前版本持久 RGBA 恢复后重建 GPU，不能把显存本身写到磁盘。回滚本卡路由、候选删减和GPU转交，并恢复旧 profile/版本；旧算法保留于源码。正常用户不用 debug 参数。release 保持不动。
