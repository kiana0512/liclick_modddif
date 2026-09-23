# Resident UV 贡献索引两级归约

- 日期：2026-09-20
- 主模块：M06 / M07
- 协作模块：M09 / M15
- 算法：`UV-LAYER-CONTRIBUTION` v1.0.3

## 问题与边界

Resident UV 冷路径会为每个投影层生成可显隐恢复的无损贡献瓦片。旧实现用三次 4×4 GPU 归约形成 64×64 texel 的布尔占用索引；第三次归约带来额外 render target、GPU pass 与调度让步。该索引是会话级派生缓存，不是作者资产，也不参与 Project Command、Revision CAS 或导出格式。

本次不降低纹理分辨率，不关闭 QA，不改变投影、Top-K、质量或 gutter 像素公式，也不恢复本地组件或 loopback 生产依赖。

## 修改

- 每次归约逐 texel 检查固定 8×8 区域，执行两级，覆盖范围仍严格为 64×64。
- 边缘继续按源纹理实际尺寸裁剪；任一 alpha 大于 0 即占用，判定语义不变。
- packed RGBA、R8 quality、tile address、Worker/CPU 恢复和 archive 协议不变。
- 删除一个中间 GPU target、一次全屏归约 pass 和一次 `yieldToBrowserTask`。

## 验证

- Node 回归锁定 8×8、两级和 64×64 覆盖合同。
- WebGL 浏览器夹具覆盖 65/128/257/512/4096 分辨率、稀疏/边缘 texel、显隐/重排、archive restore，并逐字节比较原始贡献与瓦片恢复结果。
- 内置浏览器实际结果：所有组合 `differences=0`；4K 四层原始贡献 `335544320` bytes，无损瓦片贡献 `89276416` bytes，三组显隐/重排及 archive restore 均通过。
- 4517 真实 4K 工程使用最新生产包恢复为 `ready`，`completeBakeMs=0`；该热恢复按设计不进入本次冷路径归约。
- 正式发布包体门禁：High Bake `714301/715000`，总 JavaScript `3251983/3256500`，未提高预算。
- 正式 pre-push 必须通过 typecheck、148 项 Web 回归、26 项 Server 回归、lint、生产构建、Cloud artifact/deployment 和 256 B 包体余量门禁。

## 迁移与回滚

无 Schema、项目资产或数据迁移。旧贡献缓存只在当前浏览器会话内存在；刷新后自然重建。回滚时恢复 4×4 shader 循环和三层 `/4` 归约即可，持久项目与导出结果无需转换。
