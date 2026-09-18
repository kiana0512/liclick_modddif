# CHG-20260918 投影橡皮实时快速显示恢复

## 范围与版本

- 主模块：M08；协作模块：M06、M07；界面：UI-06、UI-10。
- 算法：`ALG-ERASE-001` 调度修订 v1.5.3。
- 显示缓冲：`UV-DISPLAY-BUFFER` v1.4.1。
- 持久化 `ERASER_ALGORITHM_VERSION=1` 不变。

## 根因

`251700e9` 已实现完整分辨率 GPU keep-mask 增量盖章，`40359ed3` 又补齐首笔预热；但 `352cd3e8` 的 UV-only 改造随后把 `canUseExactProjectedEraserStack` 固定为 `false`，并清空视口投影材质输入。`ViewportCanvas` 仍在拖动中更新 GPU 蒙版，生产 `SceneRoot` 却只显示上一张 verified Resident UV，用户只能在抬笔后的全图派生与上传完成时看到结果。旧隔离浏览器脚本没有进入正式 CI，而结构测试反而固定了该 UV-only 行为。

## 修改

- 正常与空闲帧继续只显示最后一张 verified Resident UV；不会恢复长期 direct/texture-array 投影显示。
- 只有经过橡皮目标策略确认的普通 projected-mask 层会发布 `displayArmed`；`SceneRoot` 还会核对所属模型，提交交接期间继续保留同一 exact projected stack。
- 快速路径仅使用已有 direct stack，并同时检查 sampler 与 fragment uniform；预算不安全时 fail-closed 保留 Resident UV，不启用更重的 texture-array 分支，也不显示近似结果。
- 中性 GPU keep-mask 可提前准备，但新增 renderer-only `displayArmed` 状态；预热本身不切换视口，选择橡皮后才发布快速显示，提交/材质驻留交接完成后清除。
- 拖动期只消费既有完整分辨率 GPU mask；抬笔后的 CPU/Worker 质量传播、接缝、gutter、正式 keep-mask、Resident UV 原子发布与导出仍走原流程。

## 对称链路与风险

- GPU/shader：恢复已存在的 live keep-mask uniform 与 exact direct 材质栈，不修改覆盖公式、深度、法线、图层顺序、V 轴或颜色混合。
- CPU/Worker：交互帧不新增 readback、全图合成或整图上传；正式提交与细化不变。
- persistence/export：`displayArmed` 只在浏览器运行时注册表中存在，不进入 Layer/Project Schema、Command、Revision、CAS、ownership 或 verified assets。已保存蒙版与历史资产无需迁移。
- 预算不安全、WebGL 不支持或材质数组熔断时保持原 verified UV；不降低 1K/2K/4K/8K 分辨率，不跳过 QA。

## 验证与回滚

专项门禁必须覆盖：空闲 UV-only、显式橡皮临时 exact stack、跨对象隔离、预热不夺取显示、direct/预算失败真值表、pointer-down 前实时像素变化、抬笔一致性、撤销/重做、切层及提交交接。发布前运行完整 Web/Server、类型、lint、Release 构建、包体和 Cloud 部署模拟。

回滚时移除 `displayArmed` 与 exact eraser gate，恢复固定 UV-only；不得删除已保存 keep-mask、工程 revision、历史或对象存储资产。
