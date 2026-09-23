# CHG-20260918 橡皮交互禁用 Resident UV

## 范围与版本

- 主模块：M08；协作模块：M06、M07；界面：UI-06、UI-10。
- `ALG-ERASE-001` 调度修订 v1.5.4。
- `UV-DISPLAY-BUFFER` v1.5.2。
- 持久化 `ERASER_ALGORITHM_VERSION=1` 不变。

## 根因

投影橡皮已经用 GPU live keep-mask 实时显示，但 `ResidentProjectedUvDisplay` 仍会消费同一手势的每个 `EraserUvDraft.revision`，执行全分辨率 flush、snapshot、增量 bake、readback 与上传。单层时开销不明显；多个 UV/投影层可见时，这些后台工作与实时 mask 争用主线程和 GPU，使画笔看起来重新进入慢路径。

## 修改

- 同对象、同层的 projected-mask 快速显示已 `displayArmed` 时，Resident UV 在读取 draft 后立即返回，不执行 flush、snapshot、bake、readback 或纹理上传。
- 非交互的最终 Resident UV 收敛若运行期间出现新的已武装笔迹，会在既有取消检查点中止；不会让旧签名继续占用资源。
- 抬笔提交完成、draft 被释放且视口空闲后，仍按最终 LayerStore 签名执行一次 verified Resident UV 收敛。它不参与笔迹显示，也不阻塞下一笔。
- 普通 UV 浏览、眼睛切换、导出、捕获与未武装回退仍使用原 Resident UV 流程。

## 对称审计

- GPU/shader：交互帧只更新现有完整分辨率 keep-mask；覆盖公式、深度、法线、图层顺序、颜色空间和采样精度不变。
- CPU/Worker：跳过的是可丢弃的交互 draft 派生；最终 CPU/Worker 质量链、接缝、gutter 和完整分辨率保持。
- persistence/export：draft 与 `displayArmed` 都是 renderer-only；正式 mask、Project Command、Revision CAS、ownership、verified assets、历史和导出字节不变。
- 失败边界：GPU exact stack 预算不安全时仍 fail-closed 到上一 verified UV；不降低分辨率、不跳过 QA。

## 验证与回滚

门禁覆盖：同对象/同层/已武装三重条件、Resident draft 在 flush 前退出、最终收敛被新笔迹取消、抬笔后最终签名可继续、单层与多层快速路径、撤销/重做和提交交接。发布前运行完整 Web/Server、类型、lint、生产构建、包体与 Cloud 门禁。

回滚时移除 Resident UV 的 armed-draft 早退及最终收敛取消条件；不得删除正式 keep-mask、历史、Revision 或对象存储资产。
