# CHG-20260912-UV-VISIBLE-UPLOAD-BATCHING

- 主模块：M07；协作：UI-06、M06、M09
- 算法：`PERF-UV-SOURCE-PREPARE-001` v1.9.0
- 用户结果：减少投影转 UV 的等待时间，同时保持拖动/点击优先和结果正确，不以降低分辨率、减少图层或跳过 QA 换速度。
- 修改：可见 WebGL renderer 继续使用 128K 精确上传条带，但健康帧内不再在每个条带后强制进入一个宏任务；累计同步 GL 提交达到 4ms、帧监测拥塞或存在呈现要求时仍等待浏览器绘制。detached renderer 继续逐条带让出宏任务。
- 交互与稳定性：上传前和每个 GL 提交前仍检查交互静默与取消；自适应帧预算和降档、GL capture/restore、定期 flush、异常清理及最终双帧发布屏障保持。专项回归锁定可见健康批处理不逐条带等待、detached 路径仍逐条带让步。
- 正确性：冻结提交 `b52561a` 与当前实现的 PNG、JPEG、重叠源、4K 和 13 图层 retain-raster 对照全部像素差为 0；不改变条带字节、Y 翻转、premultiply、颜色空间、coverage、rendered-color mask、层序、接缝或 gutter。
- 性能证据：真实浏览器 WebGL 4K/6 图层三轮配对、每轮各 2 次，共 6 次；冻结基线均值 1032.5ms，当前均值 998.1ms，约提升 3.3%。当前上传阶段六次均值约 361.2ms，初始同机基线两次均值约 400.9ms。512/13 图层 retain-raster 六次配对约提升 0.6%，视为基本持平。当前路径未记录 Long Task；最大帧间隔存在 33.4/50.1ms 样本，但未高于同轮冻结基线的噪声范围，因此不声明固定 FPS 收益。
- GPU/CPU/Worker/shader：只调整可见 GPU 上传的调度门槛；GPU 像素提交、CPU/Worker 数据、shader 与 fallback 公式不变。
- 持久化/导出：Project Command、Revision CAS、ownership、verified assets、Schema、缓存身份和导出不变。
- 迁移：无数据、Schema 或资产迁移。
- 回滚：恢复可见 renderer 每条带后的 `yieldToBrowserTask`；工程与对象资产无需改写。
