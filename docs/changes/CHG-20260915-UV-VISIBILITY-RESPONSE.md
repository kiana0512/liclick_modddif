# CHG-20260915 图层显隐响应与实际 UV 发布验收

## 范围与契约

- 主模块 M07，协作 UI-06/M06/M08/M09/M11/M13；负责人 Codex。
- production：`UV-DISPLAY-BUFFER` v1.4.1、`PERF-UV-SOURCE-PREPARE-001` v1.12.1。性能实验室探针：`UV-VISIBILITY-PRESENTATION-PROBE` v1.0.0。
- 输入仍为对象、可见投影源、UV 底层和完整项目分辨率，输出仍为原精确 RGBA/coverage/rendered-color mask，经上传和材质绑定发布。单位、颜色空间、矩阵空间、常量和阈值不变。
- 两项聚焦变更：测量（2 个源码文件）、取消与缓存调度（5 个源码文件），不改变工程数据协议。

## 实现

- S2 在原保护/FPS 窗口之后测顶层、中层各两轮关/开共 8 个状态，从 visibility 更新计时到绑定材质源 ID 集合完全匹配，且 base map 启用。
- 旧 ready dataset、旧 UV、缺失/重复源 ID、局部重绘 overlay 均不能通过探针；60 秒超时报错。测试 finally 在工程同步抑制期间恢复原图层和选择。
- Resident UV 旧请求结束直接接续最新状态，不等下一次 50ms 轮询；中间状态不计算，保留最新相机保护门禁。
- 原 180/240ms 静默等待增加兼容取消检查；RGBA/R8 与 GPU 源 staging 透传检查，旧请求不占住队列直到相机释放。取消仍排空条带、恢复 GL、释放来源，不发布半成品。
- 首次磁盘恢复仍校验实际几何/源字节、owner、尺寸与算法 key。几何/来源验证启动时点保留；仅可选压缩缓存写入延后到 acknowledgePresentation 实际绑定后的浏览器任务。候选 hash 延后没有明显提速，且不应改变几何校验时点，已撤回。取消、切换对象、context loss、dispose 清除未绑定待缓存闭包。

## 正确性审计

- GPU/CPU/Worker/shader：Top-K、设备质量校准、稀疏舍入修正、straight alpha、采样/Y 方向、完整分辨率、接缝/gutter 不变。橡皮 immutable draft/revision 和 interactive 路径不变。
- 生成：Resident UV 屏障与截图冻结不改，最新签名实际绑定才解除等待，新生图仍包含此前模型显示效果。
- 持久化/导出：只改可丢弃派生缓存时机；实际字节验证、账号隔离、对象、Command 幂等、Revision CAS、ownership、verified assets、正式 bake/保存/GLB/FBX/OBJ/纹理路径不变。AbortError 不降级 CPU 或提交旧资产。

## 验证与剩余项

- 专项覆盖绑定集合、永久 busy-camera 取消、old/intermediate/latest 接续、400 次连续请求、过期成功计算禁止发布、相机保护、缓存命中、onReady 未绑定禁止压缩、原来源校验与绑定后压缩、RGBA/R8 取消/失败/所有权/GL 恢复。
- 完整 Web 回归 125 项通过；typecheck/build 通过；lint 0 error、2 个既有 GeneratePanel warning。
- 改前 4517 / ANGLE RTX 4070 Ti SUPER / A60 / 4K：顶层首次关 667.3ms，中层首次关 1,033.6ms，热缓存 15.9–18.8ms。这是实际绑定延迟，不是 FPS。
- 加入独立 gutter 区间优化后，4517 同项目同设备：顶层冷 567.0ms，中层冷 949.3ms，热 13.8–21.8ms；gutter 107.6–110.4ms。此轮使用候选 hash 延后，最终保留原 hash 时点，最终构建仍需重复测量。一次配对不能宣称稳定收益比例。
- 最终保留原验证时点的构建：顶层冷 583.9ms，中层冷 999.3ms，热 16.6–17.5ms，gutter 110.4–112.3ms；全部 8 次源集合实际绑定匹配。此轮画布 1505×1028，与前轮 1600×900 不同，不能声称严格同视口收益。保护窗口最大 16.8ms，但发布窗口仍有 116.7ms 帧，冷路径与稳定性尚未达标。
- S7 800 次交互操作 P95/最大 16.8/16.8ms，状态/overlay 错误 0；该窗口暂停投影后台发布，不能代表冷 UV 延迟。S4 4K/14 层完整 UV 输出约 14.03MB，覆盖 59.75%，帧 P95/最大 16.8/66.8ms；拓扑校准最终差异 0，隔离质量对照差异 0。不宣称零卡顿。
- 冷路径仍有 readback/质量解析、接缝/gutter、上传开销，不宣称全部首次显隐已达到一帧或全系统暴力验收完成。包体按正式发布身份参数验证，预算不放宽。
- `verify:prepush` 对源码提交 `14185e3791c456b3f39c456747f3b3c754d9dc48` 通过：全仓 lint、正式 Cloud 构建、211 文件/25.06 MiB artifact、原包体门禁（98 JS chunks / 3,242,623 bytes，余量 4,877）和云部署模拟通过。无远端推送或部署。4517 已恢复本地构建，HTTP 200；本记录后续提交后实际推送仍须重新运行预检，不能用旧 SHA 检查替代。

## 迁移与回滚

- 无 Schema/Project/Layer/Command/Revision/资产迁移，key purpose 和缓存字节格式不变。可选缓存没写完可以重新计算，权威工程不丢失。
- 回滚只恢复 v1.4.0 的 optional 缓存发布调度、取消透传和请求接续；测量和 gutter 区间可以独立回滚。不恢复投影视口材质、不降分辨率、不关闭 QA、不修改/删除源素材。
