# CHG-20260826-PERFORMANCE-LAB-CLOUD-RECORDING

> 状态：Verified on A100 with real Feishu identity and completed persisted session
> 等级：Minor（M13 诊断与持久化能力）
> 日期：2026-08-26
> 主模块：M13 身份、任务与平台
> 算法：`ALG-PERF-SESSION-001` v1.0.1
> Schema：`PERF-LAB-REPORT` v2；collector `2.0.0`

## 1. 目标与边界

用户在 A100 部署的零安装 WebUI 中以飞书登录，且发布同时显式开启前后端 Performance Lab 环境开关时，追加 `perfLab=1` 后可复用现有人工录制按钮，多次记录其本人电脑浏览器的真实性能。本地默认关闭且不生成统计。维护人员按可信飞书姓名和头像读取记录，用于复现卡顿、定位主线程/帧循环/网络/浏览器 GPU 路径问题。

A100 只保存日志，不是被测 GPU。不得恢复 Windows 本地组件、localhost/4618、ETW 代理或本地凭证。浏览器安全沙箱不提供的 D3D 硬件队列、系统级 CPU/GPU、VRAM、温度和功耗明确标为不可观测，不生成估算值冒充实测。

## 2. 调用与数据流

```text
?perfLab=1
 → lazy PerformanceLabCloudBridge
 → 既有人工录制 dataset start/end
 → PerformanceLabCollector（用户浏览器主线程）
 → 5 秒 PERF-LAB-REPORT v2 chunks
 → Upload Worker：JSON + SHA-256 + IndexedDB + 有序重试
 → 同源 Cookie API
 → PostgreSQL performance_lab_sessions/chunks
 → ownership / maintainer role 查询
→ 按飞书 userId + 姓名 + 头像分组查看与导出 JSON
```

A100 正式构建使用 `/li3d` base path；本地构建保持 `/`。Cloud 桥除监听既有人工录制状态外，提供显式“开始服务器录制/结束并保存”控制，避免 UI 组件装载时序丢失。HTTP 内网部署不保证 secure-context API：session id 在 `crypto.randomUUID` 缺失时生成 RFC 4122 v4 UUID，Worker 完整性签名在 `crypto.subtle` 缺失时复用审计过的纯 JS SHA-256 回退。

## 3. 真实指标与隐私

- rAF 全帧时间、FPS、P50/P95/P99、最大帧和固定 60Hz 预算掉帧；Long Task、Long Animation Frame 的脚本/渲染/布局拆分；Event Timing 输入延迟、处理与呈现延迟。
- pointer/wheel 节拍、布局偏移、页面可见性、运行时错误、资源 timing、JS heap、业务阶段 dataset 和导航网络分解。
- 活跃 WebGL2 上下文的 renderer/vendor、ANGLE backend（可辨识时为 D3D11/D3D12/Vulkan/Metal/OpenGL）、限制、扩展和 GPU timer capability；它不等于操作系统级 GPU 利用率。
- URL 删除 query/hash，跨域资源只保留 origin 与泛化类型，同源路径泛化 UUID/业务 ID；不采集 Cookie、提示词、键盘文本、模型或纹理像素。
- 每 60 帧抽样采集器自身耗时并汇总 P95/最大值，避免把探针开销误判为产品卡顿。

## 4. 身份、幂等与查询

写入身份只接受服务端 Session。session start 保存录制时 displayName/avatar/email 快照；普通用户只能访问本人会话。跨用户分析使用同源 `/li3d/performance-lab-admin` HTML 和独立 `/api/performance-lab/admin/sessions` list/detail API，服务端再次校验 `maintainer/admin/owner/superadmin`，其他账号固定返回 403。`LICLICK_PERFORMANCE_LAB_MAINTAINER_EMAILS` 配置可信邮箱 allowlist；当前 A100 发布只允许负责人明确给出的两个飞书邮箱，不把邮箱硬编码到浏览器包。

start 对 immutable input 幂等；chunk 以 `(session_id, source='browser', sequence)` 幂等并校验 payload SHA-256；complete 以最终报告 SHA-256 幂等。跨用户 sessionId、项目 ownership、重复 sequence 异内容和结束后追加分片全部拒绝。

## 5. 迁移与回滚

部署先执行 `003_performance_lab_sessions.sql`。迁移只新增两张表及索引，无旧数据回填，不更改 Project/Layer/Revision/Object Storage。回滚停止桥接和 API 即可，表保留审计数据；页面 IndexedDB 队列可在同版本恢复后继续上传。禁止删除项目或恢复本地采集组件。

v1.0.1 只改变浏览器 HTTP 兼容与 `/li3d` 路由构建，不改 schema。回滚可原子恢复上一份 Web dist；不得回滚数据库或清理旧项目。修复前已经 start 但未 complete 的会话保留为中断诊断记录，不伪造 completed。

## 6. 验证

- Web/server typecheck。
- Web Cloud recording 契约测试：条件加载、重复会话、真实 browser metrics、Worker IndexedDB/SHA/retry、飞书分组、独立管理员 HTML/API、排除 A100 GPU。
- Server persistence 测试：真实临时 HTTP 服务 + PostgreSQL 兼容引擎完整 start/chunk/complete/list/detail，覆盖管理员/普通用户 200/403 边界、ownership、身份快照、幂等和冲突。
- 真实账号 Cloud 模拟：使用真实飞书登录、实际 PostgreSQL 迁移和同源服务，连续完成两次独立录制；服务端按可信飞书身份聚合，并从维护端读回 completed 状态、原始分片/SHA、帧/输入/资源样本、WebGL2、ANGLE D3D11、客户端 GPU renderer 与 CPU 线程数。浏览器控制台无 error/warning。
- 共享控制面 100 账号/多副本回归必须继续通过。
- 发布包继续保持各路由独立预算；新增录制器、可靠上传 Worker 与管理员分析页后，总 JavaScript 实测约 3.066 MB，总量门禁从 3.050 MB 有证据调整为 3.080 MB。生成的 67-byte `index-*` lazy facade 不作为应用 shell 重复计数，但仍计入总量。
- A100 已由负责人明确批准并完成部署。真实飞书账号 `kianaren@lilith.com` 在 `/li3d/.../texture?perfLab=1` 完成录制，PostgreSQL 读回 completed session、1 个浏览器分片、85 个样本、19,854 字节与最终 SHA-256；管理员页 `/li3d/performance-lab-admin` 可按该身份读取。修复前 3 条未完成会话保留为真实失败证据。
