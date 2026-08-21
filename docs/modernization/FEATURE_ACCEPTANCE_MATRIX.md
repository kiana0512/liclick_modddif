# 功能验收矩阵

本文件是人工可读说明；机器权威状态位于 `quality/cloud-release-readiness.json`。规则只有一条：必需功能只有在真实输入、真实输出、失败恢复和部署环境均有证据时才能标记为 `passed`。页面能打开、按钮存在或 Mock 返回成功不等于功能通过。

| 能力 | 当前状态 | 已验证 | 仍需完成 |
| --- | --- | --- | --- |
| Cloud 零安装 | 通过 | `/li3d/` 子路径构建、无安装器/4618/localhost、浏览器加载无控制台错误 | 干净目标设备复验 |
| 登录与项目控制面 | 模拟通过 | 开发身份、HttpOnly 会话、创建、Revision、Command 幂等、服务重启恢复 | 真实莉刻 SSO 联调 |
| 大资产数据面 | 直传链路通过 | 协议与远端部署模拟已覆盖 SHA-256、HEAD 校验、首次 503 后重试、完成回放、ownership、签名下载；真实浏览器已直传源 OBJ 与 UV GLB 并恢复到 Bake | PostgreSQL 事务、回收、内容安全仍归安全数据面门禁 |
| 浏览器计算策略 | 通过 | WebGPU Worker、WASM Worker、禁止服务器 fallback 的运行时标记 | 设备丢失和低端设备矩阵 |
| Engine Session 基础 | 通过 | 项目级会话、GPU/CPU/IO lane、取消竞态、任务先于资源释放、贴图到 UV 会话复用 | 继续登记全部真实 GPU/Worker/缓存资源 |
| 项目首页 | 基础通过 | 登录、文件夹/项目页面、新建项目、进入编辑器 | 全部菜单、排序、删除、跨会话恢复 E2E |
| 贴图工作台 | 进行中 | 空项目路由、图层/视图/生成/局部重绘/撤销控件加载 | 真实模型投影、遮挡、像素结果、保存恢复、导出对照 |
| UV | 进行中 | 浏览器 xatlas WASM Worker 已生成、预览、下载并保存 UV GLB；源/结果直传后 Bake 高低模显示 2/2 | FBX/OBJ/GLB/GLTF 生产资产、接缝/密度/重叠、非流形、超大模型、取消与内存矩阵 |
| PBR 烘焙 | 未通过 | 页面加载 | 现实现仍展示远端 Substance/3090；须验证本地 AO/Normal/Curvature/ID 等及导出 |
| 拓扑 | 未测试 | 已识别入口和既有远端 smoke | 建立浏览器本地算法、真实模型对照、取消/恢复/内存预算 |
| 性能 | 未测试 | 已有基线和 bundle ratchet | input-to-present、帧耗、Long Task、静止渲染、Worker/纹理内存 E2E |
| 桌面兼容 | 未测试 | 旧适配器仍保留 | 运行并固化完整 legacy smoke matrix 后才可删除任何旧路径 |

执行 `pnpm check:cloud-release-readiness` 会在任一必需项不是 `passed` 时失败。这是有意设计的发布阻断，不是测试故障。
