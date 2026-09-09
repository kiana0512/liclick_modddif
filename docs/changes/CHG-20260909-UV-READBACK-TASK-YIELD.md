# 离屏 UV 读回移除嵌套定时器等待

- 主模块 M09，协作 M07；ALG-UV-008 v2.0.2，实现 Patch，RGBA 语义保持。
- 离屏 renderer 的 8 MiB 条带之间改用已有 yieldToBrowserTask（scheduler.yield / MessageChannel），继续交还浏览器任务调度，避免 setTimeout(0) 的嵌套最小延迟。可见 renderer 仍等待完整呈现边界；8 MiB 大小、顺序、异步 GPU fence/readback、最终 subarray 目的地和错误传播不改。
- 实际 Edge / WebGL 4K RGBA 渐变目标：交替顺序 3 轮前后对照，旧耗时 183.1 / 164.8 / 177.6ms，新 140.9 / 138.6 / 141.6ms；均值 175.2→140.4ms，约 19.9%。每次与完整 67,108,864 字节参考对照，6 次零差异。
- 这是独立读回阶段数据，不能当作 4K UV 合成总耗时或整机 FPS 提升；GPU 提交和其他阶段的长帧仍需工程实测。
- CPU 不改像素，GPU 读回指令不改；Worker/PNG/Shader/QA/4K/持久化/export 不变。无 Schema、资产、Command/CAS/ownership 或 verified-assets 迁移。
- 回滚该 await 到原 setTimeout 即可，不重算或删除任何工程资产。
