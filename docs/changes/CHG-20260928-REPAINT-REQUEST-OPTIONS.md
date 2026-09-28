# 局部重绘隐藏选项与跳过润色

- UI-05 → M04/M08；REPAINT-REQUEST-OPTIONS v1.0.0；状态：本地实现，未部署。
- 按用户要求隐藏法线背景和局部重绘智能润色开关。黑底继续为默认；任务入口固定润色 false，旧设置 true 不恢复润色流程。
- 输入：现有 capture / reference / mask；输出：ModelView promptPolishEnabled=false，不发送 prompt，使用远端内置提示词。保留历史字段与不可达润色实现以便回退，不读旧缓存。GPT 路径、普通生成手动润色不变。
- 无图像算法变化。GPU/CPU/Worker/shader：不适用，本次仅改变 UI/request options，不改捕获背景实现或像素公式；持久化保留旧设置/结果不迁移；export 消费既有结果，未改格式或合成。
- 回退：恢复两个开关及旧设置读取。既有资产不删除。
- 测试：normal-input 默认黑底与转发；generation-input 旧设置 true/false/缺省均关闭，默认分支禁止缓存、准备和 Qwen 调用；Web typecheck/lint。
