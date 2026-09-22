# li3d-8-2 云端工作流切换与复测

主模块 M08，诊断 M15；个人接口工作流版本 `autodl-li3d-8-2-768-2step-20260921-v1`。用户指定源文件 `/root/ComfyUI/user/default/workflows/li3d-8-2.json`，35 节点。仅切换 AutoDL 个人 6008 接口；网页保持 `personalRepaintEnabled = false`，继续走 LI3D 后端。此次测量不代表 LI3D 后端上游已切换，也不包含浏览器请求准备、公网上传、下载及回贴。

与 li3d-8 对比，唯一源节点差异为节点 9 的 widgets_values 被保存为 `[clip_name, "Ready", "Ready", "Ready", "Ready"]`，named 字段同样异常。device=Ready 不符合运行节点枚举。转换器仅对该精确异常格式恢复节点默认值：tail_prompt 空、device default、disk_cache true；不修改原工作流。修正后 API prompt 与上一版逐项比较完全相同。保留 True-V3 Q5_K、768 推理、2 步 Euler、LoRA 0.8、所有预览和保存节点，最终输出恢复输入尺寸。

同组四图、同种子序列；每轮前确认 ComfyUI 队列为空。通过实例内部 WebSocket 测量执行事件之间的墙钟时间。首次不主动清缓存，不代表机器冷启动；节点区间包含调度和模型准备，不能视作纯 CUDA 内核时间。

| 条件 | li3d-8 上次 | li3d-8-2 本次 |
| --- | ---: | ---: |
| 首次观测 | 7.572s | 10.839s |
| 同输入仅换种子 | 2.341s | 2.333s |
| 新文件名重新读取四图 | 2.728s | 2.783s |

新文件名一轮细分：四图读取 248.362ms；效果图 VAE 64.240ms；材质 VAE 47.806ms；法线 VAE 68.050ms；两步采样 1699.008ms；VAE 解码 88.589ms；中间 PNG 38.075ms；恢复尺寸 118.491ms；蒙版合成 20.733ms；最终预览 PNG 137.212ms；SaveImage 199.551ms；其余预处理和调度约 53.069ms。首轮提示词节点 2772.836ms、采样节点 6155.349ms、参考图 VAE 857.408ms，说明缓存/驻留状态影响明显，不能把首轮差异归因于工作流改动。

实例内部个人 API 验收：鉴权 health 返回新版本；任务成功，PNG 解码后 2048×2048。请求体读取 12.745ms、校验及保存 154.060ms；服务排队 1.924ms；上传给 ComfyUI 23.510ms；提交及排队 37.012ms；工作流执行 2798ms；轮询发现完成 514.359ms；读取结果 2.496ms；结果校验及保存 41.734ms。worker 总计 3417.586ms（包含其内部阶段，勿重复相加）。这是实例内部调用，不是公网端到端测量。

原始数据：[节点计时](CHG-20260921-LI3D82-NODE-TIMING.json)、[接口验收](CHG-20260921-LI3D82-SERVICE-VERIFICATION.json)。本地个人服务 9 项回归通过。没有推送或新增提交。

GPU/CPU/Worker/shader/UV/持久化/export 逻辑不变，无 Schema 迁移，旧结果保持原版本。远端四文件 workflow.json、workflow-source.sha256、service.py、prepare_workflow.py 均有 `.before-li3d-8-2` 备份；回滚时确认个人任务及 ComfyUI 队列空闲，恢复整组并重启个人服务。原 ComfyUI 进程与源工作流未改动。
