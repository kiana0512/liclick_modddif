# CHG-20260903 局部重绘蒙版持久化边界修复

## 变更范围

- 界面：UI-06 图层、UI-10 贴图编辑。
- 模块：M01 项目持久化、M08 局部重绘、M14 资产/对象存储。
- 算法：`ALG-LR-008` `2.4.1 -> 2.4.2`。
- Schema：无变更。

## 根因与证据

A100 项目 Revision 中出现了 `liclick-live-projected-canvas://...`。该地址只在当前浏览器的 GPU/live texture 注册表内有效，刷新、换设备或注册源释放后无法被 `<img>` 解码，因此准备阶段报 `Could not load local repaint mask.`。相邻历史 Revision 保存的是对象存储 HTTP URL，证明生成和 GPU 投影本身成功，故障位于 live URL 到 durable asset 的持久化交接。

## 实现

1. Web 保存同时支持 live canvas 与 live image 注册源，按 source URL/revision 去重编码上传，并按项目资产槽保留已验证 URL。
2. live 注册源已释放时仅允许复用已经成功上传的同槽资产；没有 durable 映射则让当前保存失败并由队列重试，不能回退保存 runtime URL。
3. Server 把 `blob:` 与 `liclick-live-projected-canvas:` 统一视为 volatile。已有图层保留上一 Revision 的 durable mask/source；新图层没有 durable 前身时返回 `PROJECT_SAVE_CONFLICT`。

## 全链路审计

- GPU/CPU/Worker/shader：像素、coverage、颜色、深度与 surface-lock 公式不变。
- 投影与 UV/export：继续读取相同 PNG 资产；只改变保存前地址物化，不改变采样与最终分辨率。
- Project Command/Revision：继续使用原 CAS 与串行保存队列；拒绝坏快照不会创建 Revision。
- ownership/资产：沿用当前用户、当前项目和既有 `layers` verified asset 类别，无跨用户读取或写入。

## 迁移与回滚

无 Schema 或批量数据库迁移。已经写入 runtime URL 的历史 Revision原样保留审计；当前项目可从同项目、同图层最近一个 durable Revision 复制对应 URL，并通过正常 CAS 创建新的恢复 Revision。回滚应用代码时仍必须保留服务端 volatile URL 拒绝门禁，不得重新允许 runtime URL 入库。

## 验证

- Web `test:local-repaint-inward-crossfade` 覆盖 live source 存在、上传映射保留与禁止 runtime fallback。
- Server `test:pipeline-persistence` 覆盖晚到 runtime 快照保留已有 durable mask，以及没有 durable 前身时 fail-closed。
- Web/Server TypeScript typecheck、生产构建与云端边界检查必须通过。
