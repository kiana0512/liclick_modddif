# CHG-20260910-UV-MERGE-EMPTY-FALLBACK

候选，本机验收；主模块 M06，协作 M07/M08。UV-MERGE-EMPTY-FALLBACK v1.0.0。

## 问题与变更

真实 20 投影/4K Merge 达到 365.2ms 原子切换后，前部完全未覆盖区域由投影模式深灰斜线变为白模。快路径 PNG 与此前未命中缓存的 PNG 为相同 SHA-256（03af570851db75c6c82757b85f8b42c84a2744ab7fa5938aa0bba96a79aecbce），不是缓存丢失颜色。UV-only 显示在有 sparse repair base 时设置 showEmptyUvChecker=false，以免遮挡有效底图；旧 fragment 对两张图都缺失的像素也回退 baseColor。

仅在普通斜线显示模式、checker 已关闭、存在颜色图且 combined capturedCoverage 精确等于零时，恢复现有 computeUvEmptyPreviewColor。保留所有非零覆盖像素、有效修补、source alpha、原深度和灯光结果；不把缺失覆盖伪装为已修补颜色。不新增 GPU pass、采样或读回。

## 对称路径与验证

GPU/GLSL：仅 UV-only viewport 未覆盖背景分支。CPU、Worker、UV 烘焙和持久缓存 PNG 不变；捕获 mode=0/2 明确不进入该分支，因此生成输入颜色/coverage alpha 与 export 不变。Project Command 幂等、Revision CAS、ownership 和 verified assets 无变化。

真实 WebGL 96 组 base/overlay alpha=0/1/127/255、checker 开关、显示/flat capture/coverage capture 对照冻结旧 shader：完整未覆盖普通显示恢复深灰诊断，其他每个 RGBA 字节相同。TypeScript/ESLint 通过。真实模型显示需使用新构建复核。

最终构建在原割草机器人工程复核通过：20 投影/4096，原前部及顶部白块恢复原未覆盖斜线显示，最终 PNG cache hit；点击到原子切换 366.4ms，其中 GPU 预热 310.7ms。检查后已通过 UI 撤销测速合并，保留原图层供用户测试。浏览器无运行错误，工程文件与历史资产未手工改写。

## 迁移和回滚

无 Schema、作者像素或缓存键变化，无资产迁移；回滚新增 fragment 分支即可。未提交、推送或部署 Cloud。
