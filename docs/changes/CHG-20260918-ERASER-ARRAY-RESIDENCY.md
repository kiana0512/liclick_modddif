# CHG-20260918 多层橡皮一次驻留快速切层

## 1. 范围与版本

- 主模块：M08；协作：M06、M07、UI-06、UI-10。
- 算法：`ALG-ERASE-001` v1.5.6、`UV-DISPLAY-BUFFER` v1.5.4。
- 只修复普通 projected-mask 橡皮在多可见投影层之间首次使用和切层时的阻塞；不改局部重绘蒙版、原生 UV 像素编辑或生产 Bake 服务。

## 2. 根因

1. 橡皮激活会把全白的中性持久 mask 临时塞进作者投影层。多层超过 direct sampler 预算时，这个只应由独立 live sampler 处理的状态变化会改变 texture-array 结构，迫使颜色、mask、depth 全部重新打包和上传；正式 mask URL 变化也会重复触发同一问题。
2. texture-array 材质转移到模型后清空了构建槽，但没有保留“同结构已经 GPU-ready”的身份。下一次选层把正常转移误认成未驻留，又重复构建。
3. live Canvas 像素 revision 被错误加入数组结构签名。橡皮每次写 mask 都会让整组作者数组失效，而实时显示本来已经由独立的完整分辨率 multiplier sampler 完成。
4. 未落笔的中性预览结束时沿用真实提交交接逻辑，等待一个不会产生的材质驻留事件，导致新层准备仍被旧层占用。
5. speculative neutral prewarm 与正式橡皮激活同时发布 `displayArmed=false/true`，切层窗口会短暂撤下已驻留数组并重启慢路径。

## 3. 实现与无死角对照

- GPU/material：工程进入完整恢复态后，在 WebGL2 且 uniform 预算安全时一次性后台构建多层作者 texture-array；用独立 ready signature 跨材质转移保留驻留身份。所有投影层各占一个唯一的中性 keep-mask slice，后续提交通过 `copyTexSubImage3D` 只更新目标 slice，不重建其他颜色/mask/depth 层。
- Shader：覆盖公式不变。绘制期间 live keep-mask 仍以独立完整分辨率 sampler 叠乘作者 mask；提交/切层时由小型 GPU pass 将旧 slice 与 multiplier 相乘并原位写回。撤销/重做以正式 paint canvas 替换 slice。中性 mask、正式 mask URL 和 live Canvas revision 都不再改变作者数组结构。
- 交互：真实 pointer-down 才标记预览 dirty。没有真实笔迹的旧层同步解除 live sampler 和交接状态，选中层立即接管；活动橡皮不再运行会撤下显示所有权的 speculative neutral prewarm。
- CPU/Worker：正式提交仍执行现有完整分辨率 mask、Top-K、接缝和 gutter 细化；没有删除或降级质量步骤。
- Resident UV：橡皮激活、拖动和逐层切换不触发 draft/final Resident UV 合成；空闲最终收敛保持原契约。
- 持久化/历史/export：只有真实笔画才发布 LayerStore mask 并进入历史、撤销/重做、Project Command/Revision CAS 和导出链；GPU slice 只是显示驻留缓存，中性激活不落盘。ownership 和 verified object asset 规则不变。
- 失败边界：非 WebGL2、uniform/sampler 预算不足或数组构建失败继续 fail-closed，保留上一 verified front，不用实验内核替代生产结果。

## 4. 验证

- 静态契约：`test:projection-layers` 覆盖 live multiplier 不进入作者数组、live revision 不改变数组结构、WebGL2 多视图提前驻留、ready signature 跨转移保留及中性预览同步释放。
- 性能安全：`test:projection-performance-safety` 通过。
- 类型：Web TypeScript typecheck 通过。
- 4517 真实项目、六个可见 4K 投影层：修复前复现每次 mask URL/选层会再次构建作者数组并出现约 2–5 秒无响应；修复后作者数组只在工程恢复时后台驻留一次，后续所有测试中背景材质 revision 固定为 2。
- 首轮六层真实短划：158–597ms；随后两轮每层执行一次首点和一次短划，12 次首点为 18–217ms、12 次短划为 159–353ms。所有数值包含内置浏览器动作调度、DOM/AX 采样，不等同于 shader 帧耗时；每次首点都在下一次采样前可见。
- 连续切层压力：3 轮 × 6 层共 18 次真实选层、30 次落笔，`activeLayerId === preparedLayerId` 全部成立；texture-array 始终 `ready`，Resident UV revision 始终为 1。
- 历史：连续 4 次 Undo + 4 次 Redo 为 310–411ms，均使用目标 array slice 原位替换；array 保持 `ready`、材质 revision 不变、Resident revision 不变。
- 清理：压力测试后使用当前 revision CAS 的 `replace-project-document` Project Command 将六层 mask URL/content revision 恢复到测试前 revision 3700 的资产，并重新加载 4517 目视确认没有遗留压力测试笔迹。

## 5. 迁移、风险与回滚

- 无 Project/Layer Schema、资产、分辨率、QA 或历史数据迁移。
- 主要风险是提前驻留和每层预留 mask slice 增加工程恢复后的短时后台 GPU 上传及一组 RGBA8 mask-array 显存；它受 WebGL2、uniform/sampler 和已有内存预算门禁约束，不阻塞首屏 verified front。
- 回滚可恢复按工具激活构建数组、把 resident mask 注入作者层，删除预留 slice、GPU 原位 promotion 和 ready signature；这会重新引入逐层 2–5 秒预热，但不会要求迁移数据。
