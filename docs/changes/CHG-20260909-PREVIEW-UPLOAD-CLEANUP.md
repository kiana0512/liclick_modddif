# 预览纹理分条上传的取消与异常清理

- 主模块 M06，协作 M07/M13/M15；ALG-PROJ-007 v2.1.10，实现 Patch，采样、图像和 Shader 语义不变。
- 缺口：创建帧监测器后，取消/分配错误发生在原 try 外，遗留监测器并可能保持 source.dataReady=false；条纹提前裁切后，在等待呈现时取消或上传失败，会遗漏当前或下一条 ImageBitmap，提前失败的 crop 也可能产生未处理拒绝。
- 修复：分配及其等待进入既有异常清理范围；跟踪当前和在途条纹的所有权，finally 释放当前条纹，并为在途结果注册释放/拒绝处理。提前观察 crop 拒绝但不吞掉最终 await 错误；上传成功、失败和取消仍走原有 ready/invalidation 语义，源图由原所有者释放。
- 故障注入：旧版在零监测器断言失败（实际 1，预期 0）；新版 90 组成功、分配前取消、分配失败、首/次裁切失败、裁切后取消、上传失败、延迟裁切与尾部 drain 取消通过。验证每个位图恰好关闭一次、源图不关闭、GL 状态恢复、flipY 两种方向、无未处理拒绝、监测器与活动上传归零。
- 生产打包增加一次安全 Terser 压缩遍历（3→4），unsafe=false、drop_console=false、属性名不压缩不变。真实压缩回归保留 getter 副作用、Unicode、导出、诊断与数据契约；维持原包体门禁，不通过删除 QA/日志腾空间。
- GPU：只清理临时上传位图，原 texSubImage2D 参数及命令顺序保持；CPU/Worker：不改像素计算、裁切和 worker 生命周期，只接收并释放已请求的条纹；shader 不改；持久化/导出/4K/QA、Command 幂等性、Revision CAS、ownership 与 verified assets 不变。
- 无资产或 Schema 迁移。回退此上传函数与打包 passes 即可，可能恢复取消资源泄漏；保留新增回归作为期望约束。
