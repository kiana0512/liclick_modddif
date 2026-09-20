# ModelView 多视图回贴完成屏障

- 主模块 M04；协作 M03/M06/M07。
- 算法 `MODELVIEW-PRESENTATION-BARRIER/1.0.0`；基线 `7ab72ebf`。
- 状态：本地修复，未推送、未部署，未操作用户正在执行的任务。

## 原因与修改

旧串行流程在添加图层前订阅一次 `liclick:projected-material-resident`，只核对对象，不核对新图层。SceneRoot 的 Resident UV 分支会复用材质并更新 texture 和 `liclickResidentUvProjectionLayers`，此时 `materialChanged` 不一定为真，因此不会再次发送事件。贴图已经显示，流程仍可永久等待；同对象的其他材质事件也可能错误地提前放行。

删除面板内事件等待算法。新流程先取得真实新图层 ID，再通过共用 engine 屏障检查指定对象所有可见 mesh 的实际显示材质：Resident UV 核对 atlas 的真实 layerIds；投影 shader 核对 resident identity 与 bindings。两次浏览器绘制调度后再次检查，期间变为未就绪则继续等待。检查间隔 50ms，仅在本次回贴等待期间遍历材质，不重新合成或读取像素。既覆盖“已完成才开始等待”，也覆盖异步原位更新；没有对象/mesh、隐藏对象、旧图层或 warmup 不作为成功。

保留每 60 秒延迟提示、取消检查、原串行视角顺序、成功后的持久化和批末补缝。GPT 通过兼容导出继续使用相同检查函数，行为不变。没有超时假成功、伪造完成事件或重复生成。

## 对应路径审计

- GPU / shader：复用 SceneRoot 已在真实材质安装或原位更新时写入的 UV layerIds，以及投影 shader bindings；不使用提前写入的 previewStatus.ready。
- CPU / Worker：不改变 bake、贡献缓存、上传、图像像素或分辨率；完成态由真实材质消费结果确认。
- 持久化 / export：仍只在严格确认后记录 projectedLayerId / projectionCommittedAt；Schema、Command 幂等、Revision CAS、ownership、verified assets、UV 合并与导出均不变。

## 验证与回滚

- 生产串行函数回归：三视角、顶底、已有贴图补全、完全覆盖跳过、取消、失败保留前序成功、相机恢复。
- 真实 Three 材质对象回归：同一个 UV 材质不发事件但更新 layerIds，等待仍完成；开始等待前已完成同样通过。
- 屏障回归：旧 atlas、缺失对象、空对象、隐藏对象、warmup、多 mesh 中未就绪、绘制期间就绪失效、等待中取消，以及 GPT 原有顺序与 QA 回归。
- 已通过 ModelView 串行、GPT 成组、Resident UV display / upload barrier / resolve scheduling 专项测试，以及前端 typecheck、改动文件 ESLint、生产构建和 diff 空白检查；构建仅有既有大 chunk 提示。
- 尚未在 A100 新版本中实跑用户本批任务，当前旧页面不会自动加载本地修复。
- 无历史数据迁移。回滚前端本变更即可，保留现有结果资产；回滚会恢复旧事件等待风险。
