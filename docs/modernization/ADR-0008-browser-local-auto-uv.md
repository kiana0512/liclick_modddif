# ADR-0008：浏览器本地 Auto UV

状态：已接受，首个真实纵向切片已接入；完整生产模型矩阵仍在进行中。

## 问题

原 Auto UV 页面把模型提交给远端 Worker。这既违背 Cloud 零安装且使用用户本机算力的目标，也让 UV、项目保存和 Bake 交接跨越两套不一致的任务协议。

## 决策

- Auto UV 使用浏览器 Worker 中的 `watlas`/xatlas WebAssembly 内核；模型字节不发送给计算服务器。
- FBX、OBJ、GLB、GLTF 由浏览器解析。当前明确拒绝骨骼、Morph、交错属性、非三角面和超过 200 万三角面的输入，不做静默降级。
- xatlas 为全部网格生成同一个图集；新索引、顶点映射和 UV0 被写回几何体，再由浏览器导出 GLB。
- Worker 登记到项目 Engine Session 的 CPU lane；同 key 重跑会取消旧任务，独立页面也持有 AbortController，切页或点击取消会终止 Worker。
- 生成结果先在内存中预览和下载。用户选择继续后，源模型和 UV GLB 通过签名 URL 直接写对象存储，项目写入 `browser-local` UV Revision。
- 独立 UV 入口会建立可恢复的高模根和 Bake Set。进入 Bake 后，高模与本地 UV 低模必须显示为 `2/2`，不能只完成路由跳转。
- Cloud 首页只把 Auto UV 标成“本机运行”；PBR Bake 和拓扑在各自本地实现通过前仍保持未通过状态。
- `watlas` 固定为 1.0.1；其 MIT 声明随 Web/Cloud 产物发布于 `THIRD_PARTY_NOTICES.txt`，升级时必须重新审计许可证与 WASM 哈希。

## 当前实测证据

远端部署模拟器中的真实浏览器流程已经完成：

1. 载入无 UV 的 OBJ 四边形 fixture；
2. Worker 下载并执行 xatlas WASM，生成 1 个 chart、1 个 atlas、UV 利用率 1；
3. 浏览器导出 GLB，UV 预览解析为 1/1 网格、2 个三角面；
4. 开发身份登录后，源 OBJ 与输出 GLB 经对象存储直传并完成 SHA-256 校验；
5. 创建项目、保存 texture/UV 两个 Revision，进入 Bake；
6. Bake 显示高模 `local-uv-e2e.obj` 与低模 `local-uv-e2e_local_uv.glb` 均已导入，素材状态为 `2/2`。

可重复的内核测试为 `pnpm --filter @liclick/web test:local-uv-atlas`；模拟部署为 `pnpm simulate:cloud-deployment -- --serve`，浏览器诊断入口为 `/li3d/uv?perfLab=1`。

## 尚未宣称完成

- GLB/GLTF/FBX/OBJ 的真实生产资产矩阵、多个材质槽、法线/切线/颜色属性对照。
- 非流形、自相交、退化面、超大模型、低内存设备、取消中途和刷新恢复压力测试。
- 接缝质量、texel density、padding、翻转/重叠和与既有生产结果的量化门限。
- 骨骼、Morph、UDIM 和多 atlas 支持。

因此机器发布门禁中的 `uv.browser-local` 仍为 `in_progress`，不会因为四边形 E2E 通过就提前标记 `passed`。
