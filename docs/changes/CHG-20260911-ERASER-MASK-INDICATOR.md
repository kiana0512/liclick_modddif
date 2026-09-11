# 橡皮擦蒙版图标与自动覆盖蒙版区分

## 范围和原因

- 主模块 M05 / UI-09，协作 M08。显示契约 `LAYER-ERASER-MASK-INDICATOR` v1.0.0；擦除像素算法及 ERASER_ALGORITHM_VERSION=1 不变。
- LayerRow 原先只判断 maskUrl。单/多视图自动投影会在该字段写入模型轮廓，因此未使用橡皮也出现图标。
- 复用 hasClearableProjectedEraserMask：普通 projected、非局部重绘、存在 UV keep-mask 且带橡皮版本才显示，提示改为“橡皮擦蒙版”。不扫描整张图片，不新增 GPU/CPU 读回。
- 笔画提交前保留原橡皮版本，undo/redo 与像素一起恢复；后台高分辨率精修保留当前版本，不把已全部撤销的状态重新标为已擦除。清除入口继续取消在途任务并删除 maskUrl/maskSpace/版本。

## 跨路径审计

- GPU/shader、CPU/Worker 的蒙版内容、轮廓/深度/遮挡和擦除计算不变；生成 capture-mask 仍完整保留并参与投影。
- UV 合并/PNG/FBX 继续使用原像素和蒙版。layerStackCache 已含版本与 contentRevision，历史版本变化不会误用旧派生结果。
- 沿用 Layer 可选字段和原历史/保存入口，无 Project Schema、Command 幂等、Revision CAS、ownership 或 verified assets 变更。
- 普通 UV 擦除编辑自身 alpha，并非独立蒙版，仍不显示此图标。局部重绘作者 coverage 也不显示为橡皮蒙版。
- 不迁移或改写存量资产。旧版本已经全撤销却残留橡皮版本的历史工程无法只凭元数据反推像素是否全白，仍可通过现有“清理橡皮蒙版”清除；不自动读取/重写用户资产。

## 验证

- test-layer-context-menu-policy 执行真实 LayerRow 和生产 policy：无蒙版、生成轮廓、带旧版本的轮廓、中性准备蒙版、局部重绘、UV 层均无图标；真实橡皮蒙版及其序列化重开状态有图标。
- 测试从生产 AST 提取历史和后台精修的实际 store patch，验证撤销第二笔保留第一笔、全部撤销后精修不重现、重做恢复、清理隐藏。
- 原 paint-history-transactions 的真实撤销回调夹具补齐新增闭包状态，保留像素、live multiplier、取消和精修断言，并增加版本与像素共同恢复断言。
- 完整 Web 回归 118 项通过；Web 类型检查、Cloud/项目持久化边界和 diff 检查通过。目标文件 lint 为 0 错误、10 条既有警告，测试文件 lint 无警告。未对用户线上工程进行操作。

## 回滚

恢复 LayerRow 原显示条件与笔画版本恢复补丁即可；不删除资产、不清除实际蒙版。仅本地修改，尚未提交、推送或部署。

## 发布准备

用户随后授权同步 master 与 A100。集成远端 e784659，保留常驻 UV 显示/缓存及推送前 lint 检查，仅主文档合并版本更新为 2.20.18，无业务冲突。对最终提交重新运行回归与 verify:prepush；发布结果以仓库外发布记录及线上版本检查为准。
