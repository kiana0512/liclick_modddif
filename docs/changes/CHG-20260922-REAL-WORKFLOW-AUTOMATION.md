# 真实模型到多视图贴图自动验收

- 主模块：M15；调用 M02/M03/M04/M01。变更等级 Patch（外部验收工具）。
- 无算法变更。Project/Layer/Capture/Generation Schema、Revision CAS、ownership、生成 QA、分辨率均不修改。
- 输入：`temp/li3dTests/Bicycle/Bicycle.glb` 和同名 PNG。PNG 已是六视图材质拼图；不是待生成的单视图图片。
- 输出：独立测试工程、保存后的减面模型、九视角投影图层、`report.json`、`automation-timings.json` 与阶段截图。2026-09-28 起 `--trace` 读取 DEBUG 应用的本地函数计时，刷新默认 off；不再导出 Perfetto 格式或安装浏览器性能 Observer。

## 执行契约

`scripts/li3d-workflow.mjs` 通过现有界面执行：新建工程 → 导入模型 → 同意减面 → 验证保存资产面数 → 导入并选中多视图参考 → 默认预设 1 的九视角生成 → 回贴/保存 → 刷新并验证。

这是付费真实生成测试，不 Mock 任务，不降低当前 2K 分辨率、质量或 QA。减面输入须超过当前 150 万面门槛；输出从持久化 GLB 的当前场景统计，须大于 0 且不超过 202,000 面。未知 UV 修复确认会报错并留在页面，不能自动接受。输入文件不覆盖。

完成判断要求九个不同 `cameraViewId` 均有成功 Generation，且 `projectedLayerId` 对应同 Generation、同对象的真实图层；还需界面呈现完成、刷新后仍存在、图层图片可下载并解码。按视角统计最终有效结果，成功重试可以替代同视角的失败尝试；保留尝试总数。生产流程可能在 QA 拒绝后继续后续组，验收器等待界面解除运行锁后再总结。未达九视角不得标记 passed，但仍验证已保存部分结果可重开。画面艺术质量仍需人工审阅；本工具不是像素金图或 30 分钟稳定性测试。

## Codex 内置浏览器（本次运行方式）

在 `cua_repl` 中选择内置浏览器，读取其上传/开发接口文档，然后：

```js
var workflow = await import('file:///D:/li3d/scripts/li3d-workflow-iab.mjs');
var steps = await workflow.createInAppWorkflow(tab, {
  url: 'http://127.0.0.1:4517/',
  case: 'D:/li3d/temp/li3dTests/Bicycle',
  out: 'D:/li3d/.codex-tmp/li3d-workflow-run-unique',
});
nodeRepl.write(await steps.next());
```

每次 `next()` 执行到下一个需要等待的条件，返回 `waiting`；后续工具调用继续 `await steps.next()`，直到 `done: true`。不要把整个 Promise 留在一次工具调用结束后的后台，否则内置浏览器的执行上下文会失效。文件使用其原生 filechooser，导航/截图使用原生接口，不依赖 Chrome/Kimi 扩展或本地文件权限设置。

明确接续测试工程时增加 `projectUrl`；仅允许名称以 `LI3D-E2E-` 或本次排障工程 `Bicycle-cli-e2e-` 开头。已有模型、参考图和生成不重复提交；若批次中断或失败，只观察并报错，不推测缺失视角、不自动重跑付费整批任务。更换 `out` 保留上次失败证据。重新生成应显式启动新测试工程。

## 独立 CLI

```powershell
node scripts/li3d-workflow.mjs --help
node scripts/li3d-workflow.mjs --cdp <已有授权页面的WebSocket调试URL> --url http://127.0.0.1:4517/ --case temp/li3dTests/Bicycle --out .codex-tmp/li3d-workflow-run-unique
node scripts/test-li3d-workflow.mjs
```

对应 package 命令为 `pnpm workflow:run --help` 和 `pnpm test:workflow`。

CLI 使用 Node 原生 WebSocket 连接调用者提供的现有页面，不启动 Chrome，也不复制 Cookie/token。Codex 内置浏览器的工具能力不等于公开的 WebSocket 地址：没有该地址时使用上面的内置浏览器适配器，不能声称独立 shell 已能直接接管内置浏览器。独立 CDP 传输与内置浏览器共享同一流程。

## Trace 范围

- 当前 `automation-timings.json` 为普通 JSON，只记录驱动 command/poll/idle/阶段与已有 Generation 元数据观察；不充当函数实际耗时。应用计时独立导出为 application-trace-before-reload.json，停止后再刷新。下方 2026-09-22 实跑证据中的旧 trace.json 仅为历史格式。
- 同一浏览器时钟转换到 epoch 微秒；阶段是 wall time，包含轮询及分步调用间隔，不能当作算法纯执行耗时。
- 不采集 Cookie、API Key、请求正文、提示词或服务端 GPU。资源仅保存 pathname，删除 query/hash；报告和截图是本地测试产物，不提交版本库。
- 不提供跨服务父子 Span，不把浏览器等待推断为服务器 GPU 耗时。录制只注入临时 PerformanceObserver，结束清理，不写业务 Store 或持久化协议。

## 对应实现与回退

GPU/CPU/Worker/shader：不适用，没有修改生产图像算法，仅通过原入口调用。持久化：使用现有浏览器保存与同源只读查询，未改变 Command/CAS/ownership。导出：未修改生产导出；验收读取的是既有持久化模型及图层图片。

无数据迁移。回退移除 workflow 主脚本、内置浏览器适配器和测试脚本及对应 package 命令即可；保留测试工程和已有资产，不删除用户数据。没有新增生产服务、守护进程、安装器或凭据托管。

## 验证记录

- 回归：GLB 当前场景/实例统计、无效输入、重复视角、缺回贴图层、对象不匹配、生成失败与投影失败。
- 真实结果、工程 ID 和限制以本次 `report.json` 为准；运行中或失败不能计为通过。

### 2026-09-22 本机真实结果

- 环境：`http://127.0.0.1:4517/`，Codex 内置浏览器；默认 GPT-Image 2.5 Sunburst / 高质量 / 2K / 预设 1 九视角，未调整生产参数。
- 工程：`project-4794cd59-8284-43bb-8297-9c19cf62577f`，验收读取 Revision 37。
- 导入/减面：原始 1,857,094 面 → 保存 GLB 实测 200,000 面。参考图 `Bicycle` 按 `multi-view` 保存且选中。
- 生成：13 次尝试（含生产流程自带重试），8/9 视角已回贴；前视角连续两次轮廓对齐 QA 失败。没有额外重提整批，也没有跳过 QA。
- 重开：8 张图层图片均可解码，7 张 2048×2048、1 张 2047×2047（读取现有产物的原始尺寸，脚本未缩放）。模型和材质恢复标记均 ready，截图已人工查看。
- **整体验收 failed**，不能宣称九视角完整通过。前视角返图质量需单独排查；本变更不修改投影或 QA 算法。
- 本地证据：`.codex-tmp/li3d-workflow-20260922/` 为最初导入/减面；`...-final/` 与 `...-observed/` 为实际生图期间的采集；`...-verified/` 为最终资产/重开验收。阶段时间包含工具调用间隔，最终验收重用模型及参考图，其短阶段耗时不是首次导入耗时。
- `pnpm test:workflow`、三个脚本的 ESLint、Cloud boundary、Project repository boundary、Web typecheck 通过；未提交、推送或部署。
