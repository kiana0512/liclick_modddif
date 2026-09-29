# 前端镜像跳过服务端 Blender 阶段

- 日期：2026-09-29；状态：本地配置回归通过，待远端镜像构建验证。
- 主模块 M15；契约 `CI-WEB-IMAGE-STAGES/1.0.0`。无业务算法、Schema、Project Command/Revision、ownership、资产、输出分辨率或 QA 语义变化。
- 证据：release pipeline #639841 的 `build:web` 日志在 `--target web` 下仍执行 Dockerfile 首段的 Blender 缓存层提取；`build:server` 同样提取该层。此层只由 server 镜像使用，前端处理它造成无效等待。
- 改动：保持 deps/build、web、Blender、server 四段内容及其构建参数不变，只将 web 目标移到 Blender 下载和 server 目标之前。Kaniko 的 web 目标到达后即停止；server 继续复制固定 SHA-256 校验的 Blender 并以运行用户执行原有 UV/GLB QA。两镜像仍从同一 build 阶段获取 Cloud 产物，CI 质量门禁、发布条件与健康检查不变。
- 验证：`scripts/test-cloud-deployment.mjs` 检查阶段拓扑、web 产物来源与 server Blender 依赖；完整 `verify:prepush` 在最终提交执行，并在远端 `container:verify` 中确认两目标真实构建。
- 迁移/回滚：无数据或资产迁移。还原 Dockerfile 阶段顺序即可回滚，但前端镜像会再次提取服务端 Blender 层。
