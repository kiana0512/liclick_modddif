# 局部重绘蒙版可靠读取

- 日期：2026-09-16
- 主模块：M08
- 协作模块：M12 / UI-05
- 算法：`LOCAL-REPAINT-ASSET-READ/1.0.0`

## 问题

局部重绘 GPU 准备仅通过 `Image` 直读原图和蒙版。受保护的工程资产在凭证、签名地址或缓存短暂失配时会直接进入失败状态，而后台预热的失败也会显示为红色主动操作错误。

## 变更

- 保留 `Image` 直读快速路径和六项 LRU；直读失败时，仅 `/workspace`、工程 asset content 和工程相对 assets 资源改用 `readWorkspaceAssetBlob`。
- 回退资源必须非空且为图像 MIME；解码完成前不发布，随后释放临时 Blob URL。
- 失败 Promise 仍从缓存删除，下次主动进入可重试。
- `activationRequested=false` 的机会式后台预热失败不弹红色 Toast；主动按钮 3 请求的全路径失败仍以原 dedupe key 显示一次。

## 不变项与审计

- 读取的原字节、尺寸、alpha 和完整分辨率不变。
- GPU 材质、CPU/Worker/shader、画笔、UV/投影、发布与导出算法不变。
- 既有资源权限不放宽；同源工程资产仍由资源服务验证登录和 ownership。
- Project Command 幂等、Revision CAS、verified assets、Schema 和持久化/导出不变，无数据迁移。

## 验证

- 并发请求共用一次读取/解码，`onload` 早于 `decode` 时不会提前发布。
- 受保护蒙版直读失败后，已登录资源通道只读一次，解码结果复用且 Blob URL 回收。
- 失败不污染缓存；六项 LRU 上限保持。
- 静态事件门禁回归确认后台失败在 Toast 前返回，主动请求继续显示错误。

## 回滚

恢复 `loadImageElement` 的单一 `Image` 直读路径，并删除后台/主动提示分级。既有资产和工程数据无需迁移。
