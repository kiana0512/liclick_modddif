# 返图轮廓检查与取景扫描延迟优化

主模块 M03，协作 M04/M08/M06/M07；GPT-CONTENT-BOUNDS/1.0.0（实现修订，framing v1/v2 协议不变）。

## 变化与对齐门禁

原取景和返图透明轮廓扫描在每个覆盖像素更新四个极值。外边界只依赖每行第一个/最后一个合格像素：逐行从两侧扫描，跳过已确定边界内的颜色和孔洞，再合并行边界。mask 仍以 R>0 且 alpha>0、normal 仍以 alpha>0、返图仍以 alpha>=128 为准。每 16 行（含空行）产生检查点，异步入口按约 4ms 计算预算让出；同步纯算法入口保留供已有调用和回归使用。

取景生成使用合作入口，返回图和配对参考加载增加 image.decoding=async 与 decode 等待，再让出一次浏览器任务，避免 drawImage 首次同步要求未完成的解码。可绘制图片若 decode 提示拒绝仍走原兼容路径；解码/让出后复查取消，不发布已取消画布。PNG toBlob、裁切和还原的实际 drawImage、clip、原像素、padding 与释放保持。

保留维护者要求的对齐门禁：完整 framing/source/crop/subject/output 坐标、整数变换、冻结相机、原法线/作者 mask/depth 和输出分辨率不变；不放宽远端比例和透明轮廓异常判断，也不自动重提付费任务。原 GPU/CPU/Worker/shader 投影、逐层 UV 权重、PBR、QA、持久化和导出保持，不接入实验生产内核。

## 验证

- 240 组 mask/normal 与旧完整逐像素判据一致，同步/合作生成完整 framing 相同；稀疏点、孔洞、边界 alpha、空行取消、异常尺寸和透明轮廓阻断、解码等待/拒绝兼容/期间取消通过。
- 原完整 framing 回归继续通过：57:49/3:1 历史兼容、方图 native output、精确逆 UV、请求/轮询/历史恢复、配对裁切所有 RGBA、作者 mask 不改、取消及 scratch canvas 清理。
- 内置浏览器旧/新真实模块：4K 密集几何轮廓扫描约 71.3–79.6ms → 5.4–8.0ms，全部 framing 字段相同。真实 HTML Canvas 配对色图/normal PNG 和 native 返图还原 SHA-256 零差异，输出 1561×1561 一致。1024×512 错比例和空透明轮廓两者都维持原明确错误，0 runtime error，无付费生图。
- Cloud/performance-lab 候选构建总 JS 3,172,795 字节、原总预算余量 83,705；framing lazy 6,832/7,000 字节，原门禁与 256 字节余量检查通过。正式 exact-SHA 和远端 CI 另行确认。

这些是扫描步骤和隔离像素对照数据，不代表真实模型全链路零掉帧；PNG 编码、首次 GPU 编译/UV 合成和回读仍可能占时。

## 迁移和回滚

无 Schema、数据库、资产、framing 版本或历史任务迁移；Project Command/CAS/ownership/verified assets 不改。回滚两处 engine 扫描/加载实现恢复原遍历和解码时机，保留原上传压缩修复、作者 mask、保存及返图异常门禁。4517 测试产物与正式构建分开，不修改或重新生成已有成功图片。
