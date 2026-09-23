# Resident UV 会话贡献质量 R8 归档

- 日期：2026-09-20
- 主模块：M07
- 协作模块：M06 / M09 / M15
- 算法：`UV-CONTRIBUTION-ARCHIVE` v1.1.0

## 问题与边界

Resident UV 的逐层 contribution 在显存预算不足时进入会话级 IndexedDB archive。颜色本来是 RGBA，每像素 4 字节；质量在 GPU 和常驻缓存中本来是 R8，每像素 1 字节，但旧 archive 为便于统一读回又将质量展开为 RGBA，导致读回、deflate、解压和恢复上传都处理每像素 8 字节。

该 archive 只属于当前页面的随机 owner，退出时清理；不是 Project 资产、Cloud verified asset 或导出内容。

## 修改

- WebGL 异步读回只接受 RGBA target，因此 copy shader 将同一行连续四个 R8 quality 打包到一个 RGBA texel；读回仍为每个源像素 1 字节，奇数宽度逐行去除尾部 padding。
- 新记录保存 `qualityChannels: 1`，原始负载由每像素 8 字节降为 5 字节。
- 恢复仍兼容缺少该字段的旧 RGBA quality 记录；新 R8 texture 继续由现有 shader 的 `qualityIsRed` 分支读取同一个 0–255 值。
- 颜色 RGBA、瓦片地址、Top-K、QA、alpha、分辨率和投影公式不变。

## GPU / CPU / Worker / shader / 持久化 / 导出审计

- GPU：quality copy target 宽度缩为 `ceil(width/4)`，每个 texel 精确携带四个质量字节；恢复 texture 为 R8，完整源分辨率不变；WebGL 状态仍由 `withUvRenderTarget` 恢复。
- CPU / Worker：deflate 输入减少冗余的三个相同 quality 通道，不改变数值或排序；无 Worker 协议变化。
- Shader：archive copy 写入 R8 的 red，Resident shader 已按 texture format 选择 red/alpha，公式不变。
- 持久化：只改随机 owner 的会话派生记录。旧记录兼容读取，无 Project Schema、Command、Revision CAS、ownership 或历史资产迁移。
- 导出：PNG、FBX、显式 Merge 和生产服务均不读取此会话 archive，行为不变。

## 验证与回滚

- Node 回归覆盖 R8/RGBA、奇数宽度、翻转、1 MiB 分条与取消释放。
- WebGL contribution 夹具须覆盖 65/128/257/512/4096、显隐/重排和 archive restore，并逐字节比较原始与恢复合成结果。
- 内置浏览器实测上述五档全部 `differences=0`，4K 四层的三组显隐/重排及 archive restore 通过，控制台无错误；4K 原始贡献 335,544,320 bytes、无损瓦片贡献 89,276,416 bytes。单次测试时序只作为正确性证据，不承诺所有设备固定耗时。
- 回滚时恢复 RGBA quality target、双 RGBA payload 与上传；新 owner 不引用前一页面的随机记录，无数据迁移或作者资产删除。
