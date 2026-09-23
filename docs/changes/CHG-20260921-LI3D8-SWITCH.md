# 个人接口切换 li3d-8 与耗时复测

用户明确要求改用截图中的 `li3d-8`。主模块 M08，协作 M15；远端工作流版本 `autodl-li3d-8-768-2step-20260921-v1`。已切换正在运行的个人 6008 接口，不修改 ComfyUI 主进程、原工作流文件或工程图层。

源文件 `/root/ComfyUI/user/default/workflows/li3d-8.json`，35 个节点。输入重新映射为效果图 4、参考图 5、蒙版 44、法线 81；输出仍为 29，噪声种子仍为 14。保留原工作流所有输出，包括中间预览与 SaveImage。

以实际连接和参数为准：PrimitiveInt 89 控制 768 推理尺寸，法线同步缩放；True-V3 Q5_K，simple / Euler / 2 步；单 LoRA `li3d_normal_20260915/六视图参考_法线辅助_000002000.safetensors`，实际强度 0.8。节点标题与备注里的 0.60 不是生效值。图像恢复原尺寸后按原蒙版合成，替代旧 CherryAlignReference 路径。输入和最终输出仍为 2048×2048，但推理分辨率、LoRA、提示词和合成方式已改变，速度对比不代表同质量条件下的纯性能优化。

兼容修正：源文件节点 9 Li3DPromptCacheEncode 的序列化列表为 `[clip_name, "default", true, "Ready", "Ready"]`，未包含新增 tail_prompt 对应位置，named 字段也错位。转换时仅对该旧格式恢复 tail_prompt 空字符串、device default、disk_cache true，忽略 UI 状态文字。原始固定提示词保持。

使用上一轮同组四图、相同随机种子序列，实例内部 WebSocket 节点区间墙钟计时；不包含前端网络、上传和轮询。首轮不主动清缓存，不等于机器冷启动。

| 条件 | 旧工作流 | li3d-8 |
| --- | ---: | ---: |
| 首轮 | 13.324s | 7.572s |
| 同输入仅换种子 | 7.190s | 2.341s |
| 再次新文件名、重新读取四图 | 8.101s | 2.728s |

新文件名一轮节点拆分：四图读取 237.182ms，效果图 VAE 62.509ms，材质 VAE 48.454ms，法线 VAE 67.452ms，两步采样 1674.409ms，VAE 解码 88.483ms，中间预览 PNG 37.376ms，恢复尺寸 100.135ms，蒙版合成 22.615ms，最终预览 PNG 141.927ms，SaveImage 191.254ms，其余为预处理及调度。提示词/模型节点命中缓存。完整节点区间和 prompt ID 见 [原始数据](CHG-20260921-LI3D8-NODE-TIMING.json)。

个人服务完整接口验收：health 返回新版本；任务 `088556c1c6d9434ac6c2f4d3b6527870f41dbc7a574dd38584643f738112eb5c` 成功，ComfyUI 执行 2711ms，worker 3332.773ms，PNG 解码验证 2048×2048。[服务计时](CHG-20260921-LI3D8-SERVICE-VERIFICATION.json)。本地服务 9 项回归通过，转换程序验证所需节点、模型和枚举值。无需修改/重建前端；后续个人生成会返回新工作流版本。

持久化、Cloud verified assets / Command / CAS、GPU/CPU/Worker/shader/UV/导出算法不变；旧生成记录保留旧版本。无 Project Schema 迁移。远端切换前备份 workflow.json、workflow-source.sha256、service.py、prepare_workflow.py 为各自 `.before-li3d-8` 文件；回滚需空闲时恢复整组文件并重启个人服务，不能只恢复工作流而保留新输入 ID。
