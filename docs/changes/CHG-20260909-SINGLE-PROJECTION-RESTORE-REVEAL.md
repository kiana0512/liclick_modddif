# 单层投影工程刷新后显示门禁

主模块 M06/M03，协作 M08；维护版本 2.19.14，PROJECTED-MATERIAL-IDENTITY v1.0.0。

## 证据

用户 A100 工程（新项目7，合并 UV + 局部重绘）刷新后持续旋转。通过浏览器只读 DOM diagnostics 确认：full 模型已恢复、UV 为 2048×2048、projected ready=1、processed layer 数=1、无编译错误；atomicModelRevealStatus 仍为 waiting。独立诊断页同样复现。

实际材质名称是 LiclickProjectedLayer:local-repaint-projection-…，而 SceneRoot 的完成显示条件仅认可 LiclickProjectedLayerStack:。单层工厂本来就使用专用单层 shader；旧普通选择触发额外回贴预热可能间接掩盖此门禁遗漏，不应恢复这种防闪烁修复已移除的副作用。

## 修改与边界

纯身份 helper 同时识别单层和多层常驻投影材质，不识别 Warmup 或无分隔符的伪名称。统一用于五处：常驻 fast path、UV bootstrap 防重复、保留供复用、提交结构 key、最终颜色显示检查。保持原有异步编译、取消、逐 Group 显示和真正呈现帧门禁，不用超时强行显示白模。

GPU 只改变生命周期资格判断；不改 shader、蒙版/source alpha、颜色、深度、2px 内缩、UV 合成、CPU/Worker/export、分辨率。项目保存、Command 幂等、Revision CAS、ownership 和 verified assets 不变，无 Schema/旧资产迁移。撤销、图层显隐、橡皮与前一版选择防闪烁保持。

## 验证与回滚

新增 test:projected-material-reveal 执行生产最终门禁和 fast path，真实 Three 材质包含单层/多层/材质数组、同/异结构、精确 bootstrap 和占位拒绝。旧代码在单层“应退出旋转”断言失败，修改后通过。实际 A100 页面验证了故障根因；修复后真实刷新待部署验收，不把受控测试当成已经上线。

本地验证：104 项完整 Web 回归、typecheck、Cloud Web 构建、cloud-artifact、包体门禁均通过；非发布参数 82 chunks / 3,150,085 bytes。变更文件 lint 0 错误、1 条既有 warning。未提交/推送/部署；临时浏览器诊断页已关闭，原用户页面与工程未修改。

回滚恢复五处 Stack-only 判断并移除 helper 即可；无数据迁移或资产删除。会重新引入单层恢复显示不出的风险。
