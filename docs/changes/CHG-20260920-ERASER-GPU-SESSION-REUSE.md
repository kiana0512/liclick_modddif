# CHG-20260920 橡皮擦 GPU 会话复用与数组调度

## 范围

- UI：UI-06 / UI-10 投影层橡皮擦。
- 主模块：M08；协作 M06 / M07 / M15。
- 算法：`ALG-ERASE-001` v1.5.7、`UV-DISPLAY-BUFFER` v1.5.5、`ALG-PROJ-007` v2.1.14。
- 状态：production，本地待提交/待 CI。

## 问题与根因

1. WebGL2 多层橡皮擦需要一次构建作者 texture-array。数据条带上传本身约 148ms，但 117 个条带每个都等待 `requestAnimationFrame`；hidden/throttled 情况每次命中 120ms 保险超时，把 pipeline 放大到 17.6s。
2. `UvPaintLayer` 切层时无条件 dispose `UvRepaint`。该引擎实际只依赖 renderer、模型网格和分辨率，并不依赖投影层内容；逐层重建会重复分配两张 4K render target、复制网格/分块表并编译同一组 shader。

## 实现与不变量

- texture-array 仍按最多 1,048,576 像素的有界条带上传。视口有活动输入时使用 paint-aligned yield；空闲时使用 browser-task yield，不让背景驻留依赖 rAF。GPU fence 仍保留呈现帧对齐。
- 只有在无活动 pointer、无待提交笔画、无 Resident 验证交接、无 backlog，且 objectId/分辨率一致时，才转移 `UvRepaint`。
- 转移前从旧 live URL 解绑，再销毁旧图层会话；转移后先 `resetWhite()`，再将同一 GPU texture 同步绑定到新层 URL。任一安全条件不成立时仍使用原销毁/重建路径。
- 完整 4K 输出、live keep-mask 采样、CPU/Worker 正式细化、历史瓦片、撤销/重做、QA、持久化和 export 字节均不改。
- 交互笔画仍只走 GPU live mask，Resident UV 不参与实时擦除；笔画提交后允许后台生成新 verified front buffer。

## 验证

- `pnpm --dir apps/web test:projection-performance-safety`
- `pnpm --dir apps/web test:projection-layers`
- `pnpm --dir apps/web test:resident-uv-display`
- `node apps/web/scripts/test-resident-uv-visibility-scheduling.mjs`
- Web TypeScript `tsc --noEmit`
- Server + Web production build，4517 重启成功。
- 内置浏览器、真实 4K/13 投影层：
  - texture-array pipeline：17,569.6ms → 2,074.8–2,262.0ms（约 -87%）；实际 upload 约 148ms 不变。
  - 空闲上传 117 次 task yield / 0 次 paint yield。
  - 26 次连续切层：26 次 reuse、0 次 prepare、0 超时，页内重绑检测 0–1ms，Resident revision 不变。
- 真实首笔生成可撤销记录；4K 提交 5.8ms，历史 1 tile / 131,072 snapshot pixels；测试笔迹已撤销。
- 已提交/撤销的旧层再切换：复用计数 +1、prepare 不增。
- Cloud 发布配置构建：`bakeHighSnapshot` 714,787 / 715,000 bytes，总 JavaScript 3,251,055 / 3,256,500 bytes；预算未放宽。
- Web lint 0 error / 0 warning。删除未使用的比例解析函数与局部变量；数组上传继续记录逐 profile 的结构化 GPU transfer 事件及总 pipeline 耗时，不再把相同分项重复复制到 DOM dataset；复用/重建计数是本次浏览器压测的临时探针，不进入发布运行时。

## 迁移、回滚与风险

- Project Schema、Project Command、Revision CAS、ownership 和 verified assets 无变更，无数据/资产迁移。
- 回滚可恢复每个上传条带的 `waitForBrowserPaint()` 以及逐图层 dispose/recreate `UvRepaint`；不需要重写历史 mask。
- 引擎不会跨模型或跨分辨率复用。当前安全门禁故意保守；若后续引入并行多 pointer 或多模型同时编辑，必须重新审核 GPU 所有权。
- 删除的仅为重复诊断镜像，不影响纹理、mask、上传条带、调度、错误处理或 QA；需要回滚诊断展示时可恢复 DOM 聚合字段，无资产迁移。
