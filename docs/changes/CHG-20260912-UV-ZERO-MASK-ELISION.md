# CHG-20260912-UV-ZERO-MASK-ELISION

## 范围与版本

- 主模块：M07 Projection / UV
- 协作模块：M06 Viewport、M09 Worker、M15 Build / CI
- 算法：`UV-DISPLAY-MASK-WORKER/1.3.0`

## 问题

普通 BaseColor 投影栈不会产生 rendered-color 贡献，但 Quality Blend Worker、Resident 聚合缓存和显示入口仍为每次 4K 结果创建、传输、复制并扫描 `4096²` 字节的全零蒙版。该数据不改变任何像素，却增加 16 MiB 瞬时内存、Worker → UI 传输和图层显隐后的主线程工作。

## 修改

- Worker 只有在本次 overlay 中至少一个图层使用 rendered-color 时才分配完整 R8 mask；普通栈返回长度为零的规范全零表示。
- WebGL Resident Quality 的普通聚合结果直接使用空 mask；缓存复制和预算计量自然省略冗余 16 MiB。
- CPU fallback 在收集完 overlay 后按同一 `usesUnlitRenderedColor` 权威判断决定是否分配 mask。
- Resident 显示将空 mask 绑定为既有 1×1、零值、`RedFormat` 中性纹理，不执行全图扫描或上传。
- 任一 rendered-color 图层存在时，仍为所有 overlay 保留完整 mask，确保后续普通 overlay 对已有 rendered-color coverage 的衰减公式逐字节不变。

## 不变项与跨路径审计

- GPU：颜色/质量光栅、Top-K、读回、R8 上传格式和纹理完整性不变；仅普通栈使用既有中性 mask。
- CPU / Worker：RGBA、coverage、alpha、层序与 overlay 公式不变；冻结参考对照继续逐字节验证。
- Shader：仍采样 mask 红通道；未改 shader token 或分支。
- 持久化 / 导出：mask 本就是可选派生数据；空数组等价于全零，不改 Layer/Project Schema、Command 幂等性、Revision CAS、ownership、verified assets 或导出像素。
- 不降低输出分辨率，不跳过接缝修补或 QA，不提高包体预算。

## 迁移与回滚

无项目、Schema、对象资产或持久缓存迁移。旧全零 mask 与新空 mask 的显示结果相同；已有 rendered-color mask 不重写。回滚时恢复 Worker/CPU/GPU 聚合的全尺寸零数组，并移除显示端空数组规范化即可，不删除用户图层或资产。
