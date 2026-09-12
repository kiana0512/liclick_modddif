# 投影橡皮：完整密度的 UV 区域重算

## 范围

- 授权：用户“那你再优化一下吧”；本地修改验证完成后，用户追加批准“直接推送 master 和部署 A100”。发布阶段合并远端最新 master、通过正式 prepush 后同步代码和构建产物。
- UI-06/UI-10 → 主模块 M08，协作 M06/M07；ALG-ERASE-001 v1.4.0、UV-DISPLAY-BUFFER v1.2.0。
- 基线 14a27b2。实施 Codex，原用户复杂工程体验由维护者验收。
- 输入：当前普通投影层的完整分辨率 UV keep-mask、笔画脏区、冻结图层/模型快照。
- 输出：完整分辨率派生显示；只有当前层蒙版变化，不在最终整栈 Alpha 上挖洞。

## 实施与数学边界

1. 1K/2K 视口保存后处理之前的 straight RGBA、coverage、rendered-color mask 和有效 texel 计数。保留状态采用 copy-on-write，后处理、Worker 转移和失败请求不污染原始合成。签名变化、取消、上下文丢失和销毁均释放原始状态。
2. 草稿记录画布坐标（左上原点）的累计脏区；包括完整羽化及 mask 双线性采样边界，扩 2 texel 后选 512/1024 方形计算窗口。计算像素与原 1K/2K texel 一一对应，不缩小源图或改变 UV 密度。大范围笔画和 4K 保持原全图路径；恢复缓存没有 raw 数据时第一笔也走完整路径。
3. 原几何、原 framebuffer 尺寸、原 viewport、原 shader 全部保留，只用 scissor 限定片元范围，再通过 GPU copy 将相同 RGBA/quality 字节送到小目标。曾测试直接偏移 viewport，重叠 UV 出现 9 字节、最大 2 的差异，已废弃该候选，不提高容差。
4. 小目标运行现有 Top-3 排序、校准门禁、CPU 双精度舍入修正、Worker 转换和原 overlay 混合。区域结果贴回原始全图后，完整重跑接缝、coverage 修补策略、gutter 和 Alpha 处理；不会漏掉 UV 岛另一侧的接缝依赖，不自动新增补洞。
5. 区域和全图栅格键分离、几何 scope 相同，共用原 256 MiB GPU 栅格/聚合缓存预算。同签名静态全图栅格可以直接 GPU 裁取复用；候选尺寸变化销毁旧整数目标，清空其前缀身份，普通全图键格式不变。
6. 局部重绘 literal suffix 的交互上传同样显式透传 allowWhileInteracting，正式/后台任务默认行为不变。
7. 显示端保存上一帧 CPU 像素镜像，扫描实际 RGBA 差异范围（包含接缝/gutter 引起的远处变化）。GPU 将旧完整贴图复制到新目标，只上传变化区域，然后原子切换；不直接修改前台贴图。无变化时只复制，尺寸不一致走原路径。上传失败、取消及纹理销毁均释放临时目标。

## 资源与一致性审计

- GPU：全尺寸 scratch + scissor、小尺寸整数候选与拷贝。所有临时目标在 finally 释放，copy 前后恢复 framebuffer/viewport/scissor/像素比例/XR 等既有 renderer 状态。静态缓存淘汰后只重算，不绕过预算。
- CPU：新增 raw 原始状态和显示镜像，2K 普通层约 36 MiB、带 rendered-color mask 最多约 40 MiB；patch/copy-on-write 还会有临时副本，不宣称内存零增加。4K 不保留这些状态。正式缓存及全图 Worker 上传会转移输入 ArrayBuffer，镜像必须独立复制；局部上传仅转移截取区域。
- Worker：仍调用原转换/quality blend，region 只改变处理矩阵大小，不改通道、Y 翻转、RGBA、alpha 或舍入规则。
- shader：公式未改。源图、蒙版、捕获相机、深度、法线和对象矩阵仍使用原全图坐标。将部分 shader 模板内的说明注释移到 TypeScript 注释，保留原空行和计算语句，避免说明文字进入发布包；不提高包体积门槛、不移除校准或诊断。
- 正式 merge/export：未启用 renderer-only incremental 输入时保持原路径；增量入口拒绝项目提交/源层 baked 标记，原图层、mask、持久化资产和 undo/redo 仍是唯一权威。
- 无 Layer/Project/Command/Revision/ownership/verified asset Schema 变化，不需要数据迁移。

## 验证

- 小区域补边、边界、无效输入、coverage 计数、rendered-color mask 清零/扩展与 copy-on-write 新增单元回归。
- 真实 Edge/WebGL 完整图像对照：普通半透明叠层、literal 局部重绘叠层、重叠 UV、Box 接缝，各自左上/中部/右下 3 个窗口；完整 RGBA 和 rendered-color mask 字节一致，coverage 计数一致。包括同一缓存中全图→区域→全图、不同尺寸候选重建和原始状态连续 patch。
- 实际 ViewportCanvas 连续 60 次移动，保持鼠标按下检查多次呈现、下层露出、松手像素一致、撤销/重做、切层。
- 性能使用同一夹具串行 A/B；测试专用 LICLICK_ERASER_FULL_BAKE=1 禁用 raw/region，不进入产品。
- Web 回归 124 项通过；TypeScript/build 通过；ESLint 0 错误、2 个既有 EditorPage 警告。普通构建包体积 3,221,930 / 3,222,000 字节；未运行要求提交状态的正式 prepush，也未推送或部署。
- 显示局部上传另外比较 3×2 非对称 RGBA（含 0/1/127/254/255 Alpha）、无变化复制、取消和资源释放，像素与全图上传一致。
- 串行 A/B（2K、14 层合成夹具）：全图中位数约 200 ms，区域版本仍约 199 ms；不能声称整体已经显著提速。独立区域 bake 对照中普通叠层约 128–144 ms 对全图 257–295 ms，literal 叠层约 140–160 ms 对全图 759–859 ms。加入局部上传后整体中位数仍约 199 ms。不同测试范围不能混用，合成夹具不等同用户复杂工程，也不代表所有笔画固定提速。

## 未完成与回滚

这不是完整 GPU 常驻实时显示：源蒙版和 rendered-color R8（如存在）仍可能整张上传，接缝/gutter 等后处理及显示差异扫描仍全图运行；结果没有可复用前帧或 4K 时仍完整上传。长笔画扩大计算窗口，首次准备、缓存未命中及复杂几何仍可能迟滞，不能宣称已达到 Modddif 跟手程度。

回滚本变更的 region/raw 调用、cache 尺寸适配、显示局部上传和脏区记录即可回到 14a27b2 完整重算；保留已有图层、蒙版和所有用户资产。未对线上服务或用户工程进行写入。
