# 返图后 UV 缓存键大字符串开销优化

主模块 M07，协作 M06/M03/M08/M09；UV-RASTER-LAYER-KEY/1.0.0。

## 实现与约束

原 GPU UV 入口每次对每层完整 JSON.stringify，包括返回图的多 MiB Base64 URL，显隐和新增图层都会重新复制这些字节。仅在已有 ProjectedUvRasterCache 中对 *Url 字符串分配 owner 私有身份编号，再序列化其他参数。Map 按完整字符串比较，不以散列碰撞代替内容一致性；原 Layer 和图片从未被编号替换。无缓存的显式路径保持旧完整键。

编号不复用、不跨 owner/进程持久化；源身份表保留最多 2048 字符串和 64MiB UTF-16 文本。达到容量后保留原字符串，不淘汰已分配身份，避免显隐后错误命中或反复重投影。GPU scope/context loss 仍清空所有 target、aggregate、program 和 archive，源身份表仅是同 owner 的不可变字符串索引；dispose 释放所有引用并禁止新键。所有可影响像素的原字段仍序列化，只有原来就忽略的 name/order/visible 继续忽略。源权限/实际读取验证、几何 revision 与 live canvas 禁止缓存的门禁不变。

CPU 只减少派生键字符串复制。逐张投影转 UV、Top-K 权重、alpha/质量、GPU/Worker/shader 内核、回读及取消/所有权保持；没有切换为投影合成再转 UV。纯 UV 显示、完整分辨率和 QA 保持。持久缓存的来源字节校验、Project Command/CAS/ownership/verified assets、持久化及显式导出不改。

## 验证

- 真实类方法测试来源相等、全部 URL 变化、相机/权重/调整/alpha/revision/对象变化、令牌形状输入、undefined/null、scope、容量回退、释放与无输入变更；原 Resident UV 舍入、取消、几何、显隐/发布和一字节 mask 回归通过，类型及局部 lint 通过。
- Node 14×2MiB 字符串单步测量：完整键约 21.5–24.7ms，身份键冷态约 11.9–13.7ms、热态约 6.8–7.2ms。不是浏览器整个返图或用户项目帧率结论，URL 容量回退保留原开销。
- 内置浏览器 2K/7 层，旧核/新核交替运行共 20 次新增/中间层显隐/恢复：最终 RGBA、coverage SHA-256 和覆盖计数完全一致；新增第七层复用六层 aggregate，改中间层不误用 aggregate，0 shader/runtime error。普通 Blob URL 场景的新组合仍约 0.2 秒，本改动不宣称消除 GPU 合成/回读瓶颈。

## 迁移和回滚

改变的只有 owner 私有会话键；archive 仍由同 owner 随机命名空间管理，退出清理，不是 Cloud verified assets，也不写入 Project。无 Schema/数据库/资产/历史任务迁移。回滚 layerKey 方法与调用恢复完整字符串键并重新计算派生 UV，不删除作者 mask 或成功结果，不回滚此前上传与局部重绘修复。
