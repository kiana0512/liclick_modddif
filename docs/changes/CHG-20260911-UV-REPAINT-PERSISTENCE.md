# CHG-20260911-UV-REPAINT-PERSISTENCE

## 范围与证据

主模块 M12，协作 M08/M05。用户已批准修复并同步 master/A100；发布须通过最终提交的正式门禁，不修改真实工程数据。

- A100 受影响工程最新 revision 1712 的 6 个原生 UV 重绘结果 imageUrl 均为 `liclick-live-projected-canvas:`；revision 1710 的前 5 层有正式资产地址，1711 再次变成临时地址。只读查询，未复制或修改工程内容。
- EditorPage 专用保存流程编码 live 像素，但 BakeWorkspacePage 的工程保存调用公共 saveProject，原先没有这一屏障；服务端 sanitizeVolatileLayerAssets 只保护 projected imageUrl，漏过 UV。切回贴图会重新读工程，刷新必然丢失内存注册表。
- LayersPanel 将 role=local-repaint-overlay 的 UV 结果误判为需要独立涂绘蒙版的旧投影层；原生 UV 的覆盖范围实际已在 RGBA alpha 中。

## 修复契约 RUNTIME-LAYER-ASSETS/1.0.0

1. 所有 saveProject / updateLatestProject 的公共写入路径在 Command/CAS 之前准备图层 live/blob 资产；等待未完成 UV 提交，冻结全部输入后上传，不改变调用者的图层或编辑纹理绑定。
2. 同一临时地址单次保存只编码/上传一次；正式地址不重复上传。上传串行有界，保留原始 PNG 大小/分辨率。读回、编码、上传失败或冻结期间 revision/source 改变时不提交文档，不回退到原始生图或旧笔画。
3. 服务端拒绝含临时 UV 图片的保存，包括已有历史正式地址的情况；不接受“成功保存”但丢弃新笔画的静默回退。Command 幂等、CAS、Session ownership、verified asset 校验保持。
4. 原生 UV ID 的预览走普通 RGBA 分支；旧 projected / 非原生 UV 重绘继续要求作者 mask，避免扩大历史覆盖范围。
5. GPU registry 向公共保存模块注册 CPU 资产读取接口，公共 API 不反向导入 Three.js，保留原来的首页/3D 按需加载边界。注册表测试通过 Vite SSR 加载实际生产依赖，不替换纹理行为。

## 全链审计

| 路径 | 处理 |
| --- | --- |
| GPU / shader | 不改画笔、深度、共享 UV、透明度、采样与裁切 |
| CPU | 等待已存在的脏瓦片提交；无额外补洞、变色或降采样 |
| Worker / 合并 / PNG / FBX | 继续消费同一 RGBA；不改像素公式与导出流程 |
| 持久化 | 公共入口增加临时资产屏障，服务端 UV 地址防线；不改变 Schema |
| UI | 原生 UV 不再套独立投影 mask，隐藏层持久化不被省略 |

## 验证

- 原生 UV 合约测试新增跨页保存等待、两层（含隐藏层）保留、冻结字节、失败阻断、失效内存、并发笔画、blob 去重及调用入口检查。
- 图层预览测试执行实际 TSX 函数，验证重开 UV 直接显示 RGBA 且不二次乘蒙版；旧重绘保护保持。
- 服务端工程测试新增新 UV 与已保存 UV 的 live/blob 写入拒绝，验证失败不推进 revision、不覆盖旧资产；既有 CAS/幂等回归保留。
- 隔离真实浏览器夹具验证释放 GPU -> 保存两个 PNG -> 完整刷新 -> 注册表清空 -> 两层像素/alpha 正确。只使用合成数据，不连接真实工程。
- 执行结果以本次交付说明为准；不能把合成夹具等同于用户原工程/A100 验收。

本地验证记录：Web 120 contracts、Server 15 contracts；新增真实 Edge 完整刷新夹具通过，原有真实 WebGL HiDPI（1/1.25/1.5/2）、多层共存、画笔/擦除/撤销、PNG/FBX 和 4K 可见性回归通过。TypeScript、Web 构建、服务端构建及 lint（0 error，14 条既有 warning）通过；Cloud boundary、repository boundary、cloud artifact 检查通过。带 Cloud/performance-lab 开关和本地验证元数据的构建为 93 chunks / 3,220,859 bytes，总预算 3,222,000 bytes，余量 1,141；shell 257,476、editor 480,659、bakeHighSnapshot 693,454、projectPipeline 828,957 bytes，均在预算内。此为未提交工作树验证，**不是最终提交的 verify:prepush 或远端 CI**；推送时仍必须针对最终提交执行正式门禁。

## 迁移、恢复与回滚

无 Schema 或像素资产批量迁移。已保存坏地址的工程不会因这次代码修复自动恢复；前 5 层的历史正式地址只提供恢复线索，尚须确认对象存储文件和笔画完整性，第 6 层未确认正式结果。禁止以 localRepaintSourceUrl 原始生图替代丢失的 UV 笔画；恢复另行授权并先备份。

回滚客户端和 UI 补丁时应保留服务端临时 UV 写入拒绝，旧客户端可能明确保存失败，但不能重新开放不可恢复地址覆盖。新写出的标准 RGBA 图片可由旧版读取；不删除既有资产或工程历史。
