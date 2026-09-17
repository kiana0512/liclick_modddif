# 单/多视图 GPT / ModelView 切换

主模块 M04/UI-05；算法/交互标识 `TEXTURE-PROVIDER-SWITCH/1.0.0`；基线 `112e1bdc`。

用户要求保留两套生成选项，不是移除 GPT。此次只恢复入口切换：

- 多视图、单视图页签下均显示 GPT / ModelView，默认 GPT，页签间共享当前会话选择。
- GPT 恢复原参数、提示词、单视图与成组多视图生成路径；ModelView 保持新纯白两/三图输入和全角度串行回贴。
- 生成、提交锁定时两按钮 disabled，处理函数也检查锁；不能中途切换影响活动批次。
- 不修改独立局部重绘 GPT / 原重绘开关，不删除历史结果或草稿。刷新回到默认 GPT，不添加新的项目持久化字段。
- GPU/CPU/Worker/shader、蒙版外扩、投影/UV/export、分辨率、QA、Command/CAS/ownership/verified assets 不变，无迁移。
- 回滚仅撤销选项入口并恢复固定 ModelView，不影响已生成结果。

测试执行实际路由的 GPT/ModelView × 单/多视图矩阵；切换函数的配置锁/提交锁真假矩阵、来回切换和现有 ModelView 串行 resident/取消/失败检查。

已通过上述切换/串行回归、GPT 成组生成回归、单视图补全像素回归、Web 类型检查与 lint（仅两条既有 unused warning）、生产构建和 256B bundle 余量检查。Editor 496685/499024 B，总 JS 3229559/3256500 B。尚未推送或部署，未调用真实生图。
