# 工程保存去除重复内联生成图片

- 主模块 M12，协作 M01/M14；GENERATION-ASSET-REFERENCE/1.0.0。
- 根因：成功生成的 resultUrl 与 metadata.resultUrls 可重复保存同一 Base64。实际工程约 59 MB，浏览器长帧定位指向 Response.json.then，单次约 982 ms，影响显隐交互。
- 修复：共同保存入口在 JSON 序列化与 Project Command/CAS 前，将内联生成图作为原 Blob 上传到所属工程的 verified 资产，再不可变替换重复地址。原 MIME/字节保持，不进行图片解码、重编码或缩放。同快照地址去重，跨快照仅缓存最多 128 个工程隔离的 SHA-256 小键与上传 Promise，失败删除缓存；临时地址、空结果或上传失败禁止提交。
- 实测：十视图回贴后实际工程约 3.8 MB，441 条生成记录的主 resultUrl 无 data URI，十视图成功与实际图层提交记录保留。当前活动 store 可以暂留原图片，刷新后读取精简工程，不宣称已消除其他图像解码及冷 UV 派生开销。
- 验证：1 MiB 原始 Blob 逐字节对照、重复字段一次上传、JSON 从超过 2 MB 到小于 2 KB、不可变输入、同工程复用、跨工程隔离、失败后重试和临时地址拒绝通过；原 live 图层冻结/作者蒙版/保存失败事务测试保持。
- 审计：Project Command 幂等、Revision CAS、ownership、verified object asset 通道均保持。GPU/CPU/Worker/shader、原图片分辨率/QA、投影/UV、mask/depth、导出和历史语义不改；没有新增 React/store 算法。
- 迁移/回滚：下一次成功保存渐进替换内联地址；上传失败保留原工程。现有 Schema 接受资产 URL，无 Schema 字段迁移。回滚保存归一化仍可读取已保存资产，不删除资产、不改变所属工程或恢复本地凭据托管。
