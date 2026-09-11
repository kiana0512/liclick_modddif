# UV 光栅缓存身份与生命周期保护

主模块 M07，`UV-RASTER-CACHE-IDENTITY/2`。性能优化的验收底线为结果正确、稳定。

## 根因及修复

外层合成已识别部分属性更换，但 GPU 光栅作用域只比较属性 count/version；相同数量、version=0 的新 UV 缓冲可复用旧最终结果。两层签名现在共用属性、底层数据及数组身份，包含 count/itemSize/normalized、交错 offset/stride、上传 version；GPU 作用域补齐 drawRange。原地修改仍按 Three 的上传版本约定设置 needsUpdate。

缓存的 bounded copy 会异步让出；context loss 前后的 scope 字符串可能相同。clear 现在递增独立生命周期 revision，在读取/保留完成时复核，丢弃失效阶段的输出，禁止旧结果复活。

## 对应路径及验证

- GPU shader、Top-K、CPU 精度修正和 Worker 像素协议不变；本次只修复是否允许复用。
- 发布、PNG/FBX、持久化 verified assets、Command/CAS/ownership 不变，无 Project Schema 或资产迁移；缓存是页内派生物，不提高容量、不禁用 QA。
- 单测：属性/数组替换、交错布局和上传版本、context loss 打断读取及保留、已有缓存所有权/容量/来源签名。
- 内置 WebGL 冻结 42b9699 对照：更换同 count/version 的镜像 UV 后，与重新计算相比，旧核 524288 字节错误，新核零差异；确认输入确实改变了颜色，避免空白夹具假通过。
- TypeScript、相关缓存/合并合同通过。之前完成的 122 项全量回归、R8 六组像素对照、画笔 GPU/CPU/共享 UV/撤销验证仍保留；最终提交另跑正式推送门禁。

## 今日收尾与未完成项

已完成并验证：原生 UV 重绘漏合并修复；跨瓦片画笔一次光栅化；R8 权重缩小缓存；本次缓存正确性保护。画笔/合并 f22c353 已推送并由用户确认本地测试可用。

未宣称完成：首次投影到 UV、未命中组合的最终显示、F5 恢复仍需继续减少整体等待。R8 目前证明容量和命中增加，未证明显著端到端加速。后续应分别测量源准备、光栅化、Top-K、精度修正、读回/上传以及实际新 UV 呈现；不能用缓存命中或按钮眼睛变化代替正确画面落地。早先 14 投影层基线曾记录 Three compileAsync 的 isReady 异常，尚未定位完整调用链，不归为本次已修复项。

回滚本提交恢复旧页内签名/生命周期守卫即可，无资产回写或迁移；已保存图层不受影响。发布要求最终 HEAD 通过 `pnpm verify:prepush` 的实际 CI 环境包体预算，阈值保持不变。
