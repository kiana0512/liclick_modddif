# 连续图层显隐取消过期底图合成

- 主模块 M07，协作 M06/M08/M09；算法 UV-DISPLAY-BUFFER/1.4.2、UV-UNDERLAY-DECODE/1.0.1。
- 问题：显示 revision 已过期时，Resident UV 等待底图 Worker 合成完成才能排空旧队列；Worker 的旧网络请求也没有被实际取消。快速连续点击眼睛会等待已无用的底图工作。
- 修改：每次 Resident 底图合成持有 AbortController。新签名、context loss、取消或 dispose 中止旧 Worker 请求；保持串行不可变快照及最新状态接续。Worker cancel 同时中止该请求的 fetch，逐块 GPU/CPU 取消保护保持，finally 清除请求控制器。相同签名不取消，缓存命中仍立即绑定，不取消仅因鼠标移动更新的同一橡皮快照。
- 审计：没有改变任何混合、Top-K、GPU/CPU/Worker/shader 像素或 UV/gutter 数学；RGBA、透明色、法线、分辨率、QA 和正式导出保持。来源权限/HTTP、SHA、尺寸/MIME 校验及只读缓存保持。生成仍等待最新完整 UV 实际绑定；取消或错误不发布旧/半成品。Command 幂等、Revision CAS、ownership、verified assets 与持久化不变，无 Schema 或资产迁移。
- 专项验证：实际 Resident 调度覆盖过期底图信号、中间状态跳过、最新集合绑定、dispose 取消及原缓存/相机保护。真实 Worker 队列测试阻塞旧 fetch 并取消，下一任务不等旧响应即可完成全部像素。原权限失败、内容变动、source-over 写入隔离与 release 竞态保持。
- 浏览器验证：独立 localhost:6175 / Codex in-app Chromium / WebGPU / 4096² 完整合成，测试按钮触发旧调度与取消路径，结果绑定到真实 Three 材质。对旧请求人为注入 2 秒网络延迟，两轮旧调度发布 2485.0/2342.1ms，取消后 366.1/324.0ms；两路径全 RGBA 67,108,864 字节差异为 0，日志无 error/warn，截图保留完整 4K 合成展示。此为阻塞旧请求的控制实验，不代表用户工程首次新组合整体延迟。
- 限制：首次新显隐组合的完整回读、精确修正、gutter 和上传成本未消除；本轮不宣称所有组合实时。没有读取、写入或修改用户工程，也未启动付费生成。完整 Web 回归及最终正式产物检查完成后才能推送。
- 迁移/回滚：无数据迁移。回滚 Resident 信号透传与 Worker fetch 控制器即可恢复旧调度；保留所有工程/源资产，不恢复退役组件或投影材质展示。
